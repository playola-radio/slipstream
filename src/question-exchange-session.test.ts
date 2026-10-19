import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { withTempDir, waitForRecords, readRecords } from './test/helpers.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';
import { readQuestionContext, type QuestionRequest } from './questions.ts';

type Session = Awaited<ReturnType<typeof startCapture>>;
type ExchangeInput = QuestionRequest & { answer_text: string; conversation: { harness: 'claude-code'; parent_session_id: string; fork_session_id: string } };

const target = { harness: 'codex' as const, harness_session_id: 'main', worktree: '/tmp/example' };
const exchangeEvents = async (s: Session) => (await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.exchange_recorded.v1');

function toExchange(base: QuestionRequest, extra: Partial<ExchangeInput> = {}): ExchangeInput {
  return { ...base, request_id: randomUUID(), answer_text: 'Because of the tab.\n  Verbatim.',
    conversation: { harness: 'claude-code', parent_session_id: 'parent-1', fork_session_id: 'fork-1' }, ...extra };
}

async function waitDurable(s: Session, seq: string): Promise<void> {
  while (BigInt(s.health.snapshot().durable_seq) < BigInt(seq)) await new Promise(r => setTimeout(r, 5));
}

async function fixture(run: (s: Session, input: ExchangeInput) => Promise<void>, deps: Parameters<typeof startCapture>[1] = {}) {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const platform = createFakePlatform();
    const s = await startCapture({ root, storeDir: join(base, 'store'), now: () => 1000 }, { platform, ...deps });
    try {
      await writeFile(join(root, 'a.ts'), 'one\r\n\ttwo\n'); platform.observe('a.ts');
      const ev = (await waitForRecords(s.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1'))).find(e => e.type === 'slipstream.file.changed.v1')!;
      await waitDurable(s, ev.seq);
      assert.equal(ev.type, 'slipstream.file.changed.v1'); assert.equal(ev.data.after.kind, 'content');
      await run(s, toExchange({ session_id: s.sessionId, request_id: randomUUID(), text: ' Why? ',
        context: { change_seq: ev.seq, path: 'a.ts', snapshot_sha256: ev.data.after.sha256, line_start: 1, line_end: 2 } }));
    } finally { await s.stop(); }
  });
}

it('records one exchange_recorded event with daemon-read selected_text and reported_by client', async () => {
  await fixture(async (s, input) => {
    const before = (await readRecords(s.logPath)).length;
    const accepted = await s.recordQuestionExchange({ ...input, context: { ...input.context, selected_text: 'forged' } });
    assert.equal(accepted.duplicate, false);
    const records = await readRecords(s.logPath);
    assert.equal(records.length, before + 1);
    const event = records.at(-1)!;
    assert.equal(event.type, 'slipstream.question.exchange_recorded.v1');
    if (event.type !== 'slipstream.question.exchange_recorded.v1') return;
    assert.equal(event.data.context.selected_text, 'one\r\n\ttwo');
    assert.equal(event.data.conversation.reported_by, 'client');
    assert.equal(event.data.answer_text, input.answer_text);
    assert.equal(event.data.text, 'Why?');
    assert.equal(accepted.question_id, event.data.question_id);
    assert.equal(accepted.seq, event.seq);
  });
});

it('identical retry returns the original result with duplicate true, settled and concurrent', async () => {
  await fixture(async (s, input) => {
    const concurrent = await Promise.all([s.recordQuestionExchange(input), s.recordQuestionExchange(input)]);
    assert.deepEqual(concurrent.map(r => r.duplicate).sort(), [false, true]);
    assert.equal(concurrent[0].seq, concurrent[1].seq);
    const settled = await s.recordQuestionExchange(input);
    assert.deepEqual(settled, { ...concurrent.find(r => !r.duplicate)!, duplicate: true });
    assert.equal((await exchangeEvents(s)).length, 1);
  });
});

it('same request_id with a different answer_text is REQUEST_CONFLICT', async () => {
  await fixture(async (s, input) => {
    await s.recordQuestionExchange(input);
    await assert.rejects(s.recordQuestionExchange({ ...input, answer_text: 'something else' }), { code: 'REQUEST_CONFLICT' });
    assert.equal((await exchangeEvents(s)).length, 1);
  });
});

it('retry after session restart returns duplicate true and a parent recorded before restart is accepted', async () => {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const storeDir = join(base, 'store');
    const platform = createFakePlatform();
    const s1 = await startCapture({ root, storeDir, now: () => 1000 }, { platform });
    await writeFile(join(root, 'a.ts'), 'one\r\n\ttwo\n'); platform.observe('a.ts');
    const ev = (await waitForRecords(s1.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1'))).find(e => e.type === 'slipstream.file.changed.v1')!;
    assert.equal(ev.type, 'slipstream.file.changed.v1'); assert.equal(ev.data.after.kind, 'content');
    await waitDurable(s1, ev.seq);
    const input = toExchange({ session_id: s1.sessionId, request_id: randomUUID(), text: ' Why? ',
      context: { change_seq: ev.seq, path: 'a.ts', snapshot_sha256: ev.data.after.sha256, line_start: 1, line_end: 2 } });
    const first = await s1.recordQuestionExchange(input);
    await s1.stop();
    const s2 = await startCapture({ root, storeDir, now: () => 1000, resumeSessionId: s1.sessionId }, { platform: createFakePlatform() });
    try {
      const again = await s2.recordQuestionExchange(input);
      assert.deepEqual(again, { ...first, duplicate: true });
      assert.equal((await exchangeEvents(s2)).length, 1);
      const followUp = toExchange(input, { text: 'And then?', reply_to_question_id: first.question_id });
      assert.equal((await s2.recordQuestionExchange(followUp)).duplicate, false);
      assert.equal((await exchangeEvents(s2)).length, 2);
    } finally { await s2.stop(); }
  });
});

it('exchanges do not count against QUESTION_LIMIT', async () => {
  await fixture(async (s, input) => {
    for (let i = 0; i < 17; i += 1) await s.recordQuestionExchange({ ...input, request_id: randomUUID() });
    assert.equal((await exchangeEvents(s)).length, 17);
    const asks = await Promise.all(Array.from({ length: 16 }, () =>
      s.askQuestion({ session_id: input.session_id, request_id: randomUUID(), text: 'Q', context: input.context }, target)));
    assert.equal(asks.length, 16);
    await assert.rejects(s.askQuestion({ session_id: input.session_id, request_id: randomUUID(), text: 'Q', context: input.context }, target), { code: 'QUESTION_LIMIT' });
  });
});

it('follow-up to a recorded exchange needs identical context and a known exchange parent', async () => {
  await fixture(async (s, input) => {
    const first = await s.recordQuestionExchange(input);
    const followUp = { ...input, request_id: randomUUID(), text: 'And then?', reply_to_question_id: first.question_id };
    const accepted = await s.recordQuestionExchange(followUp);
    assert.equal(accepted.duplicate, false);
    await assert.rejects(s.recordQuestionExchange({ ...followUp, request_id: randomUUID(), context: { ...input.context, line_end: 1 } }), { code: 'INVALID_CONTEXT' });
    await assert.rejects(s.recordQuestionExchange({ ...followUp, request_id: randomUUID(), reply_to_question_id: randomUUID() }), { code: 'INVALID_CONTEXT' });
    const events = await exchangeEvents(s);
    assert.equal(events.length, 2);
    const second = events[1]!;
    assert.equal(second.type === 'slipstream.question.exchange_recorded.v1' && second.data.reply_to_question_id, first.question_id);
  });
});

it('an exchange replying to an ask question, and an ask replying to an exchange, are INVALID_CONTEXT', async () => {
  await fixture(async (s, input) => {
    const ask = await s.askQuestion({ session_id: input.session_id, request_id: randomUUID(), text: 'Q', context: input.context }, target);
    const exchange = await s.recordQuestionExchange(input);
    await assert.rejects(s.recordQuestionExchange({ ...input, request_id: randomUUID(), reply_to_question_id: ask.question_id }), { code: 'INVALID_CONTEXT' });
    await assert.rejects(s.askQuestion({ session_id: input.session_id, request_id: randomUUID(), text: 'Q2', context: input.context,
      reply_to_question_id: exchange.question_id }, target), { code: 'INVALID_CONTEXT' });
    assert.equal((await exchangeEvents(s)).length, 1);
  });
});

it('bad context (wrong hash, another change, out-of-range lines) is INVALID_CONTEXT and appends nothing', async () => {
  await fixture(async (s, input) => {
    const before = (await readRecords(s.logPath)).length;
    await assert.rejects(s.recordQuestionExchange({ ...input, context: { ...input.context, snapshot_sha256: 'f'.repeat(64) } }), { code: 'INVALID_CONTEXT' });
    await assert.rejects(s.recordQuestionExchange({ ...input, context: { ...input.context, change_seq: '1' } }), { code: 'INVALID_CONTEXT' });
    await assert.rejects(s.recordQuestionExchange({ ...input, context: { ...input.context, change_seq: '999999' } }), { code: 'INVALID_CONTEXT' });
    await assert.rejects(s.recordQuestionExchange({ ...input, context: { ...input.context, line_end: 50 } }), { code: 'INVALID_CONTEXT' });
    assert.equal((await readRecords(s.logPath)).length, before);
  });
});

it('a change whose after-content is unavailable is INVALID_CONTEXT and appends nothing', async () => {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const platform = createFakePlatform();
    const s = await startCapture({ root, storeDir: join(base, 'store'), now: () => 1000 }, { platform });
    try {
      await writeFile(join(root, 'b.ts'), 'x\n'); platform.observe('b.ts');
      await waitForRecords(s.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1'));
      await rm(join(root, 'b.ts')); platform.observe('b.ts');
      const gone = (await waitForRecords(s.logPath, r => r.filter(e => e.type === 'slipstream.file.changed.v1').length >= 2))
        .filter(e => e.type === 'slipstream.file.changed.v1')[1]!;
      assert.equal(gone.type, 'slipstream.file.changed.v1'); assert.notEqual(gone.data.after.kind, 'content');
      await waitDurable(s, gone.seq);
      const before = (await readRecords(s.logPath)).length;
      await assert.rejects(s.recordQuestionExchange(toExchange({ session_id: s.sessionId, request_id: randomUUID(), text: 'Why?',
        context: { change_seq: gone.seq, path: 'b.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1 } })), { code: 'INVALID_CONTEXT' });
      assert.equal((await readRecords(s.logPath)).length, before);
    } finally { await s.stop(); }
  });
});

it('an ambiguous append failure surfaces a storage error and a later identical retry is a duplicate of the one durable event', async () => {
  let fail = true;
  await fixture(async (s, input) => {
    await assert.rejects(s.recordQuestionExchange(input), StorageError);
    const deadline = Date.now() + 5000;
    while (s.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline, 'recovery completed');
      await new Promise(r => setTimeout(r, 10));
    }
    const retry = await s.recordQuestionExchange(input);
    assert.equal(retry.duplicate, true);
    assert.equal((await exchangeEvents(s)).length, 1);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      const event = await log.append(input);
      if (input.type === 'slipstream.question.exchange_recorded.v1' && fail) { fail = false; throw new StorageError('append', new Error('ambiguous after fsync')); }
      return event;
    } };
  } });
});

it('a torn failed append is not a duplicate: the retry records one event', async () => {
  let fail = true;
  await fixture(async (s, input) => {
    await assert.rejects(s.recordQuestionExchange(input), StorageError);
    const deadline = Date.now() + 5000;
    while (s.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline);
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await s.recordQuestionExchange(input)).duplicate, false);
    assert.equal((await exchangeEvents(s)).length, 1);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      if (input.type === 'slipstream.question.exchange_recorded.v1' && fail) {
        fail = false; await appendFile(opts.filePath, '{"type":"slipstream.question.exchange_recorded.v1","data":');
        throw new StorageError('append', new Error('torn write'));
      }
      return log.append(input);
    } };
  } });
});

