import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm, writeFile, stat, rename, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, DaemonAlreadyRunningError, type Daemon } from './daemon.ts';
import { sendControlRequest } from './control-client.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import type { Platform, Subscription, WatchOptions } from './platform.ts';
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
