import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, stat, rename, realpath, symlink, readFile, readdir, utimes, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon, DaemonAlreadyRunningError, type Daemon } from './daemon.ts';
import { blobPath, sessionLogPath, tombstonePath, findWorkspaceSession, WorkspaceLookupError } from './store-reader.ts';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { createLog } from './log.ts';
import { createCas } from './cas.ts';
import { claudePostToolUse } from './question-hook.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import type { Platform, Subscription, WatchOptions } from './platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import type { PublicEventInput } from './public-events.ts';

const IDENTITY = { harness: 'claude-code', harness_session_id: 'abc123' };
const ASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASK_REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASK_CONTEXT = {
  change_seq: '1', path: 'src/example.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
};

/** Read a field off a response envelope. Ok responses carry open-ended fields
 * that the typed union does not enumerate; a test reads them positionally. */
function rec(res: ResponseEnvelope): Record<string, string> {
  return res as unknown as Record<string, string>;
}

/** A control request without the protocol version the harness adds. */
type CallRequest = { verb: string; [key: string]: unknown };
type Call = (req: CallRequest) => Promise<ResponseEnvelope>;

/** A control caller that behaves like the CLI: a chat attach that finds its
 * workspace's capture still queued or baselining polls `status` and resubmits
 * the same attach once the capture is recording (contracts.md §5). */
function controlCall(socketPath: string, responseTimeoutMs = 5000): Call {
  const send: Call = (req) => sendControlRequest({ socketPath, request: { v: 1 as const, ...req }, responseTimeoutMs });
  return async (req) => {
    let res = await send(req);
    const chatAttach = req.verb === 'attach' && req.mode === undefined;
    for (let i = 0; chatAttach && res.ok && rec(res).binding_generation === undefined
      && ['queued', 'baselining'].includes(rec(res).state!) && i < 200; i++) {
      const row = rec(await send({ verb: 'status', target: rec(res).session_id })).capture as unknown as Record<string, string>;
      if (row.state !== 'queued' && row.state !== 'baselining') res = await send(req);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return res;
  };
}

/** One capture's status row. */
async function captureRow(call: Call, target: string): Promise<Record<string, unknown>> {
  const res = await call({ verb: 'status', target });
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res as unknown as { capture: Record<string, unknown> }).capture;
}

/** Poll one capture until `done` holds for its status row. */
async function waitForRow(call: Call, target: string, done: (row: Record<string, unknown>) => boolean,
  what = 'the expected capture state'): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const row = await captureRow(call, target);
    if (done(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`capture ${target} never reached ${what}: ${JSON.stringify(await captureRow(call, target))}`);
}

/** Attach a workspace with no chat and wait until it records. */
async function attachWatchOnly(call: Call, worktree: string): Promise<string> {
  const res = await call({ verb: 'attach', mode: 'watch-only', worktree });
  assert.equal(res.ok, true, JSON.stringify(res));
  const id = rec(res).session_id!;
  await waitForRow(call, id, (row) => row.state === 'recording', 'recording');
  return id;
}

/** The binding block of one capture's status row. */
async function bindingOf(call: Call, target: string): Promise<Record<string, unknown> | null> {
  return (await captureRow(call, target)).binding as Record<string, unknown> | null;
}

/** Complete the bound chat's setup round trip so the capture admits questions. */
async function connectAgent(call: Call, claim: CallRequest): Promise<void> {
  const check = (rec(await call(claim)) as unknown as { setup_check?: { check_id: string } }).setup_check;
  assert.ok(check, 'expected a setup check');
  const { harness, harness_session_id, worktree } = claim;
  const ack = await call({ verb: 'answer_question', harness, harness_session_id, worktree, question_id: check.check_id, text: 'connected' });
  assert.equal(ack.ok, true);
}

