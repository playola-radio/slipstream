import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog, type LoggedRecord } from './log.ts';
import { createEngine } from './engine.ts';
import type { Reader } from './reader.ts';
import type { Snapshot } from './snapshot.ts';

async function withEngine(
  reader: Reader,
  fn: (ctx: { engine: ReturnType<typeof createEngine>; records: () => Promise<LoggedRecord[]> }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'slip-eng-'));
  const logPath = join(dir, 'events.jsonl');
  const log = await createLog(logPath);
  try {
    const engine = createEngine({ reader, log });
    await fn({
      engine,
      records: async () => {
        const text = await readFile(logPath, 'utf8').catch(() => '');
        return text
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as LoggedRecord);
      },
    });
  } finally {
    await log.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Returns queued snapshots in order, one per read() call. */
function scriptedReader(snapshots: Snapshot[]): Reader {
  const queue = [...snapshots];
  return {
    read: async () => queue.shift() ?? { kind: 'absent' },
  };
}

const content = (sha: string, size = 1): Snapshot => ({ kind: 'content', sha256: sha, size });

test('a change from the baseline emits one file.changed with correct before/after', async () => {
  await withEngine(scriptedReader([content('bbb')]), async ({ engine, records }) => {
    engine.setBaseline('f.ts', content('aaa'));
    engine.notify('f.ts', 100);
    await engine.drain();
    const recs = await records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.type, 'file.changed');
    if (recs[0]?.type === 'file.changed') {
      assert.deepEqual(recs[0].before, content('aaa'));
      assert.deepEqual(recs[0].after, content('bbb'));
      assert.equal(recs[0].observed_at_ms, 100);
    }
  });
});

test('an observation identical to the committed state emits nothing', async () => {
  await withEngine(scriptedReader([content('aaa')]), async ({ engine, records }) => {
    engine.setBaseline('f.ts', content('aaa'));
    engine.notify('f.ts', 1);
    await engine.drain();
    assert.equal((await records()).length, 0);
  });
});

test('A -> B -> A produces two transitions, not one deduplicated pair', async () => {
  await withEngine(scriptedReader([content('bbb'), content('aaa')]), async ({ engine, records }) => {
    engine.setBaseline('f.ts', content('aaa'));
    engine.notify('f.ts', 1);
    await engine.drain();
    engine.notify('f.ts', 2);
    await engine.drain();
    const recs = await records();
    assert.equal(recs.length, 2);
    if (recs[0]?.type === 'file.changed' && recs[1]?.type === 'file.changed') {
      assert.deepEqual([recs[0].before, recs[0].after], [content('aaa'), content('bbb')]);
      assert.deepEqual([recs[1].before, recs[1].after], [content('bbb'), content('aaa')]);
    }
  });
});

test('a deletion is content -> absent', async () => {
  await withEngine(scriptedReader([{ kind: 'absent' }]), async ({ engine, records }) => {
    engine.setBaseline('f.ts', content('aaa'));
    engine.notify('f.ts', 1);
    await engine.drain();
    const recs = await records();
    if (recs[0]?.type === 'file.changed') {
      assert.deepEqual(recs[0].before, content('aaa'));
      assert.deepEqual(recs[0].after, { kind: 'absent' });
    }
  });
});

test('a creation is absent -> content when the path has no baseline', async () => {
  await withEngine(scriptedReader([content('new')]), async ({ engine, records }) => {
    engine.notify('created.ts', 1);
    await engine.drain();
    const recs = await records();
    if (recs[0]?.type === 'file.changed') {
      assert.deepEqual(recs[0].before, { kind: 'absent' });
      assert.deepEqual(recs[0].after, content('new'));
    }
  });
});

test('notifies arriving mid-read coalesce, and the next cycle compares against the just-committed state', async () => {
  // Gate the first read so a second notify lands while the path is processing.
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => (releaseFirst = r));
  const reads: Snapshot[] = [content('bbb'), content('bbb')];
  let call = 0;
  const reader: Reader = {
    read: async () => {
      const idx = call++;
      if (idx === 0) await firstGate;
      return reads[idx] ?? { kind: 'absent' };
    },
  };

  await withEngine(reader, async ({ engine, records }) => {
    engine.setBaseline('f.ts', content('aaa'));
    engine.notify('f.ts', 1); // starts processing, blocks on gate
    await Promise.resolve();
    engine.notify('f.ts', 2); // arrives while processing -> coalesced
    releaseFirst();
    await engine.drain();

    const recs = await records();
    // Cycle 1 commits aaa -> bbb (comparing against the committed baseline, not
    // disk). The notify that landed during cycle 1's read is folded into cycle 2,
    // which re-reads, finds bbb unchanged, and honestly records a capture.gap
    // because a transient state may have been skipped.
    const changed = recs.filter((r) => r.type === 'file.changed');
    const gaps = recs.filter((r) => r.type === 'capture.gap');
    assert.equal(changed.length, 1);
    if (changed[0]?.type === 'file.changed') {
      assert.deepEqual(changed[0].before, content('aaa'));
      assert.deepEqual(changed[0].after, content('bbb'));
    }
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.path, 'f.ts');
  });
});

test('processing for one path is serialized (no overlapping reads)', async () => {
  let active = 0;
  let maxActive = 0;
  const reader: Reader = {
    read: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return content(`v${Math.random()}`);
    },
  };
  await withEngine(reader, async ({ engine }) => {
    for (let i = 0; i < 10; i++) engine.notify('f.ts', i);
    await engine.drain();
    assert.equal(maxActive, 1);
  });
});
