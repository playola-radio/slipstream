import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { withTempDir, readRecords } from './test/helpers.ts';
import { QUESTION_TTL_MS } from './questions.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';

type Session = Awaited<ReturnType<typeof startCapture>>;
type Target = { harness: 'codex' | 'claude-code'; harness_session_id: string; worktree: string };
interface Ctx { session: Session; target: Target; ask: () => Promise<string>; setTime: (n: number) => void; storeDir: string; root: string }

async function fixture(run: (ctx: Ctx) => Promise<void>, deps: Parameters<typeof startCapture>[1] = {}) {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const storeDir = join(base, 'store');
    let now = 1000;
    const session = await startCapture({ root, storeDir, now: () => now }, {
      platform: createFakePlatform(), readQuestionContext: async () => 'selected', ...deps,
    });
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    const ask = async () => (await session.askQuestion({ session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
      change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
    } }, target)).question_id;
    try { await run({ session, target, ask, setTime: n => { now = n; }, storeDir, root }); }
    finally { await session.stop(); }
  });
}
const code = (c: string) => ({ code: c });
const answers = async (s: Session) => (await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.answered.v1');

it('records one answer to a dispatched question and replays it for identical text', async () => {
  await fixture(async ({ session, target, ask, setTime }) => {
    const id = await ask();
    await assert.rejects(session.answerQuestion({ question_id: id, text: 'early' }, target), code('QUESTION_NOT_FOUND'));
    await session.claimQuestion(target);
    setTime(2000);
    const text = '  It interpolates name.\n';
    const first = await session.answerQuestion({ question_id: id, text }, target);
    assert.deepEqual(first, { session_id: session.sessionId, question_id: id, event_id: first.seq, seq: first.seq,
      answered_at_ms: 2000, duplicate: false });
    setTime(3000);
    assert.deepEqual(await session.answerQuestion({ question_id: id, text }, target), { ...first, duplicate: true });
    await assert.rejects(session.answerQuestion({ question_id: id, text: 'something else' }, target), code('ANSWER_CONFLICT'));
    const [event, ...rest] = await answers(session);
    assert.equal(rest.length, 0);
    assert.equal(event!.seq, first.seq);
    assert.equal(event!.subject, `question/${id}`);
    const attempt = (await readRecords(session.logPath)).find(e => e.type === 'slipstream.question.dispatch_attempted.v1')!;
    assert.deepEqual(event!.data, { question_id: id, attempt_seq: attempt.seq, text, answered_at_ms: 2000, session_id: session.sessionId });
  });
});

it('rejects invalid answer text before looking up the question', async () => {
  await fixture(async ({ session, target, ask }) => {
    const id = await ask(); await session.claimQuestion(target);
    for (const text of [' \n\t', '', 'a'.repeat(16385), 'é'.repeat(8193), 'why\ud800', 42, undefined]) {
      await assert.rejects(session.answerQuestion({ question_id: id, text }, target), code('INVALID_ANSWER'));
      await assert.rejects(session.answerQuestion({ question_id: randomUUID(), text }, target), code('INVALID_ANSWER'));
    }
    const max = 'é'.repeat(8192);
    assert.equal(Buffer.byteLength(max), 16384);
    assert.equal((await session.answerQuestion({ question_id: id, text: max }, target)).duplicate, false);
    assert.equal((await answers(session))[0]!.data.text, max);
  });
});

it('hides questions that are unknown, undispatched, or targeted at another session', async () => {
  await fixture(async ({ session, target, ask }) => {
    const id = await ask(); await session.claimQuestion(target);
    const queuedOnly = await ask();
    for (const question_id of [randomUUID(), queuedOnly, 7, undefined, id.toUpperCase()]) {
      await assert.rejects(session.answerQuestion({ question_id, text: 'x' }, target), code('QUESTION_NOT_FOUND'));
    }
    for (const other of [{ ...target, harness_session_id: 'other' }, { ...target, harness: 'claude-code' as const },
      { ...target, worktree: '/elsewhere' }]) {
      await assert.rejects(session.answerQuestion({ question_id: id, text: 'x' }, other), code('QUESTION_NOT_FOUND'));
    }
    await session.answerQuestion({ question_id: id, text: 'mine' }, target);
    await assert.rejects(session.answerQuestion({ question_id: id, text: 'theirs' }, { ...target, harness_session_id: 'other' }),
      code('QUESTION_NOT_FOUND'));
    assert.equal((await answers(session)).length, 1);
  });
});

it('coalesces concurrent identical answers and conflicts concurrent different ones', async () => {
  await fixture(async ({ session, target, ask }) => {
    const a = await ask(); const b = await ask();
    await session.claimQuestion(target); await session.claimQuestion(target);
    const same = await Promise.all(Array.from({ length: 8 }, () => session.answerQuestion({ question_id: a, text: 'one' }, target)));
    assert.equal(same.filter(r => !r.duplicate).length, 1);
    assert.ok(same.every(r => r.seq === same[0]!.seq));
    const mixed = await Promise.allSettled([
      session.answerQuestion({ question_id: b, text: 'first' }, target),
      session.answerQuestion({ question_id: b, text: 'second' }, target),
    ]);
    assert.equal(mixed[0]!.status, 'fulfilled');
    assert.equal(mixed[1]!.status, 'rejected');
    assert.equal((mixed[1] as PromiseRejectedResult).reason.code, 'ANSWER_CONFLICT');
    assert.deepEqual((await answers(session)).map(e => [e.data.question_id, e.data.text]), [[a, 'one'], [b, 'first']]);
  });
});

it('accepts an answer after the question TTL without changing what can be claimed', async () => {
  await fixture(async ({ session, target, ask, setTime }) => {
    const first = await ask(); const second = await ask();
    assert.equal((await session.claimQuestion(target))!.question_id, first);
    setTime(1000 + QUESTION_TTL_MS - 1);
    await session.answerQuestion({ question_id: first, text: 'late' }, target);
    assert.equal((await session.claimQuestion(target))!.question_id, second);
    assert.equal(await session.claimQuestion(target), null);
    setTime(1000 + QUESTION_TTL_MS + 1);
    await session.answerQuestion({ question_id: second, text: 'after expiry' }, target);
    const order = (await readRecords(session.logPath)).filter(e => e.type.startsWith('slipstream.question.'))
      .map(e => `${e.type.split('.')[2]}:${(e.data as { question_id: string }).question_id === first ? 1 : 2}`);
    assert.deepEqual(order, ['queued:1', 'queued:2', 'dispatch_attempted:1', 'answered:1', 'dispatch_attempted:2', 'answered:2']);
  });
});

it('keeps questions and answers across a resume for replays, conflicts, and follow-ups', async () => {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const storeDir = join(base, 'store');
    const deps = { platform: createFakePlatform(), readQuestionContext: async () => 'selected' };
    const first = await startCapture({ root, storeDir, now: () => 1000 }, deps);
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    let original;
    let id: string;
    try {
      id = (await first.askQuestion({ session_id: first.sessionId, request_id: randomUUID(), text: 'Why?', context: {
        change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
      } }, target)).question_id;
      await first.claimQuestion(target);
      original = await first.answerQuestion({ question_id: id, text: 'kept' }, target);
    } finally { await first.stop(); }
    const resumed = await startCapture({ root, storeDir, now: () => 5000, resumeSessionId: first.sessionId },
      { platform: createFakePlatform(), readQuestionContext: async () => 'selected' });
    try {
      assert.deepEqual(await resumed.answerQuestion({ question_id: id, text: 'kept' }, target), { ...original, duplicate: true });
      await assert.rejects(resumed.answerQuestion({ question_id: id, text: 'changed' }, target), code('ANSWER_CONFLICT'));
      const followUp = await resumed.askQuestion({ session_id: first.sessionId, request_id: randomUUID(), text: 'And?',
        reply_to_question_id: id, context: { change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1 } }, target);
      assert.equal(followUp.duplicate, false);
    } finally { await resumed.stop(); }
  });
});

