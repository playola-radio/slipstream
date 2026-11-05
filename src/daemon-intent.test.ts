import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonAlreadyRunningError, startDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
import { acquireSessionLock } from './lock.ts';
import { intentPath, loadIntent } from './intent-store.ts';
import type { Platform } from './platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import { findWorkspaceSession } from './store-reader.ts';
import {
  captureRow, controlCall, createRootsPlatform, linkChat, readLog, rec, waitForRow, type Call,
} from './test/daemon-harness.ts';

async function withStore(fn: (ctx: { store: string; call: Call; roots: (n: number) => Promise<string[]> }) => Promise<void>,
  platform: Platform = createRootsPlatform().platform, daemonOptions: Partial<DaemonOptions> = {}): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-intent-daemon-'));
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-intent-roots-')));
  const daemon: Daemon = await startDaemon({ ...daemonOptions, storeDir: store, captureDependencies: {
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
const PAUSED = 'CAPTURE_PAUSED: This workspace is paused. Record it in Slipstream first, then attach again.';

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

describe('a chat attach never resumes a paused workspace', () => {
  it('lets a Record request retry after sharing a chat attach refusal', async () => {
    let hold = false;
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const workspaceLookup: typeof findWorkspaceSession = async (store, root) => {
      const result = await findWorkspaceSession(store, root);
      if (hold) {
        hold = false;
        entered();
        await gate;
      }
      return result;
    };
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const id = await pause(call, ws!);
      hold = true;
      const chat = linkChat(call, store, ws!, 'chat-1');
      await entering;
      const recording = call({ verb: 'attach', mode: 'watch-only', worktree: ws! });
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();

      assert.equal(refusal(await chat), PAUSED);
      const resumed = await recording;
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal(rec(resumed).session_id, id);
      await waitForRow(call, id, (row) => row.state === 'recording');
    }, createRootsPlatform().platform, { workspaceLookup });
  });

  it('chat attach of a paused root is refused and changes nothing', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const linked = await linkChat(call, store, ws!, 'chat-1');
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const id = rec(linked).session_id!;
      assert.equal((await call({ verb: 'detach', target: ws! })).ok, true);
      const before = await readFile(intentPath(store), 'utf8');

      assert.equal(refusal(await linkChat(call, store, ws!, 'chat-1')), PAUSED);

      assert.equal(await readFile(intentPath(store), 'utf8'), before);
      assert.equal((await readLog(store, id)).filter((r) => r.type === 'slipstream.session.resumed.v1').length, 0);
    });
  });

  it('chat attach of a root paused before it ever started is refused and changes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const platform: Platform = {
      watch: async () => {
        if (first) { first = false; await held; }
        return { close: async () => {} };
      },
    };
    await withStore(async ({ store, call, roots }) => {
      const [a, b] = await roots(2);
      await call({ verb: 'attach', mode: 'watch-only', worktree: a });
      const queued = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: b }));
      assert.equal((await call({ verb: 'detach', target: queued.session_id })).ok, true);
      const before = await readFile(intentPath(store), 'utf8');
      try {
        assert.equal(refusal(await linkChat(call, store, b!, 'chat-1')), PAUSED);
        assert.equal(await readFile(intentPath(store), 'utf8'), before);
      } finally {
        release();
      }
    }, platform);
  });

  it('a chat attach racing a pause leaves the workspace paused and unlinked', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const id = await record(call, ws!);

      await Promise.all([call({ verb: 'detach', target: ws! }), linkChat(call, store, ws!, 'chat-1')]);

      const after = await loadIntent(store);
      assert.deepEqual(after.captures.map((c) => [c.session_id, c.intent]), [[id, 'withdrawn']]);
      assert.ok(after.bindings.every((b) => b.intent === 'revoked'));
    });
  });

  it('chat attach of a recreated root admits a new session', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      const id = await pause(call, ws!);
      // Made before the old one is removed, so Linux cannot hand back the same inode.
      await mkdir(`${ws!}.new`);
      await rm(ws!, { recursive: true });
      await rename(`${ws!}.new`, ws!);

      const linked = await linkChat(call, store, ws!, 'chat-1');

      assert.equal(linked.ok, true, JSON.stringify(linked));
      assert.notEqual(rec(linked).session_id, id);
    });
  });

  it('paused is reported before full', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [paused, ...ws] = await roots(33);
      await pause(call, paused!);
      for (const root of ws) await record(call, root);
      assert.equal(refusal(await linkChat(call, store, paused!, 'chat-1')), PAUSED);
    });
  });

  it('watch-only attach of a paused root resumes it', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [ws] = await roots(1);
      assert.equal((await linkChat(call, store, ws!, 'chat-1')).ok, true);
      const id = (await captureRow(call, ws!)).session_id as string;
      assert.equal((await call({ verb: 'detach', target: ws! })).ok, true);

      const resumed = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: ws! }));

      assert.equal(resumed.session_id, id);
      const row = await waitForRow(call, id, (r) => r.state === 'recording');
      assert.equal((row.binding as { state: string }).state, 'unlinked');
      const log = await readLog(store, id);
      assert.ok(log.some((r) => r.type === 'slipstream.capture.gap.v1'), 'the paused time is a gap');
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
