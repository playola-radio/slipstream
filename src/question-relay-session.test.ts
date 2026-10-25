import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { withTempDir, waitForRecords, readRecords } from './test/helpers.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';
import type { QuestionContext } from './questions.ts';

type Session = Awaited<ReturnType<typeof startCapture>>;
type Update = Record<string, unknown>;
interface Ctx {
  s: Session;
  context: QuestionContext;
  /** Records an exchange whose answer accepted a change request; returns its question and relay ids. */
  exchange: (withRelay?: boolean) => Promise<{ question_id: string; relay_id: string }>;
  update: (question_id: string, relay_id: string, update: Update, extra?: Record<string, unknown>) => Record<string, unknown>;
}

const RELAY_TYPE = 'slipstream.question.relay_updated.v1';
const CHAT = '5896f28c-f4a9-46c2-b481-7ca57e8714a8';
const relayEvents = async (s: Session) => (await readRecords(s.logPath)).filter(e => e.type === RELAY_TYPE);
const target = { harness: 'codex' as const, harness_session_id: 'main', worktree: '/tmp/example' };
const KINDS: Update[] = [{ kind: 'picked_up' }, { kind: 'not_delivered' },
  { kind: 'reported', outcome: 'done', text: 'Done. greet now returns "Hello, friend".' },
  { kind: 'reported', outcome: 'not_done_yet', text: 'Not yet.' }];

async function waitDurable(s: Session, seq: string): Promise<void> {
  while (BigInt(s.health.snapshot().durable_seq) < BigInt(seq)) await new Promise(r => setTimeout(r, 5));
}

async function startSeeded(root: string, storeDir: string, platform: ReturnType<typeof createFakePlatform>, deps: Parameters<typeof startCapture>[1] = {}) {
  const s = await startCapture({ root, storeDir, now: () => 1000 }, { platform, ...deps });
  await writeFile(join(root, 'a.ts'), 'one\ntwo\n'); platform.observe('a.ts');
  const ev = (await waitForRecords(s.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1'))).find(e => e.type === 'slipstream.file.changed.v1')!;
  assert.equal(ev.type, 'slipstream.file.changed.v1'); assert.equal(ev.data.after.kind, 'content');
  await waitDurable(s, ev.seq);
  const context: QuestionContext = { change_seq: ev.seq, path: 'a.ts', snapshot_sha256: ev.data.after.sha256, line_start: 1, line_end: 2 };
  return { s, context };
}

function ctxFor(s: Session, context: QuestionContext): Ctx {
  return {
    s, context,
    exchange: async (withRelay = true) => {
      const relay_id = randomUUID();
      const accepted = await s.recordQuestionExchange({ session_id: s.sessionId, request_id: randomUUID(), text: 'Change it?', context,
        answer_text: 'On it.', conversation: { harness: 'claude-code', parent_session_id: CHAT, fork_session_id: 'fork-1' },
        ...(withRelay ? { relay: { relay_id, chat_session_id: CHAT } } : {}) });
      return { question_id: accepted.question_id, relay_id };
    },
    update: (question_id, relay_id, update, extra = {}) => ({ session_id: s.sessionId, request_id: randomUUID(), question_id, relay_id, update, ...extra }),
  };
}

async function fixture(run: (ctx: Ctx) => Promise<void>, deps: Parameters<typeof startCapture>[1] = {}) {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const { s, context } = await startSeeded(await realpath(rawRoot), join(base, 'store'), createFakePlatform(), deps);
    try { await run(ctxFor(s, context)); } finally { await s.stop(); }
  });
}

it('eachKindAccepted: every update kind is appended with the documented reply', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const requests = [...KINDS.map(u => update(question_id, relay_id, u)), update(question_id, randomUUID(), { kind: 'sent', chat_session_id: CHAT })];
    for (const req of requests) {
      const accepted = await s.recordQuestionRelayUpdate(req);
      const event = (await relayEvents(s)).at(-1)!;
      assert.ok(event.type === RELAY_TYPE);
      assert.deepEqual(accepted, { session_id: s.sessionId, request_id: req.request_id, question_id, relay_id: req.relay_id,
        seq: event.seq, duplicate: false });
      assert.equal(event.subject, `question/${question_id}`);
      assert.deepEqual(event.data, { session_id: s.sessionId, question_id, relay_id: req.relay_id, request_id: req.request_id,
        update: req.update, recorded_at_ms: 1000 });
    }
    assert.equal((await relayEvents(s)).length, requests.length);
  });
});

