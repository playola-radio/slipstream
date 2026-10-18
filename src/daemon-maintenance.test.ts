import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
import { createLog } from './log.ts';
import { STALE_MS } from './lock.ts';
import { loadIntent } from './intent-store.ts';
import { blobPath, findWorkspaceSession, sessionLogPath, tombstonePath } from './store-reader.ts';
import type { Platform } from './platform.ts';
import {
  captureRow, chatOf, claimCheck, connect, controlCall, createRootsPlatform, fillableStore, linkRecording, readLog, rec,
  waitForLog, waitForRow, type Call, type LogRecord,
} from './test/daemon-harness.ts';

/** A daemon over a throwaway store, with sibling workspace roots on demand, and
 * a hold on any one root's watcher close: the first step of stopping a capture. */
async function withStore(
  fn: (ctx: { store: string; call: Call; daemon: Daemon; roots: (n: number) => Promise<string[]>;
    fake: ReturnType<typeof createRootsPlatform>; holdClose: (root: string) => { held: Promise<void>; release: () => void } }) => Promise<void>,
  opts: { deps?: DaemonOptions['captureDependencies']; daemon?: Partial<DaemonOptions>; stopError?: boolean } = {},
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-maint-'));
  await chmod(store, 0o700);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-maint-roots-')));
  const fake = createRootsPlatform();
  const holds = new Map<string, { gate: Promise<void>; entered: () => void }>();
  const platform: Platform = {
    watch: async (o) => {
      const sub = await fake.platform.watch(o);
      return { close: async () => {
        const hold = holds.get(o.root);
        if (hold) {
          holds.delete(o.root);
          hold.entered();
          await hold.gate;
        }
        await sub.close();
      } };
    },
  };
  const holdClose = (root: string) => {
    let entered!: () => void; const held = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    holds.set(root, { gate, entered });
    return { held, release };
  };
  const daemon = await startDaemon({
    storeDir: store,
    captureDependencies: { platform, enumerate: async () => {}, readQuestionContext: async () => 'selected', ...opts.deps },
    ...opts.daemon,
  });
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
    await fn({ store, call: controlCall(daemon.socketPath, 30_000), daemon, roots, fake, holdClose });
  } finally {
    if (opts.stopError) await daemon.stop().catch(() => {});
    else await daemon.stop();
    await rm(store, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

const recording = (row: Record<string, unknown>) => row.state === 'recording';

async function attachRecording(call: Call, root: string): Promise<string> {
  const res = await call({ verb: 'attach', mode: 'watch-only', worktree: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  const id = rec(res).session_id!;
  await waitForRow(call, id, recording);
  return id;
}

/** The records from the maintenance stop on: the stop, the resume, its gap. */
function maintenanceCycle(log: LogRecord[]): string[] {
  const at = log.findIndex((r) => r.type === 'slipstream.capture.stopped.v1' && r.data.reason === 'maintenance');
  return at < 0 ? [] : log.slice(at, at + 3).map((r) => r.type === 'slipstream.capture.stopped.v1' ? `stopped:${String(r.data.reason)}`
    : r.type === 'slipstream.capture.gap.v1' ? `gap:${String(r.data.reason)}` : r.type);
}

const MAINTENANCE_CYCLE = ['stopped:maintenance', 'slipstream.session.resumed.v1', 'gap:restart'];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function seedBlob(store: string, sha: string): Promise<void> {
  const path = blobPath(store, sha);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'unreferenced');
}

const DEAD = 'd'.repeat(64);

/** Take a session's ownership lock as a process that has since stopped refreshing
 * it: its holder loses the lock, and gc finds no fresh writer there. */
async function stealSessionLock(store: string, id: string): Promise<void> {
  const lock = join(store, 'sessions', id, 'owner.lock');
  const thief = `${lock}.thief`;
  await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief' }));
  const old = (Date.now() - STALE_MS - 5_000) / 1000;
  await utimes(thief, old, old);
  await rename(thief, lock);
}

function changedTo(sha: string) {
  return (log: LogRecord[]) => log.some((r) => r.type === 'slipstream.file.changed.v1'
    && (r.data.after as { sha256?: string } | undefined)?.sha256 === sha);
}

describe('delete_session beside running captures', () => {
  it('deletes a detached session while other workspaces keep recording', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [a, b, c] = await roots(3);
      const idA = await attachRecording(call, a!);
      const idB = await attachRecording(call, b!);
      const { id: idC } = await linkRecording(call, store, c!, 'chat-c');
      assert.equal((await call({ verb: 'detach', target: idC })).ok, true);
      const res = await call({ verb: 'delete_session', session_id: idC });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(await exists(tombstonePath(store, idC)), true);
      assert.equal(await exists(sessionLogPath(store, idC)), false);
      const intent = await loadIntent(store);
      assert.deepEqual(intent.captures.map((e) => e.session_id), [idA, idB]);
      assert.equal(intent.bindings.some((e) => e.session_id === idC), false);
      for (const id of [idA, idB]) assert.equal((await captureRow(call, id)).state, 'recording');
      assert.equal((rec(await call({ verb: 'status' })) as unknown as { captures: unknown[] }).captures.length, 2);
    });
  });

  it('refuses to delete a waiting capture or one that is still stopping', async () => {
    await withStore(async ({ call, roots, holdClose }) => {
      const ws = await roots(17);
      for (const w of ws.slice(0, 16)) await call({ verb: 'attach', mode: 'watch-only', worktree: w });
      const waiting = await call({ verb: 'attach', mode: 'watch-only', worktree: ws[16] });
      assert.equal(waiting.ok === false && waiting.code, 'CAPTURE_LIMIT_REACHED');
      const rows = rec(await call({ verb: 'status' })) as unknown as { captures: { session_id: string; root: string }[] };
      const waitingId = rows.captures.find((r) => r.root === ws[16])!.session_id;
      const del = await call({ verb: 'delete_session', session_id: waitingId });
      assert.equal(del.ok === false && del.code, 'SESSION_ACTIVE');

      const stoppingId = rows.captures.find((r) => r.root === ws[0])!.session_id;
      await waitForRow(call, stoppingId, recording);
      const hold = holdClose(ws[0]!);
      const detaching = call({ verb: 'detach', target: stoppingId });
      await hold.held;
      const busy = await call({ verb: 'delete_session', session_id: stoppingId });
      assert.equal(busy.ok === false && busy.code, 'SESSION_ACTIVE');
      hold.release();
      assert.equal((await detaching).ok, true);
    });
  });

  it('never lets an attach racing the delete of its own session write into the deleted session', async () => {
    let hold = false;
    let entered!: () => void; const entering = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    // Holds an attach after its lookup has already found the session to resume.
    const workspaceLookup: typeof findWorkspaceSession = async (s, r) => {
      const found = await findWorkspaceSession(s, r);
      if (hold) { hold = false; entered(); await gate; }
      return found;
    };
    await withStore(async ({ store, call, roots }) => {
      const [a, b] = await roots(2);
      const idB = await attachRecording(call, b!);
      const id = await attachRecording(call, a!);
      assert.equal((await call({ verb: 'detach', target: id })).ok, true);
      hold = true;
      const attaching = call({ verb: 'attach', mode: 'watch-only', worktree: a });
      await entering;
      assert.equal((await call({ verb: 'delete_session', session_id: id })).ok, true);
      release();
      const raced = await attaching;
      assert.equal(raced.ok === false && raced.code, 'CAPTURE_NOT_READY', JSON.stringify(raced));
      assert.equal(await exists(sessionLogPath(store, id)), false);
      assert.equal(await exists(join(store, 'sessions', id, 'owner.lock')), false);
      const fresh = await attachRecording(call, a!);
      assert.notEqual(fresh, id);
      assert.equal(await exists(sessionLogPath(store, id)), false);
      assert.equal((await captureRow(call, idB)).state, 'recording');
    }, { daemon: { workspaceLookup } });
  });

  it('keeps a racing attach out when the tombstone landed but could not be made durable', async () => {
    let hold = false;
    let entered!: () => void; const entering = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const workspaceLookup: typeof findWorkspaceSession = async (s, r) => {
      const found = await findWorkspaceSession(s, r);
      if (hold) { hold = false; entered(); await gate; }
      return found;
    };
    await withStore(async ({ store, call, roots }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      assert.equal((await call({ verb: 'detach', target: id })).ok, true);
      hold = true;
      const attaching = call({ verb: 'attach', mode: 'watch-only', worktree: a });
      await entering;
      // Write-only: the tombstone rename succeeds, the directory fsync cannot open it.
      const dir = join(store, 'sessions', id);
      await chmod(dir, 0o300);
      try {
        const res = await call({ verb: 'delete_session', session_id: id });
        assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
        assert.equal(await exists(tombstonePath(store, id)), true);
        release();
        const raced = await attaching;
        assert.equal(raced.ok === false && raced.code, 'CAPTURE_NOT_READY', JSON.stringify(raced));
      } finally {
        release();
        await chmod(dir, 0o700);
      }
    }, { daemon: { workspaceLookup } });
  });

  it('leaves a session resumable when its delete could not write a tombstone', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      assert.equal((await call({ verb: 'detach', target: id })).ok, true);
      const dir = join(store, 'sessions', id);
      await chmod(dir, 0o600);
      try {
        const res = await call({ verb: 'delete_session', session_id: id });
        assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
      } finally {
        await chmod(dir, 0o700);
      }
      assert.equal(await exists(tombstonePath(store, id)), false);
      assert.equal(await attachRecording(call, a!), id);
    });
  });
});

