import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Reader } from './reader.ts';
import type { Snapshot } from './snapshot.ts';
import { content, scriptedReader, withEngine } from './test/helpers.ts';

describe('engine', () => {
  describe('change detection', () => {
    it('emits one file.changed with the correct before/after for a change from the baseline', async () => {
      await withEngine(scriptedReader([content('bbb')]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 100);
        await engine.drain();
        const recs = await read();
        assert.equal(recs.length, 1);
        assert.equal(recs[0]?.type, 'file.changed');
        if (recs[0]?.type === 'file.changed') {
          assert.deepEqual(recs[0].before, content('aaa'));
          assert.deepEqual(recs[0].after, content('bbb'));
          assert.equal(recs[0].observed_at_ms, 100);
        }
      });
    });

    it('emits nothing when an observation is identical to the committed state', async () => {
      await withEngine(scriptedReader([content('aaa')]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 1);
        await engine.drain();
        assert.equal((await read()).length, 0);
      });
    });

    it('records A -> B -> A as two transitions, not one deduplicated pair', async () => {
      await withEngine(scriptedReader([content('bbb'), content('aaa')]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 1);
        await engine.drain();
        engine.notify('f.ts', 2);
        await engine.drain();
        const recs = await read();
        assert.equal(recs.length, 2);
        if (recs[0]?.type === 'file.changed' && recs[1]?.type === 'file.changed') {
          assert.deepEqual([recs[0].before, recs[0].after], [content('aaa'), content('bbb')]);
          assert.deepEqual([recs[1].before, recs[1].after], [content('bbb'), content('aaa')]);
        }
      });
    });

    it('records a deletion as content -> absent', async () => {
      await withEngine(scriptedReader([{ kind: 'absent' }]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 1);
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === 'file.changed') {
          assert.deepEqual(rec.before, content('aaa'));
          assert.deepEqual(rec.after, { kind: 'absent' });
        }
      });
    });

    it('records a creation as absent -> content when the path has no baseline', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.notify('created.ts', 1);
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === 'file.changed') {
          assert.deepEqual(rec.before, { kind: 'absent' });
          assert.deepEqual(rec.after, content('new'));
        }
      });
    });

    it('uses an unknown before-state, not absent, for a path under an unreadable baseline dir', async () => {
      await withEngine(scriptedReader([content('after')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('locked');
        engine.notify('locked/existing.ts', 1); // never baselined; dir was unreadable
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === 'file.changed') {
          assert.deepEqual(rec.before, { kind: 'unavailable', reason: 'baseline-unknown' });
          assert.deepEqual(rec.after, content('after'));
        } else {
          assert.fail('expected a file.changed record');
        }
      });
    });

    it('does not treat a sibling outside the unreadable dir as baseline-unknown', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('locked');
        engine.notify('elsewhere.ts', 1); // not under the unreadable prefix
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === 'file.changed') {
          assert.deepEqual(rec.before, { kind: 'absent' });
        } else {
          assert.fail('expected a file.changed record');
        }
      });
    });
  });

  describe('coalescing and serialization', () => {
    it('folds a notify that lands mid-read into a follow-up cycle and records an honest gap', async () => {
      // Gate the first read so a second notify arrives while the path is busy.
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      const reads: Snapshot[] = [content('bbb'), content('bbb')];
      let call = 0;
      const reader: Reader = {
        read: async () => {
          const idx = call++;
          if (idx === 0) await firstGate;
          return reads[idx] ?? { kind: 'absent' };
        },
      };

      await withEngine(reader, async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 1); // starts processing, blocks on the gate
        await Promise.resolve();
        engine.notify('f.ts', 2); // arrives while processing -> coalesced
        releaseFirst();
        await engine.drain();

        const recs = await read();
        // Cycle 1 commits aaa -> bbb (comparing against the committed baseline,
        // not disk). The notify that landed during cycle 1 folds into cycle 2,
        // which re-reads, finds bbb unchanged, and records a capture.gap because
        // a transient state may have been skipped.
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

    it('serializes processing for one path so reads never overlap', async () => {
      let active = 0;
      let maxActive = 0;
      const reader: Reader = {
        read: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
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
  });
});