it('replays an answer whose append reply was lost after it committed', async () => {
  let fail = true;
  await fixture(async ({ session, target, ask }) => {
    const id = await ask(); await session.claimQuestion(target);
    await assert.rejects(session.answerQuestion({ question_id: id, text: 'once' }, target), StorageError);
    const deadline = Date.now() + 5000;
    while (session.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline, 'recovery must finish');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await session.answerQuestion({ question_id: id, text: 'once' }, target)).duplicate, true);
    assert.equal((await answers(session)).length, 1);
  }, {
    createLog: async opts => {
      const log = await createLog(opts);
      return { ...log, append: async input => {
        const event = await log.append(input);
        if (input.type === 'slipstream.question.answered.v1' && fail) {
          fail = false; throw new StorageError('append', new Error('reply lost after fsync'));
        }
        return event;
      } };
    },
  });
});

it('finishes an in-flight answer before stop closes the log', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const session = await startCapture({ root, storeDir: join(base, 'store'), now: () => 1000 }, {
      platform: createFakePlatform(), readQuestionContext: async () => 'selected',
      createLog: async opts => {
        const log = await createLog(opts);
        return { ...log, append: async input => {
          if (input.type === 'slipstream.question.answered.v1') { entered(); await gate; }
          return log.append(input);
        } };
      },
    });
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    const id = (await session.askQuestion({ session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
      change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
    } }, target)).question_id;
    await session.claimQuestion(target);
    const answer = session.answerQuestion({ question_id: id, text: 'drained' }, target);
    await started;
    const stopping = session.stop();
    // Give stop time to reach the log close it must hold back.
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    await Promise.allSettled([answer]);
    await stopping;
    assert.equal((await answers(session)).length, 1);
  });
});