/** Attach `IDENTITY` through a verified Claude root transcript and connect it. */
async function attachConnected(call: Call, worktree: string, store: string): Promise<ResponseEnvelope> {
  const transcript = join(store, 'abc123.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: IDENTITY.harness_session_id, cwd: await realpath(worktree),
    version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
  const attached = await call({ verb: 'attach', worktree, ...IDENTITY, root_transcript: transcript });
  assert.equal(attached.ok, true);
  await connectAgent(call, { verb: 'claim_question', ...IDENTITY, worktree, transcript_path: transcript });
  return attached;
}

/** A daemon over throwaway store + worktree dirs, with capture driven by the fake
 * platform so no real FSEvents watcher runs. */
async function withDaemon(
  fn: (ctx: {
    daemon: Daemon;
    worktree: string;
    store: string;
    call: (req: CallRequest) => Promise<ResponseEnvelope>;
  }) => Promise<void>,
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-wt-'));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    const d = daemon;
    await fn({
      daemon: d,
      worktree,
      store,
      call: controlCall(d.socketPath),
    });
  } finally {
    await daemon?.stop();
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
}

describe('daemon control verbs', () => {
  for (const [version, entrypoint] of [
    ['2.1.283', 'sdk-cli'], ['2.1.280', 'sdk-ts'], ['2.1.284', 'sdk-ts'],
  ] as const) it(`attaches only to the verified Claude ${version}/${entrypoint} root and lets only that root claim once`, async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-wt-'));
    const otherWorktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-other-'));
    const transcript = join(store, 'root.jsonl');
    const otherTranscript = join(store, 'other.jsonl');
    const meta = (id = 'root') => JSON.stringify({ type: 'user', sessionId: id, cwd: worktree,
      version, entrypoint, userType: 'external', isSidechain: false }) + '\n';
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'selected',
    } });
    const call = controlCall(daemon.socketPath);
    try {
      const attachReq = { verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript };
      const missing = await call(attachReq);
      assert.equal(missing.ok === false && missing.code, 'IDENTITY_UNRESOLVED');
      await writeFile(transcript, JSON.stringify({ type: 'queue-operation', sessionId: 'root' }) + '\n');
      const preamble = await call(attachReq);
      assert.equal(preamble.ok === false && preamble.code, 'IDENTITY_UNRESOLVED');
      await writeFile(transcript, JSON.stringify({ type: 'queue-operation', sessionId: 'root' }) + '\n' + meta() + '{"sessionId":"other"');
      const torn = await call(attachReq);
      assert.equal(torn.ok === false && torn.code, 'IDENTITY_UNRESOLVED');
      assert.match(torn.ok === false ? torn.message : '', /retry attach/);
      assert.deepEqual(rec(await call({ verb: 'status' })).captures, [], 'a chat that cannot be verified records nothing');
      await writeFile(transcript, JSON.stringify({ type: 'queue-operation', sessionId: 'root' }) + '\n' + meta());
      await writeFile(otherTranscript, meta('other'));
      const attached = await call(attachReq);
      assert.equal(attached.ok, true);
      const captureId = rec(attached).session_id!;
      assert.equal((await bindingOf(call, captureId))?.root_transcript, await realpath(transcript));
      const identity = { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript };
      await connectAgent(call, identity);
      const ask = await call({ verb: 'ask', session_id: captureId, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      assert.equal(ask.ok, true);
      const negatives = [
        { ...identity, agent_id: null }, { ...identity, agent_type: null },
        { ...identity, agent_id: 'child', agent_type: 'general-purpose' },
        { ...identity, agent_id: '' }, { ...identity, agent_type: '' },
        { ...identity, harness: 'codex' }, { ...identity, harness_session_id: 'other' },
        { ...identity, worktree: otherWorktree }, { ...identity, transcript_path: otherTranscript },
      ];
      for (const bad of negatives) assert.equal((await call(bad)).ok, false);
      const claims = await Promise.all(Array.from({ length: 8 }, () => call(identity)));
      const delivered = claims.filter(r => r.ok && rec(r).question !== null);
      assert.equal(delivered.length, 1);
      assert.equal((rec(delivered[0]!).question as unknown as Record<string, unknown>).question_id, rec(ask).question_id);
      assert.equal(rec(await call(identity)).question, null);
      const events = (await readFile(sessionLogPath(store, captureId), 'utf8')).trim().split('\n').map(s => JSON.parse(s) as { type: string; data: { question_id?: string } });
      const attempts = events.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1');
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.data.question_id, rec(ask).question_id);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      assert.equal((await call(identity)).ok, false);
      const captureOnly = await call({ verb: 'attach', mode: 'watch-only', worktree });
      assert.equal(captureOnly.ok, true);
      const unbound = await call({ verb: 'ask', session_id: rec(captureOnly).session_id, request_id: ASK_REQUEST,
        text: 'Why?', context: ASK_CONTEXT });
      assert.equal(unbound.ok === false && unbound.code, 'AGENT_NOT_CONNECTED');
      assert.equal((await call(identity)).ok, false);
    } finally {
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(otherWorktree, { recursive: true, force: true });
    }
  });

  it('rejects a Claude claim when the selected capture changes while callback paths resolve', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-race-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-race-wt-'));
    const transcript = join(store, 'root.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'root', cwd: worktree,
      version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
    let hold = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const daemon = await startDaemon({ storeDir: store, identityRealpath: async path => {
      if (hold && path === worktree) { hold = false; entered(); await held; }
      return realpath(path);
    }, captureDependencies: { platform: createFakePlatform(), enumerate: async () => {},
      readQuestionContext: async () => 'selected' } });
    const call = controlCall(daemon.socketPath);
    const attach = { verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript };
    const claim = { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript };
    try {
      const first = await call(attach);
      assert.equal(first.ok, true);
      await connectAgent(call, claim);
      assert.equal((await call({ verb: 'ask', session_id: rec(first).session_id, request_id: ASK_REQUEST,
        text: 'Why?', context: ASK_CONTEXT })).ok, true);
      hold = true;
      const stale = call(claim);
      await Promise.race([entering, new Promise((_, reject) => setTimeout(() => reject(new Error('claim did not enter path resolution')), 1000))]);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      const second = await call(attach);
      assert.equal(second.ok, true);
      await connectAgent(call, claim);
      assert.equal((await call({ verb: 'ask', session_id: rec(second).session_id, request_id: ASK_REQUEST,
        text: 'Why?', context: ASK_CONTEXT })).ok, true);
      release();
      const result = await stale;
      assert.equal(result.ok === false && result.code, 'SESSION_NOT_SELECTED');
      assert.equal((await call(claim)).ok, true);
      const oldEvents = (await readFile(sessionLogPath(store, rec(first).session_id!), 'utf8')).trim().split('\n')
        .map(s => JSON.parse(s) as { type: string });
      assert.equal(oldEvents.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1').length, 0);
    } finally {
      release();
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('records an answer only from the selected harness session, after dispatch', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-answer-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-answer-wt-'));
    const otherWorktree = await mkdtemp(join(tmpdir(), 'slip-daemon-answer-other-'));
    const linked = join(store, 'linked-worktree');
    await symlink(worktree, linked);
    const transcript = join(store, 'root.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'root', cwd: worktree,
      version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'selected',
    } });
    const call = controlCall(daemon.socketPath);
    const codeOf = async (req: CallRequest) => { const res = await call(req); return res.ok === false ? res.code : 'ok'; };
    try {
      const answer = { verb: 'answer_question', harness: 'claude-code', harness_session_id: 'root', worktree: linked, text: 'Because.' };
      assert.equal(await codeOf({ ...answer, harness: undefined, question_id: ASK_ID }), 'IDENTITY_UNRESOLVED');
      assert.equal(await codeOf({ ...answer, question_id: ASK_ID }), 'SESSION_NOT_SELECTED');
      const attached = await call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript });
      assert.equal(attached.ok, true);
      const captureId = rec(attached).session_id!;
      await connectAgent(call, { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript });
      const ask = await call({ verb: 'ask', session_id: captureId, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      const id = rec(ask).question_id!;
      assert.equal(await codeOf({ ...answer, question_id: id }), 'QUESTION_NOT_FOUND');
      assert.equal((await call({ verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree,
        transcript_path: transcript })).ok, true);
      for (const [bad, code] of [
        [{ harness: undefined }, 'IDENTITY_UNRESOLVED'], [{ harness_session_id: '' }, 'IDENTITY_UNRESOLVED'],
        [{ worktree: 7 }, 'IDENTITY_UNRESOLVED'],
        [{ harness: 'codex' }, 'SESSION_NOT_SELECTED'], [{ harness_session_id: 'other' }, 'SESSION_NOT_SELECTED'],
        [{ worktree: otherWorktree }, 'SESSION_NOT_SELECTED'], [{ worktree: join(store, 'missing') }, 'SESSION_NOT_SELECTED'],
        [{ text: ' \n\t' }, 'INVALID_ANSWER'], [{ text: 'x'.repeat(16385) }, 'INVALID_ANSWER'],
        [{ question_id: ASK_ID }, 'QUESTION_NOT_FOUND'],
      ] as Array<[Record<string, unknown>, string]>) {
        assert.equal(await codeOf({ ...answer, question_id: id, ...bad }), code, JSON.stringify(Object.keys(bad)));
      }
      const accepted = await call({ ...answer, question_id: id });
      assert.equal(accepted.ok, true);
      const fields = rec(accepted);
      assert.deepEqual({ ...fields, answered_at_ms: undefined }, { v: 1, ok: true, session_id: captureId, question_id: id,
        event_id: fields.seq, seq: fields.seq, answered_at_ms: undefined, duplicate: false });
      assert.equal(typeof fields.answered_at_ms, 'number');
      assert.deepEqual(rec(await call({ ...answer, question_id: id })), { ...fields, duplicate: true });
      assert.equal(await codeOf({ ...answer, question_id: id, text: 'Something else.' }), 'ANSWER_CONFLICT');
      const events = (await readFile(sessionLogPath(store, captureId), 'utf8')).trim().split('\n')
        .map(s => JSON.parse(s) as { type: string; seq: string; data: { text?: string } });
      const answered = events.filter(e => e.type === 'slipstream.question.answered.v1');
      assert.deepEqual(answered.map(e => [e.seq, e.data.text]), [[fields.seq, 'Because.']]);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      assert.equal(await codeOf({ ...answer, question_id: id }), 'SESSION_NOT_SELECTED');
    } finally {
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(otherWorktree, { recursive: true, force: true });
    }
  });

  it('rejects an answer when the selected capture changes while its worktree resolves', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-answer-race-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-answer-race-wt-'));
    const transcript = join(store, 'root.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'root', cwd: worktree,
      version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
    let hold = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const daemon = await startDaemon({ storeDir: store, identityRealpath: async path => {
      if (hold && path === worktree) { hold = false; entered(); await held; }
      return realpath(path);
    }, captureDependencies: { platform: createFakePlatform(), enumerate: async () => {},
      readQuestionContext: async () => 'selected' } });
    const call = controlCall(daemon.socketPath);
    const attach = { verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript };
    const claim = { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript };
    try {
      const first = await call(attach);
      await connectAgent(call, claim);
      const ask = await call({ verb: 'ask', session_id: rec(first).session_id, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      assert.equal(ask.ok, true);
      assert.equal((await call(claim)).ok, true);
      const answer = { verb: 'answer_question', harness: 'claude-code', harness_session_id: 'root', worktree,
        question_id: rec(ask).question_id, text: 'Because.' };
      hold = true;
      const stale = call(answer);
      await Promise.race([entering, new Promise((_, reject) => setTimeout(() => reject(new Error('answer did not enter path resolution')), 1000))]);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      assert.equal((await call(attach)).ok, true);
      release();
      const result = await stale;
      assert.equal(result.ok === false && result.code, 'SESSION_NOT_SELECTED');
      // The stale answer wrote nothing, so this first accepted answer is not a duplicate
      // replay. An attempted question keeps its answer handling across a resume.
      const retried = await call(answer);
      assert.equal(retried.ok, true);
      assert.equal((retried as unknown as { duplicate?: boolean }).duplicate, false);
      const events = (await readFile(sessionLogPath(store, rec(first).session_id!), 'utf8')).trim().split('\n')
        .map(s => JSON.parse(s) as { type: string });
      assert.equal(events.filter(e => e.type === 'slipstream.question.answered.v1').length, 1);
    } finally {
      release();
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('delivers a maximal accepted question verbatim through queue, durable attempt, and the Claude hook', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-max-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claude-max-wt-'));
    const transcript = join(store, 'root.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'root', cwd: worktree,
      version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
    const selected = '€'.repeat(5461) + 'x';
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => selected,
    } });
    const call = controlCall(daemon.socketPath);
    try {
      const attached = await call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript });
      assert.equal(attached.ok, true);
      await connectAgent(call, { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript });
      // Synthetic protocol-boundary path: the widest accepted path with the widest JSON escaping.
      const path = '\u0001'.repeat(4096);
      const ask = await call({ verb: 'ask', session_id: rec(attached).session_id, request_id: ASK_REQUEST, text: 'Q'.repeat(8192),
        context: { ...ASK_CONTEXT, path, line_start: 1, line_end: 200 } });
      assert.equal(ask.ok, true);
      const id = rec(ask).question_id;
      const output = await claudePostToolUse({ hook_event_name: 'PostToolUse', session_id: 'root', cwd: worktree,
        transcript_path: transcript }, store);
      const context = JSON.parse(output!).hookSpecificOutput.additionalContext as string;
      assert.ok(Buffer.byteLength(context) <= 32 * 1024);
      assert.ok(context.includes(`BEGIN SOURCE PATH ${id}\n${path}\nEND SOURCE PATH ${id}\n`));
      assert.ok(context.endsWith(`\nBEGIN SELECTED SOURCE ${id}\n${selected}\nEND SELECTED SOURCE ${id}\nReturn your answer by calling the slipstream_answer_question tool with question_id ${id} and your complete answer as text. A chat reply alone does not reach the user.`));
      const events = (await readFile(sessionLogPath(store, rec(attached).session_id!), 'utf8')).trim().split('\n')
        .map(s => JSON.parse(s) as { type: string; data: { question_id?: string } });
      assert.deepEqual(events.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1').map(e => e.data.question_id), [id]);
    } finally {
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('binds a Codex root transcript and refuses child, other chat, Claude, or absent identity claims', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-claim-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claim-wt-'));
    const rootTranscript = join(store, 'root.jsonl');
    const otherTranscript = join(store, 'other.jsonl');
    const rootMeta = (version: string, session = 'root') => JSON.stringify({ type: 'session_meta', payload: {
      session_id: session, cwd: worktree, originator: 'codex_sdk_ts', source: 'exec', cli_version: version,
    } }) + '\n';
    await writeFile(rootTranscript, rootMeta('0.154.0')); await writeFile(otherTranscript, rootMeta('0.154.0', 'other'));
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'selected',
    } });
    const call = controlCall(daemon.socketPath);
    try {
      await writeFile(rootTranscript, rootMeta('9.9.9'));
      const unsupported = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(unsupported.ok === false && unsupported.code, 'IDENTITY_UNRESOLVED');
      const missing = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: join(store, 'missing.jsonl') });
      assert.equal(missing.ok === false && missing.code, 'IDENTITY_UNRESOLVED');
      const wrongHarness = await call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(wrongHarness.ok === false && wrongHarness.code, 'IDENTITY_UNRESOLVED');
      await writeFile(rootTranscript, rootMeta('0.154.0', 'different-chat'));
      const mismatch = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(mismatch.ok === false && mismatch.code, 'IDENTITY_UNRESOLVED');
      await writeFile(rootTranscript, rootMeta('0.154.0'));
      const attach = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(attach.ok, true);
      const session_id = rec(attach).session_id!;
      assert.equal((await bindingOf(call, session_id))?.root_transcript, await realpath(rootTranscript));
      const identity = { verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: rootTranscript };
      await connectAgent(call, identity);
      assert.equal((await call({ verb: 'ask', session_id, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT })).ok, true);
      for (const bad of [
        { ...identity, agent_id: null }, { ...identity, agent_type: '' },
        { ...identity, transcript_path: otherTranscript }, { ...identity, harness_session_id: 'second-chat' },
        { ...identity, worktree: store },
        { ...identity, harness: 'claude-code' }, { ...identity, transcript_path: undefined },
      ]) assert.equal((await call(bad)).ok, false);
      const accepted = await call(identity);
      assert.equal(accepted.ok, true);
      assert.equal((rec(accepted).question as unknown as Record<string, unknown>).question_id,
        rec(await call({ verb: 'ask', session_id, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT })).question_id);
      assert.equal(rec(await call(identity)).question, null);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      assert.equal((await call(identity)).ok, false);
    } finally { await daemon.stop(); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('does not carry an unattempted question across a resume after daemon restart', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-claim-restart-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-claim-restart-wt-'));
    const transcript = join(store, 'root.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: {
      session_id: 'root', cwd: worktree, originator: 'codex_sdk_ts', source: 'exec', cli_version: '0.154.0',
    } }) + '\n');
    const deps = { platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'selected' };
    let daemon = await startDaemon({ storeDir: store, captureDependencies: deps });
    try {
      const call = controlCall(daemon.socketPath);
      const attach = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: transcript });
      assert.equal(attach.ok, true);
      const oldId = rec(attach).session_id;
      await connectAgent(call, { verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: transcript });
      assert.equal((await call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT })).ok, true);
      await daemon.stop();
      daemon = await startDaemon({ storeDir: store, captureDependencies: { ...deps, platform: createFakePlatform() } });
      const again = controlCall(daemon.socketPath);
      const fresh = await again({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: transcript });
      assert.equal(rec(fresh).session_id, oldId);
      await connectAgent(again, { verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: transcript });
      const claim = await again({ verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: transcript });
      assert.equal(claim.ok, true);
      assert.equal(rec(claim).question, null);
    } finally { await daemon.stop().catch(() => {}); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });
  it('reports an empty capture table and a reader url before any attach', async () => {
    await withDaemon(async ({ daemon, call }) => {
      const res = await call({ verb: 'status' });
      assert.equal(res.ok, true);
      assert.deepEqual(rec(res).captures, []);
      assert.deepEqual(rec(res).binding_slots, { used: 0, limit: 10 });
      assert.equal(rec(res).reader_url, daemon.readerUrl);
    });
  });

  it('attaches under a fresh session id and reports it recording with its linked chat', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const attach = await attachConnected(call, worktree, store);
      const id = rec(attach).session_id!;
      assert.match(id, /^[0-9a-f-]{36}$/);
      const row = await captureRow(call, id);
      assert.equal(row.state, 'recording');
      assert.equal(row.session_id, id);
      // The root is reported canonicalized to the directory capture actually
      // watches, so a symlinked or relative declared path resolves to the same one.
      assert.equal(row.root, await realpath(worktree));
      const binding = row.binding as Record<string, unknown>;
      assert.equal(binding.harness, IDENTITY.harness);
      assert.equal(binding.harness_session_id, IDENTITY.harness_session_id);
      assert.equal(binding.state, 'connected');
    });
  });

  it('resumes the same session id when the same chat re-attaches the same workspace', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const idA = rec(await attachConnected(call, worktree, store)).session_id;
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      const b = await attachConnected(call, worktree, store);
      assert.equal(rec(b).session_id, idA);
      assert.equal(rec(b).already_active, undefined);
    });
  });

  it('fails attachment closed when the identity is incomplete', async () => {
    await withDaemon(async ({ worktree, call }) => {
      for (const partial of [
        { worktree, harness: 'claude-code', harness_session_id: '' },
        { worktree, harness: '', harness_session_id: 'abc' },
        { harness: 'claude-code', harness_session_id: 'abc' }, // no worktree
        { worktree, harness: 'claude-code', harness_session_id: 'abc' }, // no root transcript
      ]) {
        const res = await call({ verb: 'attach', ...partial });
        assert.equal(res.ok === false && res.code, 'IDENTITY_UNRESOLVED');
      }
      assert.deepEqual(rec(await call({ verb: 'status' })).captures, []);
    });
  });

  it('reports the existing capture when the same identity attaches again', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const first = await attachConnected(call, worktree, store);
      const res = await call({ verb: 'attach', worktree, ...IDENTITY, root_transcript: join(store, 'abc123.jsonl') });
      assert.equal(rec(res).session_id, rec(first).session_id);
      assert.equal(rec(res).already_active, true);
      assert.equal(rec(res).binding_generation, rec(first).binding_generation);
    });
  });

  it('declares a task on the linked capture and advances the durable seq', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      const before = await captureRow(call, id);
      const res = await call({ verb: 'begin_task', title: 'Fix login', request_id: 'req-1', worktree, ...IDENTITY });
      assert.equal(res.ok, true);
      assert.ok(rec(res).task_id);
      const after = await captureRow(call, id);
      assert.ok(BigInt(after.durable_seq as string) > BigInt(before.durable_seq as string));
    });
  });

  it('is idempotent per request_id (a retry replays the same task)', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      await attachConnected(call, worktree, store);
      const first = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup', worktree, ...IDENTITY });
      const second = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup', worktree, ...IDENTITY });
      assert.equal(rec(first).task_id, rec(second).task_id);
    });
  });

  it('maps an empty title to INVALID_TITLE', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      await attachConnected(call, worktree, store);
      const res = await call({ verb: 'begin_task', title: '', request_id: 'r', worktree, ...IDENTITY });
      assert.equal(res.ok === false && res.code, 'INVALID_TITLE');
    });
  });

  it('refuses begin_task carrying a session id or generation that is not the chat\'s link', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const attached = await attachConnected(call, worktree, store);
      const task = { verb: 'begin_task', title: 'T', request_id: 'r', worktree, ...IDENTITY };
      const wrongSession = await call({ ...task, session_id: '00000000-0000-4000-8000-000000000000' });
      assert.equal(wrongSession.ok === false && wrongSession.code, 'STALE_BINDING');
      const wrongGeneration = await call({ ...task, binding_generation: '999' });
      assert.equal(wrongGeneration.ok === false && wrongGeneration.code, 'STALE_BINDING');
      const current = await call({ ...task, session_id: rec(attached).session_id,
        binding_generation: rec(attached).binding_generation });
      assert.equal(current.ok, true);
    });
  });

  it('rejects begin_task from a chat that is not linked to this workspace', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      await attachConnected(call, worktree, store);
      const mismatches = [
        { worktree, harness: 'codex', harness_session_id: 'abc123' }, // wrong harness
        { worktree, harness: 'claude-code', harness_session_id: 'different' }, // another chat
      ];
      for (const triple of mismatches) {
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', ...triple });
        assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      }
    });
  });

  it('rejects begin_task declared for a different worktree than the linked one', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const other = await mkdtemp(join(tmpdir(), 'slip-daemon-other-'));
      try {
        await attachConnected(call, worktree, store);
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', worktree: other, ...IDENTITY });
        assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });

  it('canonicalizes a symlinked declared worktree so it still matches the linked capture', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      const linkParent = await mkdtemp(join(tmpdir(), 'slip-daemon-link-'));
      const link = join(linkParent, 'wt');
      await symlink(await realpath(worktree), link);
      try {
        await attachConnected(call, worktree, store);
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', worktree: link, ...IDENTITY });
        assert.equal(res.ok, true);
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  it('fails begin_task closed when the identity triple is absent', async () => {
    await withDaemon(async ({ worktree, store, call }) => {
      await attachConnected(call, worktree, store);
      const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r' });
      assert.equal(res.ok === false && res.code, 'IDENTITY_UNRESOLVED');
    });
  });

  it('rejects begin_task and detach when nothing is attached', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const bt = await call({ verb: 'begin_task', worktree, ...IDENTITY, title: 'T', request_id: 'r' });
      assert.equal(bt.ok === false && bt.code, 'SESSION_NOT_SELECTED');
      const dt = await call({ verb: 'detach', target: worktree });
      assert.equal(dt.ok === false && dt.code, 'TARGET_NOT_FOUND');
    });
  });

  it('rejects ask when no capture is selected', async () => {
    await withDaemon(async ({ call }) => {
      const res = await call({
        verb: 'ask', session_id: ASK_ID, request_id: ASK_REQUEST,
        text: 'What changed?', context: ASK_CONTEXT,
      });
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
    });
  });

  it('queues an ask against the selected capture, copies its target, and coalesces retries', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-wt-'));
    let sourceInput: unknown;
    const daemon = await startDaemon({
      storeDir: store,
      captureDependencies: {
        platform: createFakePlatform(), enumerate: async () => {},
        readQuestionContext: async (input) => { sourceInput = input; return 'historic selected source'; },
      },
    });
    const call = controlCall(daemon.socketPath);
    try {
      const attached = await attachConnected(call, worktree, store);
      const sessionId = rec(attached).session_id!;
      const ask = { verb: 'ask', session_id: sessionId, request_id: ASK_REQUEST,
        text: 'What changed?', context: ASK_CONTEXT,
        // A client cannot supply or override routing identity.
        harness: 'codex', harness_session_id: 'attacker', worktree: '/elsewhere' };
      const first = await call(ask);
      assert.equal(first.ok, true);
      const duplicate = await call(ask);
      assert.equal(rec(duplicate).duplicate, true);
      assert.equal(rec(first).question_id, rec(duplicate).question_id);
      const conflict = await call({ ...ask, text: 'Different question' });
      assert.equal(conflict.ok === false && conflict.code, 'REQUEST_CONFLICT');
      const source = sourceInput as { sessionId: string; boundary: bigint; context: unknown };
      assert.equal(source.sessionId, sessionId);
      assert.ok(source.boundary >= 1n);
      assert.deepEqual(source.context, ASK_CONTEXT);
      const lines = (await readFile(sessionLogPath(store, sessionId), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
      const event = lines.find((line) => line.type === 'slipstream.question.queued.v1')!;
      const data = event.data as Record<string, unknown>;
      assert.deepEqual(data.target, { ...IDENTITY, worktree: await realpath(worktree) });
      assert.deepEqual((data.context as Record<string, unknown>).selected_text, 'historic selected source');
      assert.equal(lines.filter((line) => line.type === 'slipstream.question.queued.v1').length, 1);
    } finally {
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('drains an admitted source read through detach, then refuses the question after a capture-only reattach', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-drain-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-drain-wt-'));
    let releaseRead!: () => void; let enteredRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {},
      readQuestionContext: async () => { enteredRead(); await readGate; return 'recorded source'; },
    } });
    const call = controlCall(daemon.socketPath);
    try {
      const attached = await attachConnected(call, worktree, store);
      const oldId = rec(attached).session_id!;
      const askP = call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
      await entered;
      let detached = false;
      const detachP = call({ verb: 'detach', target: worktree }).then((r) => { detached = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(detached, false, 'detach must drain the admitted source read');
      releaseRead();
      assert.equal((await askP).ok, true);
      assert.equal((await detachP).ok, true);
      assert.equal(await attachWatchOnly(call, worktree), oldId);
      const oldRetry = await call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
      // The earlier link is not carried across a detach and watch-only resume.
      assert.equal(oldRetry.ok === false && oldRetry.code, 'AGENT_NOT_CONNECTED');
    } finally { releaseRead?.(); await daemon.stop(); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('preserves one queued event when the reply times out and the same id is retried', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-retry-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-retry-wt-'));
    let releaseRead!: () => void; let enteredRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {},
      readQuestionContext: async () => { enteredRead(); await gate; return 'recorded source'; },
    } });
    const reqBase = (id: string): CallRequest => ({ verb: 'ask', session_id: id, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
    try {
      const call = controlCall(daemon.socketPath);
      const attached = await attachConnected(call, worktree, store);
      const id = rec(attached).session_id!;
      const unknown = sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, ...reqBase(id) }, responseTimeoutMs: 10 });
      await entered;
      await assert.rejects(unknown, OutcomeUnknownError);
      releaseRead();
      const retry = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, ...reqBase(id) } });
      assert.equal(retry.ok, true);
      assert.equal(rec(retry).duplicate, true);
      const events = (await readFile(sessionLogPath(store, id), 'utf8')).split('\n').filter(Boolean);
      assert.equal(events.filter((line) => JSON.parse(line).type === 'slipstream.question.queued.v1').length, 1);
    } finally { releaseRead?.(); await daemon.stop(); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('drains an admitted append during shutdown before releasing the daemon store', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-stop-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-stop-wt-'));
    let releaseAppend!: () => void; let enteredAppend!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const entered = new Promise<void>((resolve) => { enteredAppend = resolve; });
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'recorded source',
      createLog: async (opts) => {
        const log = await createLog(opts);
        return { ...log, append: async (input) => {
          if (input.type === 'slipstream.question.queued.v1') { enteredAppend(); await gate; }
          return log.append(input);
        } };
      },
    } });
    try {
      const call = controlCall(daemon.socketPath);
      const attached = await attachConnected(call, worktree, store);
      const id = rec(attached).session_id!;
      const ask = sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'ask', session_id: id, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT } });
      // Shutdown destroys the socket before the append gate opens; attach a
      // rejection handler now so Node never treats the expected unknown outcome
      // as unhandled while the stop assertion is in progress.
      void ask.catch(() => {});
      await entered;
      let stopped = false;
      const stop = daemon.stop().then(() => { stopped = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(stopped, false, 'shutdown must drain the admitted append');
      releaseAppend();
      await assert.rejects(ask, OutcomeUnknownError);
      await stop;
      const events = (await readFile(sessionLogPath(store, id), 'utf8')).split('\n').filter(Boolean);
      assert.equal(events.filter((line) => JSON.parse(line).type === 'slipstream.question.queued.v1').length, 1);
    } finally { releaseAppend?.(); await daemon.stop().catch(() => {}); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('does not accept an ask after a daemon restart and capture-only resume', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-restart-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-restart-wt-'));
    const deps = { platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'recorded source' };
    let daemon = await startDaemon({ storeDir: store, captureDependencies: deps });
    try {
      const oldId = rec(await attachConnected(controlCall(daemon.socketPath), worktree, store)).session_id!;
      await daemon.stop();
      daemon = await startDaemon({ storeDir: store, captureDependencies: { ...deps, platform: createFakePlatform() } });
      assert.equal(await attachWatchOnly(controlCall(daemon.socketPath), worktree), oldId);
      const old = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT } });
      assert.equal(old.ok === false && old.code, 'AGENT_NOT_CONNECTED');
    } finally { await daemon.stop().catch(() => {}); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('detaches to stopped and keeps the session readable at its final seq', async () => {
    await withDaemon(async ({ daemon, worktree, store, call }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      assert.equal((await call({ verb: 'begin_task', title: 'T', request_id: 'r', worktree, ...IDENTITY })).ok, true);

      const detach = await call({ verb: 'detach', target: worktree });
      assert.equal(detach.ok, true);
      assert.deepEqual([rec(detach).state, rec(detach).reason], ['stopped', 'detached']);
      assert.equal((await captureRow(call, id)).state, 'stopped');
      const lines = (await readFile(sessionLogPath(store, id), 'utf8')).trim().split('\n');
      const last = JSON.parse(lines.at(-1)!) as { type: string; seq: string };
      assert.equal(last.type, 'slipstream.capture.stopped.v1');
      const finalSeq = last.seq;

      // The reader still serves the detached session, pinned at its final seq.
      const res = await fetch(`${daemon.readerUrl}/v1/sessions`, {
        headers: { authorization: `Bearer ${daemon.readerToken}` },
      });
      const body = (await res.json()) as { id: string; durable_seq: string }[];
      const entry = body.find((s) => s.id === id);
      assert.ok(entry);
      assert.equal(entry!.durable_seq, finalSeq);
    });
  });

  it('rejects an unknown verb with a PROTOCOL error', async () => {
    await withDaemon(async ({ call }) => {
      const res = await call({ verb: 'frobnicate' });
      assert.equal(res.ok === false && res.code, 'PROTOCOL');
    });
  });

  it('rejects a request whose protocol version is not 1 before it mutates', async () => {
    await withDaemon(async ({ daemon }) => {
      const raw = (line: string): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const sock = connect(daemon.socketPath);
          let buf = '';
          sock.on('connect', () => sock.write(line + '\n'));
          sock.on('data', (d) => { buf += d.toString('utf8'); });
          sock.on('end', () => {
            try { resolve(JSON.parse(buf) as Record<string, unknown>); }
            catch (err) { reject(err); }
          });
          sock.on('error', reject);
        });
      // v:999 must be refused, and an attach carried on it must never run.
      const res = await raw(JSON.stringify({ v: 999, verb: 'attach', worktree: '/x', ...IDENTITY }));
      assert.equal(res.ok, false);
      assert.equal(res.code, 'PROTOCOL');
    });
  });

  it('reports the canonical worktree when attached through a symlink', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const link = await mkdtemp(join(tmpdir(), 'slip-daemon-lnk-'));
      const linked = join(link, 'wt');
      await symlink(worktree, linked);
      try {
        const id = await attachWatchOnly(call, linked);
        assert.equal((await captureRow(call, id)).root, await realpath(worktree));
        assert.equal((await captureRow(call, linked)).session_id, id);
      } finally {
        await rm(link, { recursive: true, force: true });
      }
    });
  });

  it('stops recording and refuses tasks when a capture loses its session lock', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-wt-'));
    const d = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    const call = controlCall(d.socketPath);
    try {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      // Steal the session's lock: overwrite its owner.lock with a foreign nonce.
      // The daemon's session heartbeat detects the loss on its next beat.
      const lockPath = join(store, 'sessions', id, 'owner.lock');
      const thief = `${lockPath}.thief`;
      await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief-nonce' }), 'utf8');
      await rename(thief, lockPath);

      // The session heartbeat (~2s) notices the loss.
      const row = await waitForRow(call, id, (r) => r.state === 'not_recording', 'not_recording');
      assert.equal(row.reason, 'storage-unavailable');

      const bt = await call({ verb: 'begin_task', title: 'T', request_id: 'after-loss', worktree, ...IDENTITY });
      assert.equal(bt.ok === false && bt.code, 'STORAGE_UNAVAILABLE');
    } finally {
      await d.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

/** A daemon with a verified Claude root transcript for chat `root` in `worktree`. */
async function withClaudeRoot(
  fn: (ctx: {
    store: string; worktree: string; transcript: string;
    call: (req: CallRequest) => Promise<ResponseEnvelope>;
    attachReq: CallRequest; claimReq: CallRequest; answerReq: CallRequest;
    listedConnection: () => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-daemon-agent-'));
  const worktree = await realpath(await mkdtemp(join(tmpdir(), 'slip-daemon-agent-wt-')));
  const transcript = join(store, 'root.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'root', cwd: worktree,
    version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
  const daemon = await startDaemon({ storeDir: store, captureDependencies: {
    platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'selected',
  } });
  const call = controlCall(daemon.socketPath);
  try {
    await fn({
      store, worktree, transcript, call,
      attachReq: { verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'root', root_transcript: transcript },
      claimReq: { verb: 'claim_question', harness: 'claude-code', harness_session_id: 'root', worktree, transcript_path: transcript },
      answerReq: { verb: 'answer_question', harness: 'claude-code', harness_session_id: 'root', worktree, text: 'connected' },
      listedConnection: async () => {
        const res = await fetch(`${daemon.readerUrl}/v1/sessions`, { headers: { authorization: `Bearer ${daemon.readerToken}` } });
        return ((await res.json()) as Array<{ agent_connection: unknown }>)[0]!.agent_connection;
      },
    });
  } finally {
    await daemon.stop();
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
}

async function connectionEvents(store: string, sessionId: string): Promise<Array<{ seq: string; data: Record<string, unknown> }>> {
  return (await readFile(sessionLogPath(store, sessionId), 'utf8')).trim().split('\n')
    .map(s => JSON.parse(s) as { type: string; seq: string; data: Record<string, unknown> })
    .filter(e => e.type === 'slipstream.agent.connection.v1');
}

describe('daemon agent readiness', () => {
  it('starts a bound capture setup-pending and refuses questions until the setup check returns', async () => {
    await withClaudeRoot(async ({ store, worktree, call, attachReq, claimReq, answerReq, listedConnection }) => {
      const attached = await call(attachReq);
      assert.deepEqual(await listedConnection(), { state: 'setup_pending' });
      assert.equal(rec(attached).agent_connection, 'setup_pending');
      const sessionId = rec(attached).session_id!;
      const target = { harness: 'claude-code', harness_session_id: 'root' };
      const g = rec(attached).binding_generation;
      assert.deepEqual((await connectionEvents(store, sessionId)).map(e => e.data),
        [{ state: 'setup_pending', binding_generation: g, target, session_id: sessionId }]);
      assert.equal((await bindingOf(call, sessionId))?.state, 'setup_pending');
      const ask = { verb: 'ask', session_id: sessionId, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT };
      const refused = await call(ask);
      assert.equal(refused.ok === false && refused.code, 'AGENT_NOT_CONNECTED');

      const claimed = rec(await call(claimReq)) as unknown as { question: unknown; setup_check: { check_id: string } };
      assert.equal(claimed.question, null);
      const checkId = claimed.setup_check.check_id;
      assert.match(checkId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(rec(await call(claimReq)), { v: 1, ok: true, question: null }, 'a check is delivered once per arm');

      const accepted = rec(await call({ ...answerReq, question_id: checkId }));
      assert.deepEqual({ ...accepted, answered_at_ms: 0 }, { v: 1, ok: true, session_id: sessionId, question_id: checkId,
        event_id: accepted.seq, seq: accepted.seq, answered_at_ms: 0, duplicate: false });
      assert.equal(typeof accepted.answered_at_ms, 'number');
      assert.deepEqual(rec(await call({ ...answerReq, question_id: checkId })), { ...accepted, duplicate: true });
      const events = await connectionEvents(store, sessionId);
      assert.deepEqual(events.map(e => e.data.state), ['setup_pending', 'connected']);
      assert.equal(events[1]!.seq, accepted.seq);
      assert.equal((await bindingOf(call, sessionId))?.state, 'connected');
      assert.deepEqual(await listedConnection(), { state: 'connected' });
      assert.equal((await call(ask)).ok, true);
      await call({ verb: 'detach', target: worktree });
      assert.deepEqual(await listedConnection(), { state: 'disconnected', reason: 'capture_not_live' });
    });
  });

  it('accepts the setup check only from the bound chat', async () => {
    await withClaudeRoot(async ({ call, attachReq, claimReq, answerReq }) => {
      const sessionId = rec(await call(attachReq)).session_id!;
      const checkId = (rec(await call(claimReq)) as unknown as { setup_check: { check_id: string } }).setup_check.check_id;
      for (const bad of [{ harness: 'codex' }, { harness_session_id: 'other' }, { worktree: tmpdir() }]) {
        const res = await call({ ...answerReq, question_id: checkId, ...bad });
        assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED', JSON.stringify(bad));
      }
      const blank = await call({ ...answerReq, question_id: checkId, text: ' ' });
      assert.equal(blank.ok === false && blank.code, 'INVALID_ANSWER');
      assert.equal((await bindingOf(call, sessionId))?.state, 'setup_pending');
    });
  });

  it('reports the same capture when the same chat attaches again, re-arming a pending check', async () => {
    await withClaudeRoot(async ({ store, worktree, call, attachReq, claimReq, answerReq }) => {
      const first = rec(await call(attachReq));
      await call(claimReq);
      const linked = join(store, 'linked');
      await symlink(worktree, linked);
      const again = rec(await call({ ...attachReq, worktree: linked }));
      assert.deepEqual(again, { v: 1, ok: true, session_id: first.session_id, state: 'recording',
        binding_generation: first.binding_generation, agent_connection: 'setup_pending', already_active: true, created: false });
      const rearmed = (rec(await call(claimReq)) as unknown as { setup_check?: { check_id: string } }).setup_check;
      assert.ok(rearmed, 'a repeated attach re-arms the pending check');
      await call({ ...answerReq, question_id: rearmed.check_id });
      const connected = rec(await call(attachReq));
      assert.equal(connected.agent_connection, 'connected');
      assert.equal(connected.already_active, true);
      assert.deepEqual(rec(await call(claimReq)), { v: 1, ok: true, question: null });
      assert.deepEqual((await connectionEvents(store, first.session_id!)).map(e => e.data.state), ['setup_pending', 'connected']);
    });
  });

  it('refuses another chat in the same workspace with BINDING_EXISTS and keeps the existing link', async () => {
    await withClaudeRoot(async ({ store, worktree, call, attachReq }) => {
      const first = rec(await call(attachReq));
      const otherTranscript = join(store, 'other.jsonl');
      await writeFile(otherTranscript, JSON.stringify({ type: 'user', sessionId: 'other', cwd: worktree,
        version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
      const before = await captureRow(call, first.session_id!);
      const other = await call({ ...attachReq, harness_session_id: 'other', root_transcript: otherTranscript });
      assert.equal(other.ok === false && other.code, 'BINDING_EXISTS');
      assert.equal(other.ok === false && `${other.code}: ${other.message}`,
        `BINDING_EXISTS: claude-code chat root is already linked to the capture of ${worktree} (session ${first.session_id}). `
        + `That link was kept. To link this chat here instead, run: slipstream unlink --session ${first.session_id}, `
        + 'then run slipstream attach again from this chat.');
      assert.deepEqual(await captureRow(call, first.session_id!), before);
    });
  });

  it('refuses the same chat in another workspace with BINDING_EXISTS naming the linked capture', async () => {
    await withClaudeRoot(async ({ worktree, call, attachReq }) => {
      const first = rec(await call(attachReq));
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'slip-daemon-agent-else-')));
      const moved = join(elsewhere, 'root.jsonl');
      await writeFile(moved, JSON.stringify({ type: 'user', sessionId: 'root', cwd: elsewhere,
        version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
      try {
        const res = await call({ ...attachReq, worktree: elsewhere, root_transcript: moved });
        assert.equal(res.ok === false && res.code, 'BINDING_EXISTS');
        assert.ok(res.ok === false && res.message.includes(`capture of ${worktree} (session ${first.session_id})`),
          res.ok === false ? res.message : '');
        assert.equal((await captureRow(call, first.session_id!)).state, 'recording');
      } finally { await rm(elsewhere, { recursive: true, force: true }); }
    });
  });

  it('reports no agent connection for a watch-only capture', async () => {
    await withDaemon(async ({ store, worktree, call }) => {
      const attached = rec(await call({ verb: 'attach', mode: 'watch-only', worktree }));
      assert.equal(attached.binding_generation, undefined);
      await waitForRow(call, attached.session_id!, (row) => row.state === 'recording');
      assert.equal((await captureRow(call, attached.session_id!)).binding, null);
      assert.deepEqual(await connectionEvents(store, attached.session_id!), []);
      const res = await call({ verb: 'ask', session_id: attached.session_id, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      assert.equal(res.ok === false && res.code, 'AGENT_NOT_CONNECTED');
    });
  });
});

const ABSENT_ID = '99999999-9999-4999-8999-999999999999';
const HEX_LIVE = 'a'.repeat(64);
const HEX_DEAD = 'b'.repeat(64);

/** A durable session log referencing one blob, seeded straight onto disk so a
 * maintenance test does not depend on capture internals. */
async function seedSession(store: string, id: string, sha: string): Promise<void> {
  await mkdir(join(store, 'sessions', id), { recursive: true });
  const rec = {
    seq: '1', type: 'slipstream.file.baselined.v1',
    data: { session_id: id, path: 'f', snapshot: { kind: 'content', sha256: sha, size: 3 } },
  };
  await writeFile(sessionLogPath(store, id), JSON.stringify(rec) + '\n', 'utf8');
}

async function seedBlob(store: string, sha: string): Promise<void> {
  const path = blobPath(store, sha);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'xyz', 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe('daemon maintenance verbs', () => {
  it('refuses to delete a well-formed session id that names no session', async () => {
    await withDaemon(async ({ call }) => {
      const res = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_FOUND');
    });
  });

  it('refuses a delete whose session id is structurally invalid', async () => {
    await withDaemon(async ({ call }) => {
      const res = await call({ verb: 'delete_session', session_id: '../etc' });
      assert.equal(res.ok === false && res.code, 'PROTOCOL');
    });
  });

  it('tombstones a detached session and removes its history', async () => {
    await withDaemon(async ({ store, call }) => {
      await seedSession(store, ABSENT_ID, HEX_LIVE);
      const res = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(res.ok, true);
      assert.equal(rec(res).session_id, ABSENT_ID);
      assert.equal(await exists(tombstonePath(store, ABSENT_ID)), true);
      assert.equal(await exists(sessionLogPath(store, ABSENT_ID)), false);
    });
  });

  it('is idempotent: deleting an already-removed session still succeeds', async () => {
    await withDaemon(async ({ store, call }) => {
      await seedSession(store, ABSENT_ID, HEX_LIVE);
      await call({ verb: 'delete_session', session_id: ABSENT_ID });
      const again = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(again.ok, true);
    });
  });

  it('refuses to delete a session that is still recording', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const id = await attachWatchOnly(call, worktree);
      const res = await call({ verb: 'delete_session', session_id: id });
      assert.equal(res.ok === false && res.code, 'SESSION_ACTIVE');
    });
  });

  it('discloses committed removal when history cleanup fails after the tombstone', async () => {
    await withDaemon(async ({ store, call }) => {
      // events.jsonl as a directory makes the history unlink fail AFTER the tombstone
      // is durable: the response must say removal committed + cleanup retryable, and
      // the tombstone must survive (never rolled back).
      await mkdir(join(store, 'sessions', ABSENT_ID, 'events.jsonl'), { recursive: true });
      const res = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE');
      assert.match(res.ok === false ? res.message : '', /logically removed|retryable/i);
      assert.equal(await exists(tombstonePath(store, ABSENT_ID)), true);
    });
  });

  it('reclaims an unreferenced blob and keeps a referenced one', async () => {
    await withDaemon(async ({ store, call }) => {
      await seedSession(store, ABSENT_ID, HEX_LIVE); // retained, references HEX_LIVE
      await seedBlob(store, HEX_LIVE);
      await seedBlob(store, HEX_DEAD);
      const res = await call({ verb: 'gc' });
      assert.equal(res.ok, true);
      assert.equal((res as unknown as Record<string, unknown>).removed, 1);
      assert.equal(await exists(blobPath(store, HEX_LIVE)), true);
      assert.equal(await exists(blobPath(store, HEX_DEAD)), false);
    });
  });

  it('finishes an interrupted deletion: removes residual history under a tombstone', async () => {
    await withDaemon(async ({ store, call }) => {
      // A delete that crashed after the tombstone but before cleanup: tombstone
      // present, log still on disk.
      await seedSession(store, ABSENT_ID, HEX_DEAD);
      await seedBlob(store, HEX_DEAD);
      await writeFile(tombstonePath(store, ABSENT_ID), '{"version":1}', 'utf8');
      const res = await call({ verb: 'gc' });
      assert.equal(res.ok, true);
      assert.equal(await exists(sessionLogPath(store, ABSENT_ID)), false);
      assert.equal(await exists(tombstonePath(store, ABSENT_ID)), true);
      // The removed session protects nothing, so its blob is reclaimed.
      assert.equal(await exists(blobPath(store, HEX_DEAD)), false);
    });
  });

  it('refuses to gc while any capture is recording', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await attachWatchOnly(call, worktree);
      const res = await call({ verb: 'gc' });
      assert.equal(res.ok === false && res.code, 'SESSION_ACTIVE');
    });
  });
});

describe('daemon singleton', () => {
  it('refuses to start a second daemon over a live one', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const first = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    try {
      await assert.rejects(
        startDaemon({
          storeDir: store,
          captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
        }),
        (err) => err instanceof DaemonAlreadyRunningError,
      );
    } finally {
      await first.stop();
      await rm(store, { recursive: true, force: true });
    }
  });

  it('refuses to remove a non-socket object squatting the control path', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const squat = join(store, 'control.sock');
    await writeFile(squat, 'not a socket', 'utf8');
    try {
      await assert.rejects(
        startDaemon({
          storeDir: store,
          captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
        }),
        /control path|not a socket|unresponsive|EADDRINUSE/i,
      );
      // The squatting file is preserved, never silently deleted.
      assert.equal((await stat(squat)).isFile(), true);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('stops promptly even with an idle control connection open', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const d = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    // Open a connection and send nothing: an unbounded idle connection must not
    // wedge server.close() during teardown.
    const sock = connect(d.socketPath);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    try {
      await d.stop(); // would hang forever without idle-connection teardown
    } finally {
      sock.destroy();
      await rm(store, { recursive: true, force: true });
    }
  });

  it('does not leave a capture running when the daemon stops mid-attach', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-wt-'));
    let releaseWatch: (() => void) | undefined;
    let subClosed = false;
    // A platform whose watch() blocks until released, so an attach is still
    // starting capture when the daemon is asked to stop.
    const platform: Platform = {
      watch: async (_o: WatchOptions): Promise<Subscription> => {
        await new Promise<void>((resolve) => { releaseWatch = resolve; });
        return { close: async () => { subClosed = true; } };
      },
    };
    const enumerate = async (): Promise<void> => {};
    const d = await startDaemon({ storeDir: store, captureDependencies: { platform, enumerate } });
    try {
      const attachP = sendControlRequest({
        socketPath: d.socketPath,
        request: { v: 1 as const, verb: 'attach', mode: 'watch-only', worktree },
        responseTimeoutMs: 5000,
      }).catch(() => {});
      // Wait until capture startup is blocked inside watch().
      while (releaseWatch === undefined) await new Promise((r) => setTimeout(r, 10));
      const stopP = d.stop();
      releaseWatch(); // let capture startup finish AFTER teardown began
      await stopP;
      await attachP;
      // The capture that finished starting after shutdown was stopped, not leaked.
      assert.equal(subClosed, true);
      // Ownership was released cleanly: a fresh daemon can take the store.
      const d2 = await startDaemon({
        storeDir: store,
        captureDependencies: { platform: createFakePlatform(), enumerate },
      });
      await d2.stop();
    } finally {
      releaseWatch?.();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('unlinks the control socket on stop', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const d = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    const socketPath = d.socketPath;
    await stat(socketPath); // present while running
    await d.stop();
    await assert.rejects(() => stat(socketPath), /ENOENT/);
    await rm(store, { recursive: true, force: true });
  });
});

for (const staleLock of [false, true]) {
  it(`pre-probes a live listener without touching the store lock (stale=${staleLock})`, async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-probe-'));
    const lockPath = join(store, 'owner.lock');
    const original = JSON.stringify({ pid: process.pid, nonce: 'paused-owner' });
    if (staleLock) {
      await writeFile(lockPath, original, { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
    }
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
    try {
      await assert.rejects(startDaemon({ storeDir: store }), DaemonAlreadyRunningError);
      if (staleLock) {
        assert.equal(await readFile(lockPath, 'utf8'), original);
        assert.equal((await stat(lockPath)).mtimeMs, 0);
      } else {
        await assert.rejects(stat(lockPath), { code: 'ENOENT' });
        await assert.rejects(stat(join(store, 'runtime')), { code: 'ENOENT' });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(store, { recursive: true, force: true });
    }
  });
}

it('holds the store lock until an in-flight attach settles before shutting down', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-stall-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  let enterWatch!: () => void;
  const entered = new Promise<void>((resolve) => { enterWatch = resolve; });
  let resolveWatch!: (subscription: Subscription) => void;
  const watch = new Promise<Subscription>((resolve) => { resolveWatch = resolve; });
  let subClosed = false;
  const subscription: Subscription = { close: async () => { subClosed = true; } };
  const d = await startDaemon({ storeDir: store, captureDependencies: {
    platform: { watch: () => { enterWatch(); return watch; } },
    enumerate: async () => {},
  } });
  try {
    const attach = sendControlRequest({ socketPath: d.socketPath,
      request: { v: 1, verb: 'attach', mode: 'watch-only', worktree },
    }).catch(() => {});
    await entered;
    let stopped = false;
    const stop = d.stop().then(() => { stopped = true; });
    // Cross the former five-second teardown bound to catch early lock release.
    await new Promise((resolve) => setTimeout(resolve, 5200));
    assert.equal(stopped, false);
    await stat(join(store, 'owner.lock'));
    assert.equal(subClosed, false);
    resolveWatch(subscription);
    await stop;
    await attach;
    assert.equal(subClosed, true);
    await assert.rejects(stat(join(store, 'owner.lock')), { code: 'ENOENT' });
  } finally {
    // Always unblock startup so a failed assertion cannot wedge cleanup.
    resolveWatch(subscription);
    await d.stop();
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

it('reports a failed capture stop after store-lock loss without an unhandled rejection', async (t) => {
  const store = await mkdtemp(join(tmpdir(), 'slip-loss-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  let reportFailure!: (args: unknown[]) => void;
  const reported = new Promise<unknown[]>((resolve) => { reportFailure = resolve; });
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (String(args[0]).includes('teardown after store-lock loss failed')) reportFailure(args);
  });
  const stopError = new Error('watcher close failed');
  const d = await startDaemon({ storeDir: store, captureDependencies: {
    platform: { watch: async () => ({ close: async () => { throw stopError; } }) },
    enumerate: async () => {},
  } });
  let timer: NodeJS.Timeout | undefined;
  try {
    await attachWatchOnly(controlCall(d.socketPath), worktree);
    const thief = join(store, 'thief');
    await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief' }));
    await rename(thief, join(store, 'owner.lock'));
    const args = await Promise.race([reported, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('teardown failure was not reported')), 6000);
    })]);
    assert.equal(args[1], stopError);
    await assert.rejects(d.stop(), /watcher close failed/);
  } finally {
    if (timer) clearTimeout(timer);
    await d.stop().catch(() => {});
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

type LogRecord = { seq: string; type: string; data: Record<string, unknown> };
async function readLog(store: string, id: string): Promise<LogRecord[]> {
  return (await readFile(sessionLogPath(store, id), 'utf8')).trim().split('\n').map(s => JSON.parse(s) as LogRecord);
}

/** A daemon with real enumeration (so detached edits reconcile) over a store the
 * test keeps across daemon restarts. */
async function withResumeDaemon(
  fn: (ctx: { store: string; worktree: string; daemon: () => Daemon; call: Call;
    restart: (extra?: Partial<Parameters<typeof startDaemon>[0]>) => Promise<void> }) => Promise<void>,
  extra: Partial<Parameters<typeof startDaemon>[0]> = {},
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-daemon-resume-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-resume-wt-'));
  const start = (more: Partial<Parameters<typeof startDaemon>[0]> = {}) => startDaemon({ storeDir: store,
    captureDependencies: { platform: createFakePlatform(), readQuestionContext: async () => 'selected' }, ...extra, ...more });
  let daemon = await start();
  const call: Call = controlCall(daemon.socketPath);
  try {
    await fn({ store, worktree, daemon: () => daemon, call,
      restart: async (more) => { await daemon.stop(); daemon = await start(more); } });
  } finally {
    await daemon.stop().catch(() => {});
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
}

/** A well-formed log for `root` written by the real writer, so lookup and
 * recovery see a genuine session that this daemon never touched. */
async function seedStartedSession(store: string, id: string, root: string, extra: PublicEventInput[] = []): Promise<void> {
  await mkdir(join(store, 'sessions', id), { recursive: true, mode: 0o700 });
  const log = await createLog({ filePath: sessionLogPath(store, id), sessionId: id });
  try {
    await log.append({ type: 'slipstream.session.started.v1', occurred_at_ms: 1, data: { root, max_bytes: 1024 } });
    for (const input of extra) await log.append(input);
  } finally { await log.close(); }
}

async function sessionsJson(daemon: Daemon): Promise<{ id: string; durable_seq: string }[]> {
  const res = await fetch(`${daemon.readerUrl}/v1/sessions`, { headers: { authorization: `Bearer ${daemon.readerToken}` } });
  return (await res.json()) as { id: string; durable_seq: string }[];
}

/** Read an SSE follow stream until `done` holds or the server ends it. A bounded
 * deadline aborts a stream the server never ends, so a failure cannot hang. */
async function follow(daemon: Daemon, id: string, after: string, done: (ids: string[]) => boolean,
  opened?: () => void): Promise<string[]> {
  const res = await fetch(`${daemon.readerUrl}/v1/sessions/${id}/events?follow=true`, {
    headers: { authorization: `Bearer ${daemon.readerToken}`, 'last-event-id': after },
    signal: AbortSignal.timeout(10_000) });
  opened?.();
  const ids: string[] = [];
  const reader = res.body!.getReader();
  let text = '';
  try {
    while (!done(ids)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += Buffer.from(value).toString('utf8');
      let cut;
      while ((cut = text.indexOf('\n\n')) >= 0) {
        const frame = text.slice(0, cut); text = text.slice(cut + 2);
        const idLine = frame.split('\n').find(l => l.startsWith('id:'));
        if (idLine) ids.push(idLine.slice(3).trim());
      }
    }
  } catch { /* an aborted follower ends with a network error; ids so far stand */ }
  finally { await reader.cancel().catch(() => {}); }
  return ids;
}

/** Fails (rather than quietly passing) when a follower is not ended promptly by
 * the resume's freeze/activate abort; well below the follower's own 10s deadline. */
async function endedPromptly(follower: Promise<string[]>): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([follower, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('follower was not aborted by the resume')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

describe('daemon workspace resume', () => {
  it('resumes with a continuous seq and reconciles edits made while detached', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      await writeFile(join(worktree, 'a.ts'), 'one');
      const id = await attachWatchOnly(call, worktree);
      assert.equal((await call({ verb: 'detach', target: worktree })).ok, true);
      const before = await readLog(store, id);
      await writeFile(join(worktree, 'a.ts'), 'two');
      assert.equal(await attachWatchOnly(call, worktree), id);
      const after = await readLog(store, id);
      assert.deepEqual(after.map(e => e.seq), after.map((_, i) => String(i + 1)));
      const tail = after.slice(before.length);
      assert.equal(tail[0]!.type, 'slipstream.session.resumed.v1');
      assert.equal(tail[0]!.seq, String(before.length + 1));
      assert.ok(tail.some(e => e.type === 'slipstream.capture.gap.v1' && e.data.reason === 'restart'));
      assert.ok(tail.some(e => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.ts'));
    });
  });

  it('resumes a session recorded by a previous daemon run', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, restart }) => {
      await writeFile(join(worktree, 'a.ts'), 'one');
      const id = await attachWatchOnly(call, worktree);
      const before = (await readLog(store, id)).length;
      await restart();
      await writeFile(join(worktree, 'a.ts'), 'two');
      assert.equal(await attachWatchOnly(call, worktree), id);
      const after = await readLog(store, id);
      assert.equal(after[before]!.type, 'slipstream.session.resumed.v1');
      assert.ok(after.slice(before).some(e => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.ts'));
    });
  });

  it('resumes through a symlinked path to the same workspace', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = await attachWatchOnly(call, worktree);
      await call({ verb: 'detach', target: worktree });
      const alias = join(store, 'alias');
      await symlink(worktree, alias);
      assert.equal(await attachWatchOnly(call, alias), id);
    });
  });

  it('resumes for a different chat and runs a fresh setup check for it', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      await call({ verb: 'detach', target: worktree });
      const transcriptB = join(store, 'chat-b.jsonl');
      await writeFile(transcriptB, JSON.stringify({ type: 'user', sessionId: 'chat-b', cwd: await realpath(worktree),
        version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
      const b = await call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'chat-b', root_transcript: transcriptB });
      assert.equal(rec(b).session_id, id);
      assert.equal(rec(b).agent_connection, 'setup_pending');
      const log = await readLog(store, id);
      const resumedAt = log.findIndex(e => e.type === 'slipstream.session.resumed.v1');
      const pending = log.slice(resumedAt).filter(e => e.type === 'slipstream.agent.connection.v1');
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0]!.data.target, { harness: 'claude-code', harness_session_id: 'chat-b' });
      const ask = await call({ verb: 'ask', session_id: id, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      assert.equal(ask.ok === false && ask.code, 'AGENT_NOT_CONNECTED');
    });
  });

  it('starts a new session after the workspace\'s session was removed', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ worktree, call }) => {
      const id = await attachWatchOnly(call, worktree);
      await call({ verb: 'detach', target: worktree });
      assert.equal((await call({ verb: 'delete_session', session_id: id })).ok, true);
      const fresh = await call({ verb: 'attach', mode: 'watch-only', worktree });
      assert.equal(fresh.ok, true);
      assert.notEqual(rec(fresh).session_id, id);
    });
  });

  it('starts a new session and warns when the only candidate has an unreadable first record', { timeout: 30_000 }, async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await withResumeDaemon(async ({ store, worktree, call }) => {
      await mkdir(join(store, 'sessions', ABSENT_ID), { recursive: true });
      await writeFile(sessionLogPath(store, ABSENT_ID), '{"torn');
      const res = await call({ verb: 'attach', mode: 'watch-only', worktree });
      assert.equal(res.ok, true);
      assert.notEqual(rec(res).session_id, ABSENT_ID);
      assert.ok(errors.mock.calls.some(c => String(c.arguments[0]).includes(ABSENT_ID)));
    });
  });
});

const RETRY_ONLY = /^(?=[\s\S]*Retry attach)(?![\s\S]*slipstream delete)/;

describe('daemon workspace resume fails closed', () => {
  const ID = '55555555-5555-4555-8555-555555555555';
  async function expectResumeFailed(store: string, daemon: Daemon, call: Call, worktree: string, remedy: RegExp, H?: string): Promise<void> {
    const before = await readdir(join(store, 'sessions'));
    const res = await call({ verb: 'attach', mode: 'watch-only', worktree });
    let message: string;
    if (res.ok === false) {
      // The lookup itself failed: nothing was admitted.
      assert.equal(res.code, 'SESSION_RESUME_FAILED');
      message = res.message;
      assert.deepEqual((rec(await call({ verb: 'status' })) as { captures?: unknown[] }).captures, []);
    } else {
      // Admitted under the existing session; its start failed.
      assert.equal(rec(res).session_id, ID);
      const row = await waitForRow(call, ID, (r) => r.state === 'not_recording', 'not_recording');
      assert.equal(row.reason, 'resume-failed');
      message = String(row.message);
    }
    assert.match(message, new RegExp(ID));
    assert.match(message, remedy);
    assert.deepEqual((await readdir(join(store, 'sessions'))).sort(), before.sort(), 'no fallback session may be minted');
    if (H !== undefined) assert.equal((await sessionsJson(daemon)).find(s => s.id === ID)?.durable_seq, H);
  }
  const change = (sha: string): PublicEventInput => ({ type: 'slipstream.file.baselined.v1', occurred_at_ms: 2,
    data: { path: 'f', snapshot: { kind: 'content', sha256: sha, size: 3 } } });
  const scope = (at: number): PublicEventInput => ({ type: 'slipstream.capture.scope.v1', occurred_at_ms: at,
    data: { policy: 'filesystem', status: 'active' } } as PublicEventInput);

  it('on a corrupt record in the middle of the log', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree), [scope(2), scope(3)]);
      const lines = (await readFile(sessionLogPath(store, ID), 'utf8')).split('\n');
      lines[1] = '{"seq":"2","broken":true}';
      await writeFile(sessionLogPath(store, ID), lines.join('\n'));
      await expectResumeFailed(store, daemon(), call, worktree, /Restore its data/, '3');
    });
  });

  it('on an unreadable final record', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      await writeFile(sessionLogPath(store, ID), (await readFile(sessionLogPath(store, ID), 'utf8')) + 'garbage\n');
      // The listing reads the same corrupt tail, so its durable_seq is not asserted.
      await expectResumeFailed(store, daemon(), call, worktree, /Restore its data/);
    });
  });

  it('with the retry remedy, not the delete remedy, when the lookup hits a transient read failure', { timeout: 30_000 }, async () => {
    const transient = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    const workspaceLookup: typeof findWorkspaceSession = async () => { throw new WorkspaceLookupError(ID, transient); };
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      await expectResumeFailed(store, daemon(), call, worktree, RETRY_ONLY);
    }, { workspaceLookup });
  });

  it('on a missing content blob', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree), [change(HEX_DEAD)]);
      await expectResumeFailed(store, daemon(), call, worktree, /Restore its data/, '2');
    });
  });

  it('with the retry remedy when an existing blob cannot be read temporarily', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      const blob = await (await createCas(join(store, 'blobs'))).put(Buffer.from('xyz'));
      await seedStartedSession(store, ID, await realpath(worktree), [change(blob.sha256)]);
      // The blob is present and intact, but an external permission change makes
      // this read fail now. That is retryable, not proof of corrupt history.
      await chmod(blobPath(store, blob.sha256), 0o000);
      await expectResumeFailed(store, daemon(), call, worktree, RETRY_ONLY, '2');
    });
  });

  it('on a session lock held by another live owner', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      await writeFile(join(store, 'sessions', ID, 'owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
      await expectResumeFailed(store, daemon(), call, worktree, RETRY_ONLY, '1');
    });
  });

  it('on a capture startup failure', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      const failing = createFakePlatform();
      failing.watch = async () => { throw new Error('watcher refused'); };
      await restart({ captureDependencies: { platform: failing } });
      await expectResumeFailed(store, daemon(), call, worktree, RETRY_ONLY, '1');
    });
  });
});

