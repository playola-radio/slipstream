import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { createLog } from './log.ts';
import type { AnyEvent, EventInput } from './event.ts';
import { readRecords, withLog, withTempDir } from './test/helpers.ts';

const SESSION = '00000000-0000-4000-8000-000000000000';

const change = (path: string, occurred_at_ms = 1): EventInput => ({
  type: 'slipstream.file.changed.v1',
  occurred_at_ms,
  data: { path, before: { kind: 'absent' }, after: { kind: 'absent' }, observation: 'watcher' },
});

describe('log', () => {
  describe('append', () => {
    it('writes one CloudEvents object per line', async () => {
      await withLog(async ({ log, read }) => {
        await log.append(change('a'));
        await log.append(change('b'));
        const records = await read();
        assert.equal(records.length, 2);
        assert.equal(records[0]?.type, 'slipstream.file.changed.v1');
      });
    });

    it('assigns contiguous decimal seq numbers starting at 1', async () => {
      await withLog(async ({ log, read }) => {
        await log.append(change('a'));
        await log.append(change('b'));
        await log.append(change('c'));
        assert.deepEqual((await read()).map((r) => r.seq), ['1', '2', '3']);
      });
    });

    it('returns the built envelope with source, seq, and injected session_id', async () => {
      await withLog(async ({ log }) => {
        const event = await log.append(change('a'));
        assert.equal(event.seq, '1');
        assert.equal(event.id, '1');
        assert.equal(event.source, `urn:slipstream:session:${SESSION}`);
        assert.equal(event.data.session_id, SESSION);
      });
    });

    it('advances durableSeq only after a record is committed', async () => {
      await withLog(async ({ log }) => {
        assert.equal(log.durableSeq(), 0n);
        await log.append(change('a'));
        assert.equal(log.durableSeq(), 1n);
      });
    });

    it('continues numbering from startSeq when resuming a log', async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'events.jsonl');
        await writeFile(path, ''); // pre-existing (recovered) log
        const log = await createLog({ filePath: path, sessionId: SESSION, startSeq: 41n });
        try {
          const event = await log.append(change('a'));
          assert.equal(event.seq, '42');
          assert.equal(log.durableSeq(), 42n);
        } finally {
          await log.close();
        }
      });
    });

    it('serializes concurrent appends into a contiguous, non-interleaved seq run', async () => {
      await withLog(async ({ log, read }) => {
        await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(change(`p${i}`, i))));
        const records = await read();
        assert.deepEqual(
          records.map((r) => Number(r.seq)).sort((a, b) => a - b),
          Array.from({ length: 50 }, (_, i) => i + 1),
        );
      });
    });

    it('stops accepting appends once a write fails, rather than corrupting the log', async () => {
      await withTempDir(async (dir) => {
        const log = await createLog({ filePath: join(dir, 'events.jsonl'), sessionId: SESSION });
        await log.close(); // next write hits a closed fd — stand-in for a mid-line failure
        await assert.rejects(log.append(change('a')));
        await assert.rejects(log.append(change('b'))); // stays poisoned
      });
    });
  });

  describe('sequencer', () => {
    const task = (taskId: string): EventInput => ({
      type: 'slipstream.task.started.v1',
      occurred_at_ms: 1,
      data: { task_id: taskId, request_id: `req-${taskId}`, title: taskId },
    });

    // A stand-in for the session's task-grouping policy: stamp each change with
    // the current task, and advance the current task after a declaration commits.
    const groupingSequencer = () => {
      const state = { current: undefined as string | undefined };
      return {
        state,
        sequencer: {
          enrich: (input: EventInput): EventInput =>
            input.type === 'slipstream.file.changed.v1' && state.current !== undefined
              ? { ...input, data: { ...input.data, task_hint_id: state.current } }
              : input,
          onCommitted: (event: AnyEvent): void => {
            if (event.type === 'slipstream.task.started.v1') state.current = event.data.task_id;
          },
        },
      };
    };

    it('stamps ordering-dependent fields consistently with seq order', async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'events.jsonl');
        const { sequencer } = groupingSequencer();
        const log = await createLog({ filePath: path, sessionId: SESSION, sequencer });
        try {
          // Fire without awaiting: append() chains on the tail in call order, so
          // seq order equals call order, and the change after the declaration
          // must pick up the task though none was individually awaited first.
          const p1 = log.append(change('a'));
          const p2 = log.append(task('t1'));
          const p3 = log.append(change('b'));
          await Promise.all([p1, p2, p3]);
          const recs = await readRecords(path);
          const hint = (seq: string): unknown =>
            (recs.find((r) => r.seq === seq)!.data as unknown as Record<string, unknown>).task_hint_id;
          assert.equal(hint('1'), undefined); // before any declaration -> ungrouped
          assert.equal(hint('3'), 't1'); // after the declaration -> grouped
        } finally {
          await log.close();
        }
      });
    });

    it('does not advance sequencer state when the write fails', async () => {
      await withTempDir(async (dir) => {
        const { state, sequencer } = groupingSequencer();
        const log = await createLog({
          filePath: join(dir, 'events.jsonl'),
          sessionId: SESSION,
          sequencer,
        });
        await log.close(); // poison the next write
        await assert.rejects(log.append(task('t1')));
        assert.equal(state.current, undefined); // onCommitted never ran
      });
    });
  });

  describe('durability', () => {
    it('creates the log file owner-only (0600)', async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'events.jsonl');
        const log = await createLog({ filePath: path, sessionId: SESSION });
        try {
          assert.equal((await stat(path)).mode & 0o777, 0o600);
        } finally {
          await log.close();
        }
      });
    });

    it('leaves a fully-terminated record on disk once append resolves', async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'events.jsonl');
        const log = await createLog({ filePath: path, sessionId: SESSION });
        try {
          await log.append(change('a'));
          const { readFile } = await import('node:fs/promises');
          const text = await readFile(path, 'utf8');
          assert.ok(text.endsWith('\n'));
          assert.equal(text.trimEnd().split('\n').length, 1);
        } finally {
          await log.close();
        }
      });
    });
  });
});
