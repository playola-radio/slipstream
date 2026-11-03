import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonAlreadyRunningError, startDaemon, type Daemon } from './daemon.ts';
import { acquireSessionLock } from './lock.ts';
import { intentPath, loadIntent } from './intent-store.ts';
import type { Platform } from './platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import {
  captureRow, controlCall, createRootsPlatform, linkChat, rec, waitForRow, type Call,
} from './test/daemon-harness.ts';

async function withStore(fn: (ctx: { store: string; call: Call; roots: (n: number) => Promise<string[]> }) => Promise<void>,
  platform: Platform = createRootsPlatform().platform): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-intent-daemon-'));
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-intent-roots-')));
  const daemon: Daemon = await startDaemon({ storeDir: store, captureDependencies: {
    platform, enumerate: async () => {}, readQuestionContext: async () => 'selected',
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

  it('reads a capture detached before it ever started as stopped, with the detach reason', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const platform: Platform = {
      watch: async () => {
        if (first) { first = false; await held; }
        return { close: async () => {} };
      },
    };
    await withStore(async ({ call, roots }) => {
      const [a, b] = await roots(2);
      await call({ verb: 'attach', mode: 'watch-only', worktree: a });
      const queued = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: b }));
      assert.equal(queued.state, 'queued');
      const detached = rec(await call({ verb: 'detach', target: queued.session_id }));
      release();
      assert.equal(detached.state, 'stopped');
      assert.equal(detached.reason, 'detached');
    }, platform);
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

  it('does not report a second unlink as done while the first is not saved', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const linked = await linkChat(call, store, ws!, 'chat-1');
      assert.equal(linked.ok, true, JSON.stringify(linked));
      await chmod(join(store, 'control'), 0o500);
      const session_id = rec(linked).session_id;
      const both = await Promise.all([call({ verb: 'unlink', session_id }), call({ verb: 'unlink', session_id })]);
      assert.deepEqual(both.map((r) => r.ok), [false, false], JSON.stringify(both));
    });
  });
});

const FULL = 'CAPTURE_LIMIT_REACHED: 32/32 capture slots in use. This workspace is NOT recording. Pause one first.';

function refusal(res: ResponseEnvelope): string {
  return res.ok === false ? `${res.code}: ${res.message}` : `ok ${JSON.stringify(res)}`;
}

async function record(call: Call, root: string): Promise<string> {
  const res = await call({ verb: 'attach', mode: 'watch-only', worktree: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  const id = rec(res).session_id!;
  await waitForRow(call, id, (row) => row.state === 'recording');
  return id;
}

async function pause(call: Call, root: string): Promise<string> {
  const id = await record(call, root);
  assert.equal((await call({ verb: 'detach', target: root })).ok, true);
  return id;
}

describe('daemon capture slots', () => {
  it('refuses a new root when 32 slots are held and writes nothing', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [paused, ...ws] = await roots(34);
      await pause(call, paused!);
      for (const root of ws.slice(0, 32)) await record(call, root);
      const before = await readFile(intentPath(store), 'utf8');

      assert.equal(refusal(await call({ verb: 'attach', mode: 'watch-only', worktree: ws[32]! })), FULL);
      assert.equal(refusal(await call({ verb: 'attach', mode: 'watch-only', worktree: paused! })), FULL);

      assert.equal(await readFile(intentPath(store), 'utf8'), before);
      assert.equal((await captureRow(call, paused!)).state, 'stopped');
    });
  });

  it('two concurrent new roots at 31 slots admit exactly one', async () => {
    await withStore(async ({ call, roots }) => {
      const ws = await roots(33);
      for (const root of ws.slice(0, 31)) await record(call, root);
      const raced = await Promise.all(ws.slice(31).map((root) => call({ verb: 'attach', mode: 'watch-only', worktree: root })));
      assert.deepEqual(raced.map((r) => r.ok).sort(), [false, true]);
      assert.equal(refusal(raced.find((r) => !r.ok)!), FULL);
    });
  });

  it('joining a recording root succeeds while full', async () => {
    await withStore(async ({ call, roots }) => {
      const ws = await roots(32);
      const ids: string[] = [];
      for (const root of ws) ids.push(await record(call, root));
      const joined = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: ws[0]! }));
      assert.deepEqual([joined.ok, joined.session_id, joined.created], [true, ids[0], false]);
    });
  });

  it('detach frees a slot and starts nothing else', async () => {
    await withStore(async ({ call, roots }) => {
      const [paused, ...ws] = await roots(34);
      await pause(call, paused!);
      for (const root of ws.slice(0, 32)) await record(call, root);
      const states = async () => (rec(await call({ verb: 'status' })) as unknown as { captures: Array<{ root: string; state: string }> })
        .captures.filter((c) => c.root !== ws[0]).map((c) => [c.root, c.state]);
      const before = await states();

      assert.equal((await call({ verb: 'detach', target: ws[0]! })).ok, true);

      assert.deepEqual(await states(), before);
      await record(call, ws[32]!);
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