it('session_id mismatch is SESSION_NOT_SELECTED', async () => {
  await fixture(async (s, input) => {
    await assert.rejects(s.recordQuestionExchange({ ...input, session_id: randomUUID() }), { code: 'SESSION_NOT_SELECTED' });
    assert.equal((await exchangeEvents(s)).length, 0);
  });
});

it('rejects after stop with CAPTURE_NOT_READY', async () => {
  await fixture(async (s, input) => {
    await s.stop();
    await assert.rejects(s.recordQuestionExchange(input), { code: 'CAPTURE_NOT_READY' });
  });
});

function gatedReader() {
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  return { started, release: () => release(),
    readQuestionContext: async (input: Parameters<typeof readQuestionContext>[0]) => { entered(); await gate; return readQuestionContext(input); } };
}

it('a conflicting retry sent while the first call is in flight is REQUEST_CONFLICT and one event is recorded', async () => {
  const gated = gatedReader();
  await fixture(async (s, input) => {
    const first = s.recordQuestionExchange(input);
    await gated.started;
    await assert.rejects(s.recordQuestionExchange({ ...input, answer_text: 'a different answer' }), { code: 'REQUEST_CONFLICT' });
    gated.release();
    assert.equal((await first).duplicate, false);
    assert.equal((await exchangeEvents(s)).length, 1);
  }, { readQuestionContext: gated.readQuestionContext });
});

it('a matching hash with a different path is INVALID_CONTEXT and appends nothing', async () => {
  await fixture(async (s, input) => {
    const before = (await readRecords(s.logPath)).length;
    await assert.rejects(s.recordQuestionExchange({ ...input, context: { ...input.context, path: 'other.ts' } }), { code: 'INVALID_CONTEXT' });
    assert.equal((await readRecords(s.logPath)).length, before);
  });
});

it('stop() while an exchange is in flight fails it with CAPTURE_NOT_READY and no exchange lands after the stop record', async () => {
  const gated = gatedReader();
  await fixture(async (s, input) => {
    const pending = s.recordQuestionExchange(input);
    const outcome = pending.then(() => 'recorded', (err: { code?: string }) => err.code);
    await gated.started;
    const stopping = s.stop({ reason: 'detached' });
    gated.release();
    await stopping;
    assert.equal(await outcome, 'CAPTURE_NOT_READY');
    const records = await readRecords(s.logPath);
    assert.equal(records.filter(e => e.type === 'slipstream.question.exchange_recorded.v1').length, 0);
    assert.equal(records.at(-1)!.type, 'slipstream.capture.stopped.v1');
  }, { readQuestionContext: gated.readQuestionContext });
});