describe('daemon workspace resume fails closed at agent-connection setup', () => {
  it('keeps recording without a link when the setup record cannot be written, and records the unlink', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, restart }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      await call({ verb: 'detach', target: worktree });
      const failingLog: typeof createLog = async (o) => {
        const log = await createLog(o);
        return { ...log, append: (input) => input.type === 'slipstream.agent.connection.v1'
          ? Promise.reject(new Error('injected connection append failure')) : log.append(input) };
      };
      await restart({ captureDependencies: { platform: createFakePlatform(), createLog: failingLog } });
      const res = await call({ verb: 'attach', worktree, ...IDENTITY, root_transcript: join(store, 'abc123.jsonl') });
      assert.equal(res.ok, false);
      assert.match(res.ok === false ? res.message : '', /injected connection append failure/);
      const row = await captureRow(call, id);
      assert.equal(row.state, 'recording');
      assert.equal((row.binding as { state: string }).state, 'unlinked');
      const log = await readLog(store, id);
      const binding = log.findLast(e => e.type === 'slipstream.agent.binding.v1')!;
      assert.deepEqual(log.at(-1)!.type, 'slipstream.agent.unlinked.v1');
      assert.equal(log.at(-1)!.data.binding_generation, binding.data.binding_generation);
    });
  });
});