describe('gc as a maintenance transaction', () => {
  it('stops every capture for maintenance, sweeps, then resumes each under its own id with linked chats pending', async () => {
    await withStore(async ({ store, call, roots, holdClose }) => {
      const [a, b, c] = await roots(3);
      const { id: idA } = await linkRecording(call, store, a!, 'chat-a');
      const staleCheck = await claimCheck(call, store, 'chat-a', a!);
      const { id: idB } = await linkRecording(call, store, b!, 'chat-b');
      await connect(call, store, 'chat-b', b!);
      const idC = await attachRecording(call, c!);
      await seedBlob(store, DEAD);

      const hold = holdClose(c!);
      const collecting = call({ verb: 'gc' });
      await hold.held;
      for (const id of [idA, idB]) {
        const row = await waitForRow(call, id, (r) => r.state === 'stopped', 'the maintenance stop');
        assert.equal(row.reason, 'maintenance');
        assert.equal((row.binding as Record<string, unknown>).state, 'setup_pending');
      }
      const during = await call({ verb: 'attach', mode: 'watch-only', worktree: (await roots(1))[0] });
      assert.equal(during.ok === false && during.code, 'CAPTURE_NOT_READY');
      hold.release();

      const res = await collecting;
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(rec(res).removed, 1);
      assert.equal(await exists(blobPath(store, DEAD)), false);
      for (const id of [idA, idB, idC]) {
        await waitForRow(call, id, recording);
        assert.deepEqual(maintenanceCycle(await readLog(store, id)), MAINTENANCE_CYCLE);
      }

      for (const [id, chat] of [[idA, 'chat-a'], [idB, 'chat-b']] as const) {
        await waitForLog(store, id, (log) => log.slice(log.findIndex((r) => r.type === 'slipstream.session.resumed.v1'))
          .some((r) => r.type === 'slipstream.agent.connection.v1' && r.data.state === 'setup_pending'));
        assert.equal(((await captureRow(call, id)).binding as Record<string, unknown>).state, 'setup_pending', chat);
      }
      const stale = await call({ verb: 'answer_question', ...chatOf('chat-a', a!), question_id: staleCheck.check_id, text: 'late' });
      assert.equal(stale.ok, false, 'a check issued before gc must not connect');
      assert.equal(((await captureRow(call, idA)).binding as Record<string, unknown>).state, 'setup_pending');
      await connect(call, store, 'chat-a', a!);
      await connect(call, store, 'chat-b', b!);
      for (const id of [idA, idB]) assert.equal(((await captureRow(call, id)).binding as Record<string, unknown>).state, 'connected');
    });
  });

  it('keeps a chat link whose publication was in flight when gc began', async () => {
    let holdBinding = false;
    let entered!: () => void; const entering = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const heldLog: typeof createLog = async (o) => {
      const log = await createLog(o);
      return { ...log, append: async (input) => {
        if (holdBinding && input.type === 'slipstream.agent.binding.v1') { holdBinding = false; entered(); await gate; }
        return log.append(input);
      } };
    };
    await withStore(async ({ store, call, roots }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      holdBinding = true;
      const linking = linkRecording(call, store, a!, 'chat-a');
      await entering;
      const collecting = call({ verb: 'gc' });
      await new Promise((r) => setTimeout(r, 50));
      release();
      assert.equal((await linking).id, id);
      assert.equal((await collecting).ok, true);
      assert.equal((await loadIntent(store)).bindings.find((e) => e.session_id === id)?.intent, 'linked');
      await waitForRow(call, id, recording);
      assert.deepEqual(maintenanceCycle(await readLog(store, id)), MAINTENANCE_CYCLE);
      await connect(call, store, 'chat-a', a!);
    }, { deps: { createLog: heldLog } });
  });

  it('leaves waiting captures waiting, in the same order', { timeout: 60_000 }, async () => {
    await withStore(async ({ store, call, roots }) => {
      const ws = await roots(18);
      for (const w of ws) await call({ verb: 'attach', mode: 'watch-only', worktree: w });
      const before = (await loadIntent(store)).captures.map((e) => [e.session_id, e.intent]);
      for (const [id] of before.slice(0, 16)) await waitForRow(call, id!, recording);
      assert.equal((await call({ verb: 'gc' })).ok, true);
      assert.deepEqual((await loadIntent(store)).captures.map((e) => [e.session_id, e.intent]), before);
      for (const [id] of before.slice(0, 16)) await waitForRow(call, id!, recording);
      for (const [id] of before.slice(16)) {
        const row = await captureRow(call, id!);
        assert.deepEqual([row.state, row.reason], ['not_recording', 'capture-limit-reached']);
      }
    });
  });

  it('keeps a blob an in-flight change is about to reference', async () => {
    let holdAppend = false;
    let entered!: () => void; const entering = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const heldLog: typeof createLog = async (o) => {
      const log = await createLog(o);
      return { ...log, append: async (input) => {
        if (holdAppend && input.type === 'slipstream.file.changed.v1') { holdAppend = false; entered(); await gate; }
        return log.append(input);
      } };
    };
    await withStore(async ({ store, call, roots, fake }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      await writeFile(join(a!, 'z.txt'), 'only the held change names this');
      const sha = sha256('only the held change names this');
      holdAppend = true;
      fake.observe(a!, 'z.txt');
      await entering;
      assert.equal(await exists(blobPath(store, sha)), true, 'the blob is durable before its event');
      const collecting = call({ verb: 'gc' });
      await new Promise((r) => setTimeout(r, 50));
      release();
      assert.equal((await collecting).ok, true);
      assert.equal(await exists(blobPath(store, sha)), true);
      assert.ok(changedTo(sha)(await readLog(store, id)));
      await waitForRow(call, id, recording);
    }, { deps: { createLog: heldLog } });
  });

  it('re-publishes a swept blob that a resumed capture needs again', async () => {
    await withStore(async ({ store, call, roots, fake }) => {
      const [a, b] = await roots(2);
      const content = 'shared content';
      const sha = sha256(content);
      const idB = await attachRecording(call, b!);
      await writeFile(join(b!, 'z.txt'), content);
      fake.observe(b!, 'z.txt');
      await waitForLog(store, idB, changedTo(sha));
      assert.equal((await call({ verb: 'detach', target: idB })).ok, true);
      assert.equal((await call({ verb: 'delete_session', session_id: idB })).ok, true);
      const idA = await attachRecording(call, a!);
      assert.equal((await call({ verb: 'gc' })).ok, true);
      assert.equal(await exists(blobPath(store, sha)), false, 'gc swept the blob nothing references');
      await waitForRow(call, idA, recording);
      await writeFile(join(a!, 'z.txt'), content);
      fake.observe(a!, 'z.txt');
      await waitForLog(store, idA, changedTo(sha));
      assert.equal(await exists(blobPath(store, sha)), true, 'the resumed capture wrote the blob again');
    });
  });

  it('waits for a detach still draining when its session lock is lost, so no later event names a swept blob', { timeout: 30_000 }, async (t) => {
    let holdAppend = false;
    let entered!: () => void; const entering = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const heldLog: typeof createLog = async (o) => {
      const log = await createLog(o);
      return { ...log, append: async (input) => {
        if (holdAppend && input.type === 'slipstream.file.changed.v1') { holdAppend = false; entered(); await gate; }
        return log.append(input);
      } };
    };
    let lost!: () => void; const losing = new Promise<void>((r) => { lost = r; });
    const error = console.error;
    t.mock.method(console, 'error', (...args: unknown[]) => {
      if (/lost its lock/.test(String(args[0]))) lost();
      else error(...args);
    });
    await withStore(async ({ store, call, roots, fake, holdClose }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      await writeFile(join(a!, 'z.txt'), 'only the queued change names this');
      const sha = sha256('only the queued change names this');
      holdAppend = true;
      fake.observe(a!, 'z.txt');
      await entering;
      // The detach's stop reaches the watcher, then drains the queued append.
      const hold = holdClose(a!);
      const detaching = call({ verb: 'detach', target: id });
      await hold.held;
      hold.release();
      await stealSessionLock(store, id);
      await losing;
      const collecting = call({ verb: 'gc' });
      await Promise.race([collecting, new Promise((r) => setTimeout(r, 300))]);
      release();
      await detaching;
      const res = await collecting;
      for (const r of await readLog(store, id)) {
        const after = (r.data.after as { sha256?: string } | undefined)?.sha256;
        if (after) assert.equal(await exists(blobPath(store, after)), true, `seq ${r.seq} names blob ${after}, which must be on disk`);
      }
      assert.ok(changedTo(sha)(await readLog(store, id)), 'the queued change landed');
      assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
    }, { deps: { createLog: heldLog }, stopError: true });
  });

  it('resumes every capture under its own id when the sweep fails', async () => {
    await withStore(async ({ store, call, roots }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      const corrupt = join(store, 'sessions', '99999999-9999-4999-8999-999999999999');
      await mkdir(corrupt, { recursive: true });
      await writeFile(join(corrupt, 'events.jsonl'), '{not json\n');
      await seedBlob(store, DEAD);
      const res = await call({ verb: 'gc' });
      assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
      assert.equal(await exists(blobPath(store, DEAD)), true);
      await waitForRow(call, id, recording);
      assert.deepEqual(maintenanceCycle(await readLog(store, id)), MAINTENANCE_CYCLE);
    });
  });

  it('sweeps nothing on a full disk, manufactures no stop, and resumes every capture once space returns', async () => {
    const disk = fillableStore();
    await withStore(async ({ store, call, roots, fake }) => {
      const [a, b] = await roots(2);
      const idA = await attachRecording(call, a!);
      const idB = await attachRecording(call, b!);
      await seedBlob(store, DEAD);
      await writeFile(join(a!, 'x.ts'), 'x');
      disk.full = true;
      fake.observe(a!, 'x.ts');
      await waitForRow(call, idA, (r) => r.reason === 'storage-unavailable', 'the full store to be reported');
      const res = await call({ verb: 'gc' });
      assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
      assert.equal(await exists(blobPath(store, DEAD)), true, 'nothing is swept while a writer is unproven');
      for (const id of [idA, idB]) {
        assert.ok(!(await readLog(store, id)).some((r) => r.type === 'slipstream.capture.stopped.v1'), 'no stop is manufactured');
      }
      disk.full = false;
      for (const id of [idA, idB]) {
        await waitForRow(call, id, recording);
        assert.ok((await readLog(store, id)).some((r) => r.type === 'slipstream.capture.gap.v1' && r.data.reason === 'restart'));
      }
    }, { deps: { createLog: disk.createLog }, daemon: { retryBackoff: { baseMs: 20, maxMs: 100 } } });
  });

  it('records no maintenance stop and sweeps nothing when the store lock is lost mid-gc', { timeout: 30_000 }, async () => {
    await withStore(async ({ store, call, roots, holdClose }) => {
      const [a] = await roots(1);
      const id = await attachRecording(call, a!);
      await seedBlob(store, DEAD);
      const hold = holdClose(a!);
      const collecting = call({ verb: 'gc' }).catch((err: Error) => err);
      await hold.held;
      const thief = join(store, 'thief');
      await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief' }));
      await rename(thief, join(store, 'owner.lock'));
      for (let i = 0; i < 300; i++) {
        const res = await controlCall(join(store, 'control.sock'), 1000)({ verb: 'status' }).catch(() => undefined);
        if (!res || (res.ok === false && res.code === 'STORAGE_UNAVAILABLE')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      hold.release();
      await collecting;
      for (let i = 0; i < 200 && await exists(join(store, 'sessions', id, 'owner.lock')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(await exists(join(store, 'sessions', id, 'owner.lock')), false, 'the capture stopped writing');
      assert.ok(!(await readLog(store, id)).some((r) => r.type === 'slipstream.capture.stopped.v1'), 'no stop is manufactured');
      assert.equal(await exists(blobPath(store, DEAD)), true);
    }, { stopError: true });
  });

  it('sweeps nothing when a detach gc waited on could not record its stop', async () => {
    const disk = fillableStore();
    await withStore(async ({ store, call, roots, holdClose }) => {
      const [a, b] = await roots(2);
      const idA = await attachRecording(call, a!);
      const idB = await attachRecording(call, b!);
      await seedBlob(store, DEAD);
      const holdA = holdClose(a!);
      const detaching = call({ verb: 'detach', target: idA });
      await holdA.held;
      const holdB = holdClose(b!);
      const collecting = call({ verb: 'gc' });
      // gc is stopping B, so it is already waiting on A's detach.
      await holdB.held;
      disk.full = true;
      holdA.release();
      const detached = await detaching;
      assert.equal(detached.ok === false && detached.code, 'STORAGE_UNAVAILABLE', JSON.stringify(detached));
      disk.full = false;
      holdB.release();
      const res = await collecting;
      assert.equal(res.ok === false && res.code, 'STORAGE_UNAVAILABLE', JSON.stringify(res));
      assert.match(res.ok === false ? res.message : '', new RegExp(`capture ${idA} stopped without recording its stop`));
      assert.equal(await exists(blobPath(store, DEAD)), true, 'nothing is swept past an unrecorded stop');
      await waitForRow(call, idB, recording);
    }, { deps: { createLog: disk.createLog }, stopError: true });
  });

  it('still sweeps after an earlier detach failed to record its stop, without recording one for it', async () => {
    const disk = fillableStore();
    await withStore(async ({ store, call, roots }) => {
      const [a, b] = await roots(2);
      const idA = await attachRecording(call, a!);
      const idB = await attachRecording(call, b!);
      await seedBlob(store, DEAD);
      disk.full = true;
      const detached = await call({ verb: 'detach', target: idA });
      assert.equal(detached.ok === false && detached.code, 'STORAGE_UNAVAILABLE', JSON.stringify(detached));
      disk.full = false;

      const res = await call({ verb: 'gc' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(rec(res).removed, 1);
      assert.equal(await exists(blobPath(store, DEAD)), false, 'the unreferenced blob is swept');
      assert.ok(!(await readLog(store, idA)).some((r) => r.type === 'slipstream.capture.stopped.v1'), 'no stop is manufactured');
      await waitForRow(call, idB, recording);
    }, { deps: { createLog: disk.createLog }, stopError: true });
  });

  it('records no stop for a detach gc waited on once the store lock is lost', { timeout: 30_000 }, async () => {
    await withStore(async ({ store, call, roots, holdClose }) => {
      const [a] = await roots(1);
      const { id } = await linkRecording(call, store, a!, 'chat-a');
      const hold = holdClose(a!);
      const detaching = call({ verb: 'detach', target: id }).catch((err: Error) => err);
      await hold.held;
      const collecting = call({ verb: 'gc' }).catch((err: Error) => err);
      const thief = join(store, 'thief');
      await writeFile(thief, JSON.stringify({ pid: process.pid, nonce: 'thief' }));
      await rename(thief, join(store, 'owner.lock'));
      for (let i = 0; i < 300; i++) {
        const res = await controlCall(join(store, 'control.sock'), 1000)({ verb: 'status' }).catch(() => undefined);
        if (!res || (res.ok === false && res.code === 'STORAGE_UNAVAILABLE')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      hold.release();
      await Promise.all([detaching, collecting]);
      for (let i = 0; i < 200 && await exists(join(store, 'sessions', id, 'owner.lock')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const log = await readLog(store, id);
      assert.ok(!log.some((r) => r.type === 'slipstream.capture.stopped.v1' || r.type === 'slipstream.agent.unlinked.v1'),
        'no stop is recorded after the store lock is lost');
    }, { stopError: true });
  });

  it('lets a detach during gc withdraw its capture, which then stays stopped', async () => {
    await withStore(async ({ store, call, roots, holdClose }) => {
      const [a, b] = await roots(2);
      const { id: idA } = await linkRecording(call, store, a!, 'chat-a');
      const idB = await attachRecording(call, b!);
      const hold = holdClose(b!);
      const collecting = call({ verb: 'gc' });
      await hold.held;
      await waitForRow(call, idA, (r) => r.state === 'stopped', 'the maintenance stop');
      const unlink = await call({ verb: 'unlink', session_id: idA });
      assert.equal(unlink.ok === false && unlink.code, 'CAPTURE_NOT_READY');
      const detached = await call({ verb: 'detach', target: idA });
      assert.equal(detached.ok, true, JSON.stringify(detached));
      hold.release();
      assert.equal((await collecting).ok, true);
      await waitForRow(call, idB, recording);
      const row = await captureRow(call, idA);
      assert.deepEqual([row.state, row.reason], ['stopped', 'detached']);
      assert.equal((await loadIntent(store)).captures.find((e) => e.session_id === idA)?.intent, 'withdrawn');
      assert.ok(!(await readLog(store, idA)).some((r) => r.type === 'slipstream.session.resumed.v1'));
    });
  });
});
