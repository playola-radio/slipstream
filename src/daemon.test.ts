import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, DaemonAlreadyRunningError, type Daemon } from './daemon.ts';
import { sendControlRequest } from './control-client.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';

const IDENTITY = { harness: 'claude-code', harness_session_id: 'abc123' };

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
      const res = await call({ verb: 'begin_task', title: 'Fix login', request_id: 'req-1' });
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
      const first = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup' });
      const second = await call({ verb: 'begin_task', title: 'T', request_id: 'req-dup' });
      assert.equal(rec(first).task_id, rec(second).task_id);
    });
  });

  it('maps an empty title to INVALID_TITLE', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({ verb: 'begin_task', title: '', request_id: 'r' });
      assert.equal(res.ok === false && res.code, 'INVALID_TITLE');
    });
  });

  it('rejects begin_task addressed to a session that is not selected', async () => {
    await withDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const res = await call({
        verb: 'begin_task', title: 'T', request_id: 'r',
        session_id: '00000000-0000-4000-8000-000000000000',
      });
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
    });
  });

  it('accepts begin_task when the addressed session_id matches the selected one', async () => {
    await withDaemon(async ({ worktree, call }) => {
      const attach = await call({ verb: 'attach', worktree, ...IDENTITY });
      const id = rec(attach).session_id;
      const res = await call({ verb: 'begin_task', title: 'T', request_id: 'r', session_id: id });
      assert.equal(res.ok, true);
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
    await writeFile(join(store, 'control.sock'), 'not a socket', 'utf8');
    try {
      await assert.rejects(
        startDaemon({
          storeDir: store,
          captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
        }),
        /control path|not a socket|EADDRINUSE/i,
      );
    } finally {
      await rm(store, { recursive: true, force: true });
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