describe('daemon workspace resume and readers', () => {
  it('a follower on the stopped session reconnects and receives every post-resume record once', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      const id = await attachWatchOnly(call, worktree);
      await call({ verb: 'detach', target: worktree });
      const H = (await readLog(store, id)).length;
      let opened!: () => void; const isOpen = new Promise<void>(r => { opened = r; });
      const first = follow(daemon(), id, String(H), () => false, opened);
      await isOpen;
      assert.equal(await attachWatchOnly(call, worktree), id);
      const seen = await endedPromptly(first); // ended by the freeze/activate abort
      const last = seen.at(-1) ?? String(H);
      const N = (await readLog(store, id)).length;
      assert.ok(N > H, 'the resume must have appended records past the follower\'s position');
      const rest = await follow(daemon(), id, last, ids => ids.at(-1) === String(N));
      const all = [...seen, ...rest];
      assert.deepEqual(all, Array.from({ length: N - H }, (_, i) => String(H + 1 + i)));
    });
  });

  it('a follower of a session from a previous daemon run also sees the resume', { timeout: 30_000 }, async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      const id = await attachWatchOnly(call, worktree);
      await restart();
      const H = (await readLog(store, id)).length;
      let opened!: () => void; const isOpen = new Promise<void>(r => { opened = r; });
      const first = follow(daemon(), id, String(H), () => false, opened);
      await isOpen;
      assert.equal(await attachWatchOnly(call, worktree), id);
      const seen = await endedPromptly(first);
      const N = (await readLog(store, id)).length;
      assert.ok(N > H, 'the resume must have appended records past the follower\'s position');
      const rest = await follow(daemon(), id, seen.at(-1) ?? String(H), ids => ids.at(-1) === String(N));
      assert.deepEqual([...seen, ...rest], Array.from({ length: N - H }, (_, i) => String(H + 1 + i)));
    });
  });

  it('a finite read during the resume never goes past the pinned boundary', { timeout: 30_000 }, async () => {
    let hold = false;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    // Hold inside the reconcile walk: it runs after session.resumed, the restart gap and
    // the scope record are already on disk, while the registry boundary must still be H.
    const held = { platform: createFakePlatform(), enumerate: async () => {
      if (hold) { hold = false; entered(); await gate; }
    } };
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      const id = await attachWatchOnly(call, worktree);
      await call({ verb: 'detach', target: worktree });
      const H = (await readLog(store, id)).length;
      await restart({ captureDependencies: held });
      hold = true;
      const attachP = call({ verb: 'attach', mode: 'watch-only', worktree });
      try {
        await entering;
        assert.ok((await readLog(store, id)).length > H, 'records past H are already on disk');
        assert.equal((await sessionsJson(daemon())).find(s => s.id === id)?.durable_seq, String(H));
        const finite = await fetch(`${daemon().readerUrl}/v1/sessions/${id}/events?after=0`,
          { headers: { authorization: `Bearer ${daemon().readerToken}` } });
        assert.equal(finite.status, 200);
        assert.equal(finite.headers.get('slipstream-durable-seq'), String(H));
        const seqs = (await finite.text()).split('\n').filter(l => l !== '').map(l => BigInt((JSON.parse(l) as { seq: string }).seq));
        assert.ok(seqs.length > 0, 'the finite read must serve the pre-resume history');
        assert.ok(seqs.every(q => q <= BigInt(H)), `a finite read must stay at or below ${H}, saw ${seqs.at(-1)}`);
        assert.equal(seqs.at(-1), BigInt(H));
      } finally { release(); }
      const res = await attachP;
      assert.equal(rec(res).session_id, id);
    });
  });
});

