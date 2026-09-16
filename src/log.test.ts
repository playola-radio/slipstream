import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLog, type LoggedRecord } from './log.ts';

async function withLog(fn: (ctx: { log: Awaited<ReturnType<typeof createLog>>; path: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'slip-log-'));
  const path = join(dir, 'events.jsonl');
  try {
    await fn({ log: await createLog(path), path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRecords(path: string): Promise<LoggedRecord[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedRecord);
}

test('append writes one JSON object per line', async () => {
  await withLog(async ({ log, path }) => {
    await log.append({ type: 'capture.gap', path: 'a', reason: 'coalesced', observed_at_ms: 1 });
    await log.append({ type: 'capture.gap', path: 'b', reason: 'coalesced', observed_at_ms: 2 });
    const records = await readRecords(path);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.path, 'a');
    assert.equal(records[1]?.path, 'b');
  });
});

test('append assigns contiguous sequence numbers starting at 1', async () => {
  await withLog(async ({ log, path }) => {
    await log.append({ type: 'capture.gap', path: 'a', reason: 'coalesced', observed_at_ms: 1 });
    await log.append({ type: 'capture.gap', path: 'b', reason: 'coalesced', observed_at_ms: 2 });
    const records = await readRecords(path);
    assert.equal(records[0]?.seq, 1);
    assert.equal(records[1]?.seq, 2);
  });
});

test('append stamps a commit time on every record', async () => {
  await withLog(async ({ log, path }) => {
    const before = Date.now();
    await log.append({ type: 'capture.gap', path: 'a', reason: 'coalesced', observed_at_ms: 1 });
    const [rec] = await readRecords(path);
    assert.ok(rec && rec.committed_at_ms >= before && rec.committed_at_ms <= Date.now());
  });
});

test('concurrent appends are serialized without interleaving or lost lines', async () => {
  await withLog(async ({ log, path }) => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.append({ type: 'capture.gap', path: `p${i}`, reason: 'coalesced', observed_at_ms: i }),
      ),
    );
    const records = await readRecords(path);
    assert.equal(records.length, 50);
    const seqs = records.map((r) => r.seq);
    assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