it('sendAgainRegistersNewRelay: a sent update registers a new relay_id for later steps', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id } = await exchange();
    const again = randomUUID();
    await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, again, { kind: 'picked_up' })), { code: 'INVALID_RELAY_UPDATE' });
    await s.recordQuestionRelayUpdate(update(question_id, again, { kind: 'sent', chat_session_id: CHAT }));
    assert.equal((await s.recordQuestionRelayUpdate(update(question_id, again, { kind: 'picked_up' }))).duplicate, false);
  });
});

it('a later picked_up is accepted after an exchange with relay', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    assert.equal((await s.recordQuestionRelayUpdate(update(question_id, relay_id, { kind: 'picked_up' }))).duplicate, false);
  });
});

it('updatesInAnyOrderAreAppended: steps are recorded in arrival order with no order check', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const order: Update[] = [KINDS[2]!, KINDS[0]!, KINDS[1]!, KINDS[3]!, KINDS[0]!];
    for (const u of order) await s.recordQuestionRelayUpdate(update(question_id, relay_id, u));
    assert.deepEqual((await relayEvents(s)).map(e => e.type === RELAY_TYPE && e.data.update), order);
  });
});

it('concurrentUpdatesForOneRelayBothRecorded: two updates sent together are both recorded', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const results = await Promise.all([s.recordQuestionRelayUpdate(update(question_id, relay_id, KINDS[0]!)),
      s.recordQuestionRelayUpdate(update(question_id, relay_id, KINDS[2]!))]);
    assert.deepEqual(results.map(r => r.duplicate), [false, false]);
    assert.notEqual(results[0]!.seq, results[1]!.seq);
    assert.deepEqual((await relayEvents(s)).map(e => e.type === RELAY_TYPE && e.data.update.kind).sort(), ['picked_up', 'reported']);
  });
});

it('askQuestionRefused and unknownQuestionRefused: only a recorded exchange can carry relay updates', async () => {
  await fixture(async ({ s, context, update }) => {
    const ask = await s.askQuestion({ session_id: s.sessionId, request_id: randomUUID(), text: 'Q', context }, target);
    for (const question_id of [ask.question_id, randomUUID()]) {
      await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, randomUUID(), { kind: 'sent', chat_session_id: CHAT })),
        { code: 'INVALID_RELAY_UPDATE' });
    }
    assert.equal((await relayEvents(s)).length, 0);
  });
});

it('unknownRelayRefused: a step other than sent for a relay never sent is refused', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id } = await exchange(false);
    for (const u of KINDS) {
      await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, randomUUID(), u)), { code: 'INVALID_RELAY_UPDATE' });
    }
    assert.equal((await relayEvents(s)).length, 0);
  });
});

it('relayIDOfOtherQuestionRefused: a relay_id is bound to the question that sent it', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const first = await exchange();
    const second = await exchange();
    await assert.rejects(s.recordQuestionRelayUpdate(update(second.question_id, first.relay_id, { kind: 'picked_up' })),
      { code: 'INVALID_RELAY_UPDATE' });
    assert.equal((await relayEvents(s)).length, 0);
  });
});

it('reusedRelayIDOnSentRefused: a sent reusing a recorded or in-flight relay_id is refused', async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const reachedAppend = new Promise<void>(r => { entered = r; });
  try {
    await fixture(async ({ s, exchange, update }) => {
      const { question_id, relay_id } = await exchange();
      const sent = { kind: 'sent', chat_session_id: CHAT };
      await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, relay_id, sent)), { code: 'INVALID_RELAY_UPDATE' });
      const again = randomUUID();
      const first = s.recordQuestionRelayUpdate(update(question_id, again, sent));
      await reachedAppend;
      await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, again, sent)), { code: 'INVALID_RELAY_UPDATE' });
      await assert.rejects(s.recordQuestionExchange({ session_id: s.sessionId, request_id: randomUUID(), text: 'Q', context: (await relayContext(s))!,
        answer_text: 'On it.', conversation: { harness: 'claude-code', parent_session_id: CHAT, fork_session_id: 'fork-1' },
        relay: { relay_id: again, chat_session_id: CHAT } }), { code: 'INVALID_RELAY_UPDATE' });
      release();
      assert.equal((await first).duplicate, false);
      await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, again, sent)), { code: 'INVALID_RELAY_UPDATE' });
      assert.equal((await relayEvents(s)).length, 1);
    }, { createLog: async opts => {
      const log = await createLog(opts);
      return { ...log, append: async input => {
        if (input.type === RELAY_TYPE) { entered(); await gate; }
        return log.append(input);
      } };
    } });
  } finally { release(); }
});

