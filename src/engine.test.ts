import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './engine.ts';
import type { Reader } from './reader.ts';
import type { Snapshot } from './snapshot.ts';
import { content, scriptedReader, withEngine } from './test/helpers.ts';

const CHANGED = 'slipstream.file.changed.v1';
const GAP = 'slipstream.capture.gap.v1';

describe('engine', () => {
  describe('change detection', () => {
    it('emits one file.changed with the correct before/after for a change from the baseline', async () => {
      await withEngine(scriptedReader([content('bbb')]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 100);
        await engine.drain();
        const recs = await read();
        assert.equal(recs.length, 1);
        assert.equal(recs[0]?.type, CHANGED);
        if (recs[0]?.type === CHANGED) {
          assert.deepEqual(recs[0].data.before, content('aaa'));
          assert.deepEqual(recs[0].data.after, content('bbb'));
          assert.equal(recs[0].data.observation, 'watcher');
          assert.equal(recs[0].time, new Date(100).toISOString());
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
        if (recs[0]?.type === CHANGED && recs[1]?.type === CHANGED) {
          assert.deepEqual([recs[0].data.before, recs[0].data.after], [content('aaa'), content('bbb')]);
          assert.deepEqual([recs[1].data.before, recs[1].data.after], [content('bbb'), content('aaa')]);
        }
      });
    });

    it('records a deletion as content -> absent', async () => {
      await withEngine(scriptedReader([{ kind: 'absent' }]), async ({ engine, read }) => {
        engine.setBaseline('f.ts', content('aaa'));
        engine.notify('f.ts', 1);
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === CHANGED) {
          assert.deepEqual(rec.data.before, content('aaa'));
          assert.deepEqual(rec.data.after, { kind: 'absent' });
        }
      });
    });

    it('records a creation as absent -> content when the path has no baseline', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.notify('created.ts', 1);
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === CHANGED) {
          assert.deepEqual(rec.data.before, { kind: 'absent' });
          assert.deepEqual(rec.data.after, content('new'));
        }
      });
    });

    it('uses an unknown before-state, not absent, for a path under an unreadable baseline dir', async () => {
      await withEngine(scriptedReader([content('after')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('locked');
        engine.notify('locked/existing.ts', 1); // never baselined; dir was unreadable
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === CHANGED) {
          assert.deepEqual(rec.data.before, { kind: 'unavailable', reason: 'baseline-unknown' });
          assert.deepEqual(rec.data.after, content('after'));
        } else {
          assert.fail('expected a file.changed record');
        }
      });
    });

    it('does not treat a sibling sharing a name prefix as baseline-unknown', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('locked');
        engine.notify('locked-out/a.ts', 1);
        await engine.drain();
        const [rec] = await read();
        assert.ok(rec?.type === CHANGED);
        assert.deepEqual(rec.data.before, { kind: 'absent' });
      });
    });

    it('treats every path as baseline-unknown when the whole root is marked', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('');
        engine.notify('deep/nested/a.ts', 1);
        await engine.drain();
        const [rec] = await read();
        assert.ok(rec?.type === CHANGED);
        assert.deepEqual(rec.data.before, { kind: 'unavailable', reason: 'baseline-unknown' });
      });
    });

    it('does not treat a sibling outside the unreadable dir as baseline-unknown', async () => {
      await withEngine(scriptedReader([content('new')]), async ({ engine, read }) => {
        engine.markBaselineUnknown('locked');
        engine.notify('elsewhere.ts', 1); // not under the unreadable prefix
        await engine.drain();
        const [rec] = await read();
        if (rec?.type === CHANGED) {
          assert.deepEqual(rec.data.before, { kind: 'absent' });
        } else {
          assert.fail('expected a file.changed record');
        }
      });
    });
  });

  describe('observed interval', () => {
    it('stamps start_ms from the observation and end_ms from acquisition completion', async () => {
      let clock = 500;
      await withEngine(
        scriptedReader([content('bbb')]),
        async ({ engine, read }) => {
          engine.setBaseline('f.ts', content('aaa'));
          engine.notify('f.ts', 100);
          await engine.drain();
          const [rec] = await read();
          assert.equal(rec?.type, CHANGED);
          if (rec?.type === CHANGED) {
            assert.deepEqual(rec.data.observed_interval_ms, { start_ms: 100, end_ms: 500 });
            assert.equal(rec.data.observed_at_ms, 100, 'start_ms mirrors observed_at_ms');
          }
        },
        { now: () => clock++ },
      );
    });

    it('records a regressed acquisition clock truthfully, without clamping', async () => {
      await withEngine(
        scriptedReader([content('bbb')]),
        async ({ engine, read }) => {
          engine.setBaseline('f.ts', content('aaa'));
          engine.notify('f.ts', 1000);
          await engine.drain();
          const [rec] = await read();
          if (rec?.type === CHANGED) {
            assert.deepEqual(rec.data.observed_interval_ms, { start_ms: 1000, end_ms: 400 });
          }
        },
        { now: () => 400 },
      );
    });
  });

  describe('coalescing and serialization', () => {
    it('discards stale coalesced notifications when recovery resets bookkeeping', async () => {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let reads = 0;
      const reader: Reader = {
        read: async () => {
          reads++;
          if (reads === 1) await firstGate;
          return content('aaa');
        },
      };
      const appended: Array<{ type: string }> = [];
      let fail = true;
      const engine = createEngine({
        reader,
        log: {
          append: async (input) => {
            if (fail) throw new Error('storage failed');
            appended.push(input);
            return {} as never;
          },
        },
      });

      engine.setBaseline('f.ts', content('bbb'));
      engine.notify('f.ts', 1);
      await Promise.resolve();
      engine.notify('f.ts', 2);
      releaseFirst();
      await engine.drain();

      engine.resetNotifications();
      engine.setBaseline('f.ts', content('aaa'));
      fail = false;
      engine.notify('f.ts', 3);
      await engine.drain();

      assert.deepEqual(appended, [], 'a stale coalesced flag must not fabricate a gap');
    });

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
        const changed = recs.filter((r) => r.type === CHANGED);
        const gaps = recs.filter((r) => r.type === GAP);
        assert.equal(changed.length, 1);
        if (changed[0]?.type === CHANGED) {
          assert.deepEqual(changed[0].data.before, content('aaa'));
          assert.deepEqual(changed[0].data.after, content('bbb'));
        }
        assert.equal(gaps.length, 1);
        if (gaps[0]?.type === GAP) {
          assert.deepEqual(gaps[0].data.scope, { kind: 'path', path: 'f.ts' });
          assert.equal(gaps[0].data.reason, 'coalesced');
        }
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
