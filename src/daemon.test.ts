import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, stat, rename, realpath, symlink, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon, DaemonAlreadyRunningError, type Daemon } from './daemon.ts';
import { blobPath, sessionLogPath, tombstonePath } from './store-reader.ts';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { createLog } from './log.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import type { Platform, Subscription, WatchOptions } from './platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';

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
      call: (req) => sendControlRequest({
        socketPath: d.socketPath,
        request: { v: 1 as const, ...req },
        responseTimeoutMs: 5000,
      }),
    });
  } finally {
    await daemon?.stop();
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
}

describe('daemon control verbs', () => {
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
    const call = (req: CallRequest) => sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, ...req } });
    try {
      await writeFile(rootTranscript, rootMeta('9.9.9'));
      const unsupported = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(unsupported.ok === false && unsupported.code, 'IDENTITY_UNRESOLVED');
      await writeFile(rootTranscript, rootMeta('0.154.0', 'different-chat'));
      const mismatch = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(mismatch.ok === false && mismatch.code, 'IDENTITY_UNRESOLVED');
      await writeFile(rootTranscript, rootMeta('0.154.0'));
      const attach = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'root', root_transcript: rootTranscript });
      assert.equal(attach.ok, true);
      assert.equal(rec(await call({ verb: 'status' })).root_transcript, await realpath(rootTranscript));
      const session_id = rec(attach).session_id;
      assert.equal((await call({ verb: 'ask', session_id, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT })).ok, true);
      const identity = { verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: rootTranscript };
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
      assert.equal((await call({ verb: 'detach' })).ok, true);
      assert.equal((await call(identity)).ok, false);
    } finally { await daemon.stop(); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });
  it('reports a detached state and a reader url before any attach', async () => {
    await withDaemon(async ({ daemon, call }) => {
      const res = await call({ verb: 'status' });
      assert.equal(res.ok, true);
      assert.equal(rec(res).state, 'detached');
      assert.equal(rec(res).reader_url, daemon.readerUrl);
    });
  });

  it('attaches under a fresh session id and reports it active', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(attach.ok, true);
      const id = rec(attach).session_id!;
      assert.match(id, /^[0-9a-f-]{36}$/);
      const status = await call({ verb: 'status' });
      assert.equal(rec(status).state, 'active');
      assert.equal(rec(status).session_id, id);
      // The declared capture context is bound and reported (capture scope, never
      // authorship); the forwarder relies on it in P4. The worktree is reported
      // canonicalized to the durable root capture actually watches, so a symlinked
      // or relative declared path resolves to the same identity.
      assert.equal(rec(status).worktree, await realpath(worktree));
      assert.equal(rec(status).harness, IDENTITY.harness);
      assert.equal(rec(status).harness_session_id, IDENTITY.harness_session_id);
    });
  });

  it('mints a NEW session id on every attach (never reactivates a root)', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const a = await call({ verb: 'attach', worktree, ...IDENTITY });
      const idA = rec(a).session_id;
      await call({ verb: 'detach' });
      const b = await call({ verb: 'attach', worktree, ...IDENTITY });
      const idB = rec(b).session_id;
      assert.notEqual(idA, idB);
    });
  });

  it('fails attachment closed when the identity is incomplete', async () => {
    await withDaemon(async ({ worktree, call }) => {
      for (const partial of [
        { worktree, harness: 'claude-code', harness_session_id: '' },
        { worktree, harness: '', harness_session_id: 'abc' },
        { harness: 'claude-code', harness_session_id: 'abc' }, // no worktree
      ]) {
        const res = await call({ verb: 'attach', ...partial });
        assert.equal(res.ok, false);
        assert.equal(res.ok === false && res.code, 'IDENTITY_UNRESOLVED');
      }
    });
  });

  it('refuses a second attach while a session is already active', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(res.ok === false && res.code, 'SESSION_ACTIVE');
    });
  });

  it('declares a task on the active session and advances the durable seq', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const before = await call({ verb: 'status' });
      const res = await call({ verb: 'begin_task', title: 'Fix login', request_id: 'req-1', worktree, ...IDENTITY });
      assert.equal(res.ok, true);
      assert.ok(rec(res).task_id);
      const after = await call({ verb: 'status' });
      assert.ok(
        BigInt(rec(after).durable_seq!) >
          BigInt(rec(before).durable_seq!),
      );
    });
  });

  it('is idempotent per request_id (a retry replays the same task)', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const first = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup', worktree, ...IDENTITY });
      const second = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup', worktree, ...IDENTITY });
      assert.equal(rec(first).task_id, rec(second).task_id);
    });
  });

  it('maps an empty title to INVALID_TITLE', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({ verb: 'begin_task', title: '', request_id: 'r', worktree, ...IDENTITY });
      assert.equal(res.ok === false && res.code, 'INVALID_TITLE');
    });
  });

  it('rejects begin_task addressed to a session that is not selected', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({
        verb: 'begin_task', title: 'T', request_id: 'r', worktree, ...IDENTITY,
        session_id: '00000000-0000-4000-8000-000000000000',
      });
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
    });
  });

  it('accepts begin_task when the addressed session_id matches the selected one', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      const id = rec(attach).session_id;
      const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', session_id: id, worktree, ...IDENTITY });
      assert.equal(res.ok, true);
    });
  });

  it('rejects begin_task whose declared triple does not match the selected session', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const mismatches = [
        { worktree, harness: 'codex', harness_session_id: 'abc123' }, // wrong harness
        { worktree, harness: 'claude-code', harness_session_id: 'different' }, // wrong session id
      ];
      for (const triple of mismatches) {
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', ...triple });
        assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      }
    });
  });

  it('rejects begin_task declared for a different worktree than the selected one', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const other = await mkdtemp(join(tmpdir(), 'slip-daemon-other-'));
      try {
        await call({ verb: 'attach', worktree, ...IDENTITY });
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', worktree: other, ...IDENTITY });
        assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });

  it('canonicalizes a symlinked declared worktree so it still matches the selected session', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const linkParent = await mkdtemp(join(tmpdir(), 'slip-daemon-link-'));
      const link = join(linkParent, 'wt');
      await symlink(await realpath(worktree), link);
      try {
        await call({ verb: 'attach', worktree, ...IDENTITY });
        const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', worktree: link, ...IDENTITY });
        assert.equal(res.ok, true);
      } finally {
        await rm(linkParent, { recursive: true, force: true });
      }
    });
  });

  it('fails begin_task closed when the identity triple is absent', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r' });
      assert.equal(res.ok === false && res.code, 'IDENTITY_UNRESOLVED');
    });
  });

  it('rejects begin_task and detach when nothing is attached', async () => {
    await withDaemon(async ({ call }) => {
      const bt = await call({ verb: 'begin_task', title: 'T', request_id: 'r' });
      assert.equal(bt.ok === false && bt.code, 'SESSION_NOT_SELECTED');
      const dt = await call({ verb: 'detach' });
      assert.equal(dt.ok === false && dt.code, 'SESSION_NOT_SELECTED');
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
    const call = (req: CallRequest) => sendControlRequest({
      socketPath: daemon.socketPath, request: { v: 1 as const, ...req }, responseTimeoutMs: 5000,
    });
    try {
      const attached = await call({ verb: 'attach', worktree, ...IDENTITY });
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

  it('drains an admitted source read through detach, then refuses the old capture after reattach', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-drain-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-drain-wt-'));
    let releaseRead!: () => void; let enteredRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const entered = new Promise<void>((resolve) => { enteredRead = resolve; });
    const daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createFakePlatform(), enumerate: async () => {},
      readQuestionContext: async () => { enteredRead(); await readGate; return 'recorded source'; },
    } });
    const call = (req: CallRequest) => sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1 as const, ...req }, responseTimeoutMs: 5000 });
    try {
      const attached = await call({ verb: 'attach', worktree, ...IDENTITY });
      const oldId = rec(attached).session_id!;
      const askP = call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
      await entered;
      let detached = false;
      const detachP = call({ verb: 'detach' }).then((r) => { detached = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(detached, false, 'detach must drain the admitted source read');
      releaseRead();
      assert.equal((await askP).ok, true);
      assert.equal((await detachP).ok, true);
      const fresh = await call({ verb: 'attach', worktree, ...IDENTITY });
      const oldRetry = await call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
      assert.equal(oldRetry.ok === false && oldRetry.code, 'SESSION_NOT_SELECTED');
      assert.notEqual(rec(fresh).session_id, oldId);
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
      const attached = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'attach', worktree, ...IDENTITY } });
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
      const attached = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'attach', worktree, ...IDENTITY } });
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

  it('does not retarget an old ask after a daemon restart and new attach', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-restart-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-ask-restart-wt-'));
    const deps = { platform: createFakePlatform(), enumerate: async () => {}, readQuestionContext: async () => 'recorded source' };
    let daemon = await startDaemon({ storeDir: store, captureDependencies: deps });
    try {
      const attach = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'attach', worktree, ...IDENTITY } });
      const oldId = rec(attach).session_id!;
      await daemon.stop();
      daemon = await startDaemon({ storeDir: store, captureDependencies: { ...deps, platform: createFakePlatform() } });
      const fresh = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'attach', worktree, ...IDENTITY } });
      assert.notEqual(rec(fresh).session_id, oldId);
      const old = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT } });
      assert.equal(old.ok === false && old.code, 'SESSION_NOT_SELECTED');
    } finally { await daemon.stop().catch(() => {}); await rm(store, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
  });

  it('detaches back to detached and keeps the session readable at its final seq', async () => {
    await withDaemon(async ({ daemon, worktree, call }) => {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      const id = rec(attach).session_id;
      await call({ verb: 'begin_task', title: 'T', request_id: 'r' });
      const active = await call({ verb: 'status' });
      const finalSeq = rec(active).durable_seq;

      const detach = await call({ verb: 'detach' });
      assert.equal(detach.ok, true);
      const status = await call({ verb: 'status' });
      assert.equal(rec(status).state, 'detached');

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
        await call({ verb: 'attach', worktree: linked, ...IDENTITY });
        const status = await call({ verb: 'status' });
        assert.equal(rec(status).worktree, await realpath(worktree));
      } finally {
        await rm(link, { recursive: true, force: true });
      }
    });
  });

  it('wedges and refuses tasks when the active session loses its lock', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-daemon-'));
    const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-wt-'));
    const d = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    const call = (req: CallRequest): Promise<ResponseEnvelope> =>
      sendControlRequest({ socketPath: d.socketPath, request: { v: 1 as const, ...req }, responseTimeoutMs: 5000 });
    try {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      const id = rec(attach).session_id!;
      // Steal the session's lock: overwrite its owner.lock with a foreign nonce.
      // The daemon's session heartbeat detects the loss on its next beat.
      const lockPath = join(store, 'sessions', id, 'owner.lock');
      const thief = `${lockPath}.thief`;
      await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief-nonce' }), 'utf8');
      await rename(thief, lockPath);

      // Poll until the daemon transitions to wedged (heartbeat is ~2s).
      let wedged = false;
      for (let i = 0; i < 60 && !wedged; i++) {
        const status = await call({ verb: 'status' });
        wedged = rec(status).state === 'wedged';
        if (!wedged) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(wedged, true, 'daemon should wedge after the session lock is lost');

      const bt = await call({ verb: 'begin_task', title: 'T', request_id: 'after-wedge' });
      assert.equal(bt.ok === false && bt.code, 'STORAGE_UNAVAILABLE');
    } finally {
      await d.stop();
      await rm(store, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
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

  it('refuses to delete while a session is active', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      const id = rec(attach).session_id!;
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

  it('refuses to gc while a session is active', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
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
        request: { v: 1 as const, verb: 'attach', worktree, ...IDENTITY },
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
      request: { v: 1, verb: 'attach', worktree, ...IDENTITY },
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
    const attached = await sendControlRequest({ socketPath: d.socketPath,
      request: { v: 1, verb: 'attach', worktree, ...IDENTITY },
    });
    assert.equal(attached.ok, true);
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
