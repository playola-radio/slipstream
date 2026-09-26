import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { appendFile, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import { createLog } from './log.ts';
import { recoverSession, CorruptLogError } from './recovery.ts';
import type { PublicEventInput as EventInput } from './public-events.ts';
import { withTempDir } from './test/helpers.ts';

const SESSION = '00000000-0000-4000-8000-000000000000';

const started: EventInput = {
  type: 'slipstream.session.started.v1',
  occurred_at_ms: 1,
  data: { root: '/work', max_bytes: 1024 },
};
const baselineAbsent = (path: string): EventInput => ({
  type: 'slipstream.file.baselined.v1',
  occurred_at_ms: 2,
  data: { path, snapshot: { kind: 'absent' } },
});
const task = (taskId: string, requestId: string, title = taskId): EventInput => ({
  type: 'slipstream.task.started.v1',
  occurred_at_ms: 3,
  data: { task_id: taskId, request_id: requestId, title },
});

/** Write a genuine, well-formed log via the real writer, then close it. */
async function seedLog(dir: string, inputs: EventInput[]): Promise<string> {
  const path = join(dir, 'events.jsonl');
  const log = await createLog({ filePath: path, sessionId: SESSION });
  try {
    for (const input of inputs) await log.append(input);
  } finally {
    await log.close();
  }
  return path;
}

const QUESTION = '11111111-1111-4111-8111-111111111111';
const OTHER_QUESTION = '22222222-2222-4222-8222-222222222222';
const queued = (questionId: string): EventInput => ({
  type: 'slipstream.question.queued.v1',
  occurred_at_ms: 4,
  data: {
    question_id: questionId,
    request_id: questionId,
    target: { harness: 'codex', harness_session_id: 'root', worktree: '/work' },
    text: 'Why?',
    context: { change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1, selected_text: 'a' },
    queued_at_ms: 4,
    expires_at_ms: 5,
  },
});
const attempted = (questionId: string, queuedSeq: string): EventInput => ({
  type: 'slipstream.question.dispatch_attempted.v1',
  occurred_at_ms: 5,
  data: { question_id: questionId, queued_seq: queuedSeq, attempted_at_ms: 5 },
});
const answered = (questionId: string, attemptSeq: string, text = 'Because.'): EventInput => ({
  type: 'slipstream.question.answered.v1',
  occurred_at_ms: 6,
  data: { question_id: questionId, attempt_seq: attemptSeq, text, answered_at_ms: 6 },
});

describe('recovery', () => {
  it('recovers through the last complete record and discards a torn trailing suffix', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, baselineAbsent('a.ts')]);
      const torn = '{"seq":"3","partial":tru';
      await appendFile(path, torn);

      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.recoveredThroughSeq, 2n);
      assert.equal(rec.discardedTailBytes, Buffer.byteLength(torn));

      const text = await readFile(path, 'utf8');
      assert.ok(text.endsWith('}\n'), 'torn suffix must be truncated back to the last newline');
      assert.ok(!text.includes('partial'));
      assert.equal(text.trimEnd().split('\n').length, 2);
    });
  });

  it('preserves session identity, seq, and the replayed baseline', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, baselineAbsent('a.ts'), baselineAbsent('b.ts')]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.root, '/work');
      assert.equal(rec.maxBytes, 1024);
      assert.equal(rec.recoveredThroughSeq, 3n);
      assert.deepEqual([...rec.committed.keys()].sort(), ['a.ts', 'b.ts']);
    });
  });

  it('rebuilds the current task and dedup index from committed declarations', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, task('t1', 'r1', 'First'), task('t2', 'r2', 'Second')]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.currentTaskId, 't2'); // last committed declaration wins
      assert.deepEqual([...rec.taskDeclarations.keys()].sort(), ['r1', 'r2']);
      assert.deepEqual(rec.taskDeclarations.get('r1'), { taskId: 't1', title: 'First', seq: '2' });
      assert.deepEqual(rec.taskDeclarations.get('r2'), { taskId: 't2', title: 'Second', seq: '3' });
    });
  });

  it('does not treat a torn trailing declaration as authoritative', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, task('t1', 'r1')]);
      await appendFile(path, '{"seq":"3","type":"slipstream.task.started.v1","data":{"task_id":"t2"');
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.currentTaskId, 't1'); // the torn t2 declaration is discarded with the tail
      assert.deepEqual([...rec.taskDeclarations.keys()], ['r1']);
      assert.equal(rec.recoveredThroughSeq, 2n);
    });
  });

  it('rebuilds committed answers in log order', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, queued(QUESTION), queued(OTHER_QUESTION), attempted(QUESTION, '2'),
        attempted(OTHER_QUESTION, '3'), answered(OTHER_QUESTION, '5', 'second first'), answered(QUESTION, '4')]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.deepEqual(rec.questionAnswers.map(a => [a.seq, a.data.question_id, a.data.attempt_seq, a.data.text]),
        [['6', OTHER_QUESTION, '5', 'second first'], ['7', QUESTION, '4', 'Because.']]);
    });
  });

  it('does not count a torn trailing answer', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, queued(QUESTION), attempted(QUESTION, '2')]);
      await appendFile(path, '{"seq":"4","type":"slipstream.question.answered.v1","data":{"question_id":"' + QUESTION + '"');
      const rec = await recoverSession(path, SESSION, cas);
      assert.deepEqual(rec.questionAnswers, []);
      assert.equal(rec.recoveredThroughSeq, 3n);
    });
  });

  for (const [name, inputs, mutate] of [
    ['a subject that disagrees with the question id', [queued(QUESTION), attempted(QUESTION, '2'), answered(QUESTION, '3')],
      (e: Record<string, unknown>) => { e.subject = `question/${OTHER_QUESTION}`; }],
    ['a missing attempt_seq', [queued(QUESTION), attempted(QUESTION, '2'), answered(QUESTION, '3')],
      (e: Record<string, unknown>) => { delete (e.data as Record<string, unknown>).attempt_seq; }],
    ['an attempt_seq naming another question\'s attempt', [queued(QUESTION), queued(OTHER_QUESTION), attempted(QUESTION, '2'),
      attempted(OTHER_QUESTION, '3'), answered(QUESTION, '5')], undefined],
    ['an answer to a question that was never dispatched', [queued(QUESTION), answered(QUESTION, '2')], undefined],
    ['a second answer for the same question', [queued(QUESTION), attempted(QUESTION, '2'), answered(QUESTION, '3'),
      answered(QUESTION, '3')], undefined],
  ] as Array<[string, EventInput[], ((e: Record<string, unknown>) => void) | undefined]>) {
    it(`rejects ${name} as corrupt`, async () => {
      await withTempDir(async (dir) => {
        const cas = await createCas(join(dir, 'blobs'));
        const path = await seedLog(dir, [started, ...inputs]);
        if (mutate) {
          const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
          const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
          mutate(last);
          lines[lines.length - 1] = JSON.stringify(last);
          await writeFile(path, lines.join('\n') + '\n');
        }
        await assert.rejects(recoverSession(path, SESSION, cas), CorruptLogError);
      });
    });
  }

  it('treats a corrupt record in the middle of the log as a hard error, not a skip', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, baselineAbsent('a.ts'), baselineAbsent('b.ts')]);
      const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.length > 0);
      lines[1] = 'this is not json'; // a terminated middle record
      await writeFile(path, lines.join('\n') + '\n');
      await assert.rejects(recoverSession(path, SESSION, cas), CorruptLogError);
    });
  });

  it('rejects a log whose first record is not session.started', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = join(dir, 'events.jsonl');
      const log = await createLog({ filePath: path, sessionId: SESSION });
      await log.append(baselineAbsent('a.ts')); // no session.started first
      await log.close();
      await assert.rejects(recoverSession(path, SESSION, cas), /first record must be session.started/);
    });
  });

  it('rejects a second session.started record', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.session.started.v1',
          occurred_at_ms: 2,
          data: { root: '/other-worktree', max_bytes: 2048 },
        },
      ]);
      await assert.rejects(recoverSession(path, SESSION, cas), /duplicate session\.started/);
    });
  });

  it('rejects unsafe baseline completed unknown scopes', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.capture.baseline.completed.v1',
          occurred_at_ms: 2,
          data: { unknown_scopes: ['../outside'] },
        },
      ]);
      await assert.rejects(recoverSession(path, SESSION, cas), /unsafe path/);
    });
  });

  it('accepts a baseline-unreadable gap scoped to the worktree root ("")', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      // A failed enumeration of the root itself emits a gap whose directory scope
      // is relative(root, root) === "". That empty scope is the root, not a
      // corrupt path, so recovery must accept it and mark the root unknown.
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.capture.gap.v1',
          occurred_at_ms: 2,
          data: { scope: { kind: 'directory', path: '' }, reason: 'baseline-unreadable' },
        },
      ]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.recoveredThroughSeq, 2n);
      assert.ok(rec.baselineUnknownDirs.has(''), 'root ("") must be recorded as baseline-unknown');
    });
  });

  it('rejects a log referencing a blob that is missing from the store', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const sha = 'a'.repeat(64); // valid-shaped hex, never stored
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.file.baselined.v1',
          occurred_at_ms: 2,
          data: { path: 'a.ts', snapshot: { kind: 'content', sha256: sha, size: 3 } },
        },
      ]);
      await assert.rejects(recoverSession(path, SESSION, cas), /missing/);
    });
  });

  it('accepts a content snapshot whose blob is present and hashes correctly', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const ref = await cas.put(Buffer.from('hello'));
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.file.baselined.v1',
          occurred_at_ms: 2,
          data: { path: 'a.ts', snapshot: { kind: 'content', sha256: ref.sha256, size: ref.size } },
        },
      ]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.recoveredThroughSeq, 2n);
      assert.deepEqual(rec.committed.get('a.ts'), { kind: 'content', sha256: ref.sha256, size: ref.size });
    });
  });

  it('rejects a blob whose stored bytes do not match the referenced size', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const ref = await cas.put(Buffer.from('hello'));
      const path = await seedLog(dir, [
        started,
        {
          type: 'slipstream.file.baselined.v1',
          occurred_at_ms: 2,
          data: { path: 'a.ts', snapshot: { kind: 'content', sha256: ref.sha256, size: ref.size + 1 } },
        },
      ]);
      await assert.rejects(recoverSession(path, SESSION, cas), /size/);
    });
  });

  it('establishes a durability barrier over the retained prefix on a clean recovery', async (t) => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, baselineAbsent('a.ts')]);

      // Identify each synced handle by inode so the assertion guards the LOG
      // FILE's own fsync specifically, not merely "some handle synced" — a
      // count-only spy also counts the directory sync and would still pass if
      // the load-bearing `handle.sync()` were deleted. A clean log referencing
      // only `absent` snapshots drives no blob syncs, so the only syncs here are
      // recovery's own barrier. Spy on the real fsync through the FileHandle
      // prototype (no production seam); the mock still calls the real sync.
      const logIno = (await stat(path)).ino;
      const dirIno = (await stat(dir)).ino;
      const syncedInos: number[] = [];
      const probe = await open(path, 'r');
      const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
      await probe.close();
      const realSync = proto.sync;
      t.mock.method(proto, 'sync', function (this: { fd: number }) {
        syncedInos.push(fstatSync(this.fd).ino);
        return realSync.call(this);
      });

      const rec = await recoverSession(path, SESSION, cas);

      assert.equal(rec.discardedTailBytes, 0, 'precondition: clean recovery, no torn tail');
      assert.equal(rec.recoveredThroughSeq, 2n);
      assert.ok(
        syncedInos.includes(logIno),
        'the retained log file itself must be fsynced before recoveredThroughSeq is durable',
      );
      assert.ok(
        syncedInos.includes(dirIno),
        'the containing directory must be fsynced as part of the barrier',
      );
    });
  });

  it('rejects recovery when the retained-prefix fsync fails, never returning a non-durable seq', async (t) => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, baselineAbsent('a.ts')]);

      // Fail only the log file's fsync (by inode); the directory sync still runs
      // for real. A recovered seq must be a durable seq, so a failed barrier must
      // reject rather than return recoveredThroughSeq for republication.
      const logIno = (await stat(path)).ino;
      const probe = await open(path, 'r');
      const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
      await probe.close();
      const realSync = proto.sync;
      t.mock.method(proto, 'sync', function (this: { fd: number }) {
        if (fstatSync(this.fd).ino === logIno) {
          return Promise.reject(Object.assign(new Error('injected fsync failure'), { code: 'EIO' }));
        }
        return realSync.call(this);
      });

      await assert.rejects(recoverSession(path, SESSION, cas), /injected fsync failure/);
    });
  });

  it('returns an empty recovery for a log that does not exist yet', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const rec = await recoverSession(join(dir, 'events.jsonl'), SESSION, cas);
      assert.equal(rec.recoveredThroughSeq, 0n);
      assert.equal(rec.root, undefined);
      assert.equal(rec.discardedTailBytes, 0);
    });
  });
});
