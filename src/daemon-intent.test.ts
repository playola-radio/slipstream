import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonAlreadyRunningError, startDaemon, type Daemon } from './daemon.ts';
import { acquireSessionLock } from './lock.ts';
import { loadIntent } from './intent-store.ts';
import { controlCall, createRootsPlatform, linkChat, rec, waitForRow, type Call } from './test/daemon-harness.ts';

async function withStore(fn: (ctx: { store: string; call: Call; roots: (n: number) => Promise<string[]> }) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-intent-daemon-'));
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-intent-roots-')));
  const fake = createRootsPlatform();
  const daemon: Daemon = await startDaemon({ storeDir: store, captureDependencies: {
    platform: fake.platform, enumerate: async () => {}, readQuestionContext: async () => 'selected',
  } });
  let made = 0;
  const roots = async (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const root = join(base, `ws-${made++}`);
      await mkdir(root);
      out.push(root);
    }
    return out;
  };
  try {
    await fn({ store, call: controlCall(daemon.socketPath), roots });
  } finally {
    await chmod(join(store, 'control'), 0o700).catch(() => {});
    await daemon.stop();
    await rm(store, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

describe('daemon capture intent is durable before each acknowledgement', () => {
  it('records an admitted capture before the attach reply', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const res = await call({ verb: 'attach', mode: 'watch-only', worktree: ws });
      assert.equal(res.ok, true, JSON.stringify(res));
      const [entry] = (await loadIntent(store)).captures;
      assert.equal(entry?.session_id, rec(res).session_id);
      assert.equal(entry?.root, ws);
      assert.equal(entry?.intent, 'running');
      assert.match(entry?.root_identity?.ino ?? '', /^[0-9]+$/);
    });
  });

  it('records waiting captures in admission order', async () => {
    await withStore(async ({ store, call, roots }) => {
      const ws = await roots(18);
      for (const w of ws) await call({ verb: 'attach', mode: 'watch-only', worktree: w });
      const recorded = (await loadIntent(store)).captures;
      assert.deepEqual(recorded.map((c) => c.root), ws);
      assert.deepEqual(recorded.map((c) => c.intent), [...Array(16).fill('running'), 'waiting', 'waiting']);
    });
  });

  it('records a detach as withdrawn before the detach reply', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const id = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: ws })).session_id!;
      await waitForRow(call, id, (row) => row.state === 'recording');
      assert.equal((await call({ verb: 'detach', target: id })).ok, true);
      const [entry] = (await loadIntent(store)).captures;
      assert.equal(entry?.intent, 'withdrawn');
      assert.equal(entry?.withdrawn_reason, 'detached');
    });
  });

  it('records a linked chat and its unlink before each reply', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const linked = await linkChat(call, store, ws!, 'chat-1');
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const [binding] = (await loadIntent(store)).bindings;
      assert.equal(binding?.intent, 'linked');
      assert.equal(binding?.harness_session_id, 'chat-1');
      assert.equal(binding?.binding_generation, rec(linked).binding_generation);
      assert.equal((await call({ verb: 'unlink', session_id: rec(linked).session_id })).ok, true);
      assert.equal((await loadIntent(store)).bindings[0]?.intent, 'revoked');
    });
  });

  it('fails closed when the intent record cannot be written', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [a, b] = await roots(2);
      const id = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: a })).session_id!;
      await waitForRow(call, id, (row) => row.state === 'recording');
      await chmod(join(store, 'control'), 0o500);
      const detached = await call({ verb: 'detach', target: id });
      assert.equal(detached.ok, false);
      assert.equal(detached.ok === false && detached.code, 'STORAGE_UNAVAILABLE');
      assert.match(detached.ok === false ? detached.message : '', /capture intent record/);
      await chmod(join(store, 'control'), 0o700);
      const later = await call({ verb: 'attach', mode: 'watch-only', worktree: b });
      assert.equal(later.ok === false && later.code, 'STORAGE_UNAVAILABLE', JSON.stringify(later));
      assert.deepEqual((await loadIntent(store)).captures.map((c) => [c.root, c.intent]), [[a, 'running']]);
    });
  });
});

describe('daemon start beside an offline withdrawal', () => {
  it('waits out a store lock briefly held by a CLI that is recording a withdrawal', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-intent-lock-'));
    await chmod(store, 0o700);
    const held = await acquireSessionLock(store);
    setTimeout(() => { void held.release(); }, 200);
    const daemon = await startDaemon({ storeDir: store, captureDependencies: { platform: createRootsPlatform().platform } });
    try {
      assert.equal((await controlCall(daemon.socketPath)({ verb: 'status' })).ok, true);
    } finally {
      await daemon.stop();
      await rm(store, { recursive: true, force: true });
    }
  });

  it('still refuses to start while the store lock stays held', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-intent-lock-'));
    await chmod(store, 0o700);
    const held = await acquireSessionLock(store);
    try {
      await assert.rejects(startDaemon({ storeDir: store }), DaemonAlreadyRunningError);
    } finally {
      await held.release();
      await rm(store, { recursive: true, force: true });
    }
  });
});