async function relayContext(s: Session): Promise<QuestionContext | undefined> {
  const exchange = (await readRecords(s.logPath)).find(e => e.type === 'slipstream.question.exchange_recorded.v1');
  if (exchange?.type !== 'slipstream.question.exchange_recorded.v1') return undefined;
  const { selected_text: _selected, ...context } = exchange.data.context;
  return context;
}

it('a sent whose append failed cleanly leaves its relay_id free', async () => {
  let fail = true;
  await fixture(async ({ s, exchange, update }) => {
    const { question_id } = await exchange();
    const again = randomUUID();
    const sent = { kind: 'sent', chat_session_id: CHAT };
    await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, again, sent)), StorageError);
    const deadline = Date.now() + 5000;
    while (s.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline);
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await s.recordQuestionRelayUpdate(update(question_id, again, sent))).duplicate, false);
    assert.equal((await relayEvents(s)).length, 1);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      if (input.type === RELAY_TYPE && fail) { fail = false; throw new StorageError('append', new Error('nothing written')); }
      return log.append(input);
    } };
  } });
});

it('idempotentRetryReturnsDuplicate: a retry with the same body returns the original result, settled and concurrent', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const req = update(question_id, relay_id, KINDS[2]!);
    const concurrent = await Promise.all([s.recordQuestionRelayUpdate(req), s.recordQuestionRelayUpdate(req)]);
    assert.deepEqual(concurrent.map(r => r.duplicate).sort(), [false, true]);
    const original = concurrent.find(r => !r.duplicate)!;
    assert.deepEqual(await s.recordQuestionRelayUpdate(req), { ...original, duplicate: true });
    const sentReq = update(question_id, randomUUID(), { kind: 'sent', chat_session_id: CHAT });
    const sent = await s.recordQuestionRelayUpdate(sentReq);
    assert.deepEqual(await s.recordQuestionRelayUpdate(sentReq), { ...sent, duplicate: true }, 'a retried sent is not a reused relay_id');
    assert.equal((await relayEvents(s)).length, 2);
  });
});

it('differentBodyIsRequestConflict: a request_id reused with a different body is REQUEST_CONFLICT; ids are scoped to the verb', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const req = update(question_id, relay_id, KINDS[2]!);
    await s.recordQuestionRelayUpdate(req);
    for (const changed of [{ update: KINDS[0] }, { update: { ...KINDS[2], text: 'Something else.' } },
      { update: { ...KINDS[2], outcome: 'not_done_yet' } }]) {
      await assert.rejects(s.recordQuestionRelayUpdate({ ...req, ...changed }), { code: 'REQUEST_CONFLICT' });
    }
    const exchangeRequest = (await readRecords(s.logPath)).find(e => e.type === 'slipstream.question.exchange_recorded.v1')!;
    assert.ok(exchangeRequest.type === 'slipstream.question.exchange_recorded.v1');
    const scoped = await s.recordQuestionRelayUpdate({ ...update(question_id, relay_id, KINDS[0]!), request_id: exchangeRequest.data.request_id });
    assert.equal(scoped.duplicate, false);
    assert.equal((await relayEvents(s)).length, 2);
  });
});

it('whitespaceReportTextIsProtocol: a report whose text is only whitespace is PROTOCOL', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, relay_id, { kind: 'reported', outcome: 'done', text: ' \n\t' })),
      { code: 'PROTOCOL' });
    const padded = '  Done.\n';
    await s.recordQuestionRelayUpdate(update(question_id, relay_id, { kind: 'reported', outcome: 'done', text: padded }));
    const [event] = await relayEvents(s);
    assert.ok(event?.type === RELAY_TYPE && event.data.update.kind === 'reported');
    assert.equal(event.data.update.text, padded, 'report text is stored verbatim');
  });
});