describe('daemon workspace resume concurrency', () => {
  function heldLookup() {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    let hold = true;
    const workspaceLookup: typeof findWorkspaceSession = async (s, r) => {
      if (hold) { hold = false; entered(); await gate; }
      return findWorkspaceSession(s, r);
    };
    return { workspaceLookup, release, entering };
  }

  it('refuses delete_session and gc while an attach is still looking up the workspace', { timeout: 30_000 }, async () => {
    const held = heldLookup();
    await withResumeDaemon(async ({ worktree, call }) => {
      const attachP = call({ verb: 'attach', mode: 'watch-only', worktree });
      await held.entering;
      const del = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(del.ok === false && del.code, 'SESSION_ACTIVE');
      const gc = await call({ verb: 'gc' });
      assert.equal(gc.ok === false && gc.code, 'SESSION_ACTIVE');
      held.release();
      assert.equal((await attachP).ok, true);
    }, { workspaceLookup: held.workspaceLookup });
  });

  it('shutdown waits for an attach that is still looking up the workspace, and nothing starts', { timeout: 30_000 }, async () => {
    const held = heldLookup();
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      const attachP = call({ verb: 'attach', mode: 'watch-only', worktree }).catch(err => err);
      await held.entering;
      let stopped = false;
      const stopP = daemon().stop().then(() => { stopped = true; });
      await new Promise(r => setTimeout(r, 25));
      assert.equal(stopped, false, 'shutdown must wait for the in-flight lookup');
      held.release();
      await stopP;
      await attachP;
      assert.deepEqual(await readdir(join(store, 'sessions')).catch(() => []), []);
    }, { workspaceLookup: held.workspaceLookup });
  });

  it('refuses a begin_task that straddles a detach and resume of the same session', { timeout: 30_000 }, async () => {
    let hold = false;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      hold = true;
      const stale = call({ verb: 'begin_task', title: 'Old', request_id: 'r-old', worktree, ...IDENTITY });
      await entering;
      await call({ verb: 'detach', target: worktree });
      assert.equal(rec(await attachConnected(call, worktree, store)).session_id, id);
      release();
      const res = await stale;
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      assert.equal((await readLog(store, id)).filter(e => e.type === 'slipstream.task.started.v1').length, 0);
    }, { identityRealpath: async (p) => {
      if (hold) { hold = false; entered(); await gate; }
      return realpath(p);
    } });
  });
});