it('malformed relay updates are PROTOCOL and append nothing', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const bad: Array<Record<string, unknown>> = [
      update(question_id, relay_id, { kind: 'reported', outcome: 'done', text: '' }),
      update(question_id, relay_id, { kind: 'reported', outcome: 'done' }),
      update(question_id, relay_id, { kind: 'reported', outcome: 'maybe', text: 'x' }),
      update(question_id, relay_id, { kind: 'reported', outcome: 'done', text: '\uD800' }),
      update(question_id, relay_id, { kind: 'started' }),
      update(question_id, relay_id, { kind: 'sent' }),
      update(question_id, relay_id, { kind: 'sent', chat_session_id: '' }),
      update(question_id, relay_id, { kind: 'sent', chat_session_id: 'x'.repeat(257) }),
      update(question_id, relay_id, { kind: 'sent', chat_session_id: 'a\u0007b' }),
      update(question_id, relay_id, 'picked_up' as unknown as Update),
      update(question_id, relay_id.toUpperCase(), { kind: 'picked_up' }),
      update(question_id.toUpperCase(), relay_id, { kind: 'picked_up' }),
      update(question_id, relay_id, { kind: 'picked_up' }, { request_id: 'not-a-uuid' }),
      { session_id: s.sessionId, request_id: randomUUID(), relay_id, update: { kind: 'picked_up' } },
      { session_id: s.sessionId },
    ];
    for (const req of bad) await assert.rejects(s.recordQuestionRelayUpdate(req), { code: 'PROTOCOL' }, JSON.stringify(req));
    assert.equal((await relayEvents(s)).length, 0);
  });
});

it('relayUpdatedAddsNoDispatchOrQueueCount: updates append only their own event and leave the ask queue limit alone', async () => {
  await fixture(async ({ s, context, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    const before = (await readRecords(s.logPath)).map(e => e.seq);
    for (let i = 0; i < 17; i += 1) await s.recordQuestionRelayUpdate(update(question_id, relay_id, KINDS[0]!));
    const added = (await readRecords(s.logPath)).filter(e => !before.includes(e.seq) && e.type !== 'slipstream.change.attribution.v1');
    assert.deepEqual([...new Set(added.map(e => e.type))], [RELAY_TYPE]);
    const asks = await Promise.all(Array.from({ length: 16 }, () =>
      s.askQuestion({ session_id: s.sessionId, request_id: randomUUID(), text: 'Q', context }, target)));
    assert.equal(asks.length, 16);
    await assert.rejects(s.askQuestion({ session_id: s.sessionId, request_id: randomUUID(), text: 'Q', context }, target),
      { code: 'QUESTION_LIMIT' });
  });
});

it('session_id mismatch is SESSION_NOT_SELECTED and a stopped capture is CAPTURE_NOT_READY', async () => {
  await fixture(async ({ s, exchange, update }) => {
    const { question_id, relay_id } = await exchange();
    await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, relay_id, KINDS[0]!, { session_id: randomUUID() })),
      { code: 'SESSION_NOT_SELECTED' });
    await s.stop();
    await assert.rejects(s.recordQuestionRelayUpdate(update(question_id, relay_id, KINDS[0]!)), { code: 'CAPTURE_NOT_READY' });
  });
});

it('relay registry and relay update request ids survive a session restart', async () => {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const storeDir = join(base, 'store');
    const { s: s1, context } = await startSeeded(root, storeDir, createFakePlatform());
    const c1 = ctxFor(s1, context);
    const { question_id, relay_id } = await c1.exchange();
    const again = randomUUID();
    await s1.recordQuestionRelayUpdate(c1.update(question_id, again, { kind: 'sent', chat_session_id: CHAT }));
    const req = c1.update(question_id, relay_id, KINDS[0]!);
    const first = await s1.recordQuestionRelayUpdate(req);
    await s1.stop();
    const s2 = await startCapture({ root, storeDir, now: () => 1000, resumeSessionId: s1.sessionId }, { platform: createFakePlatform() });
    try {
      assert.deepEqual(await s2.recordQuestionRelayUpdate(req), { ...first, duplicate: true });
      await assert.rejects(s2.recordQuestionRelayUpdate({ ...req, update: KINDS[1] }), { code: 'REQUEST_CONFLICT' });
      const c2 = ctxFor(s2, context);
      assert.equal((await s2.recordQuestionRelayUpdate(c2.update(question_id, again, KINDS[2]!))).duplicate, false);
      for (const reused of [relay_id, again]) {
        await assert.rejects(s2.recordQuestionRelayUpdate(c2.update(question_id, reused, { kind: 'sent', chat_session_id: CHAT })),
          { code: 'INVALID_RELAY_UPDATE' });
      }
      assert.equal((await relayEvents(s2)).length, 3);
    } finally { await s2.stop(); }
  });
});
