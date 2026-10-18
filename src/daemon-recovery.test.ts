import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
import { admitCapture, emptyIntent } from './capture-intent.ts';
import { loadIntent, saveIntent, unlinkOffline, withdrawOffline } from './intent-store.ts';
import { publishTombstone } from './maintenance.ts';
import { sessionLogPath } from './store-reader.ts';
import type { Platform } from './platform.ts';
import {
  captureRow, chatOf, claimOf, controlCall, createRootsPlatform, linkChat, readLog, rec, waitForLog, waitForRow,
  type Call, type LogRecord,
} from './test/daemon-harness.ts';

/** A store whose daemon can be stopped and started again, as a crash or a
 * LaunchAgent restart would. */
async function withRestartableStore(fn: (ctx: {
  store: string;
  roots: (n: number) => Promise<string[]>;
  start: (extra?: Partial<DaemonOptions>) => Promise<{ daemon: Daemon; call: Call; fake: ReturnType<typeof createRootsPlatform> }>;
  stop: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-recover-'));
  await chmod(store, 0o700);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-recover-roots-')));
  let daemon: Daemon | undefined;
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
  const start = async (extra: Partial<DaemonOptions> = {}) => {
    const fake = createRootsPlatform();
    daemon = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: fake.platform, enumerate: async () => {}, readQuestionContext: async () => 'selected' },
      ...extra,
    });
    return { daemon, call: controlCall(daemon.socketPath), fake };
  };
  const stop = async () => {
    const d = daemon;
    daemon = undefined;
    await d?.stop();
  };
  try {
    await fn({ store, roots, start, stop });
  } finally {
    await stop();
    await rm(store, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

const recording = (row: Record<string, unknown>) => row.state === 'recording';

async function attachRecording(call: Call, root: string): Promise<string> {
  const id = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: root })).session_id!;
  await waitForRow(call, id, recording);
  return id;
}

function typesAfterRestart(log: { type: string; data: Record<string, unknown> }[]): string[] {
  const at = log.findIndex((r) => r.type === 'slipstream.session.resumed.v1');
  return at < 0 ? [] : log.slice(at, at + 2).map((r) => r.type === 'slipstream.capture.gap.v1' ? `gap:${String(r.data.reason)}` : r.type);
}

async function sessionsSeq(daemon: Daemon, id: string): Promise<bigint> {
  const res = await fetch(`${daemon.readerUrl}/v1/sessions`, { headers: { authorization: `Bearer ${daemon.readerToken}` } });
  const rows = (await res.json()) as { id: string; durable_seq: string }[];
  return BigInt(rows.find((r) => r.id === id)?.durable_seq ?? '0');
}

describe('daemon restart recovery', () => {
  it('resumes every running capture under its own session id, disclosing the restart', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a, b] = await roots(2);
      let { call } = await start();
      const ids = [await attachRecording(call, a!), await attachRecording(call, b!)];
      await stop();
      ({ call } = await start());
      for (const [i, id] of ids.entries()) {
        const row = await waitForRow(call, id, recording);
        assert.equal(row.root, [a, b][i]);
        assert.deepEqual(typesAfterRestart(await readLog(store, id)), ['slipstream.session.resumed.v1', 'gap:restart']);
      }
      assert.equal(rec(await call({ verb: 'status' })).captures!.length, 2);
    });
  });

  it('keeps waiting captures waiting across a restart and promotes them in admission order', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const ws = await roots(18);
      let { call } = await start();
      for (const w of ws) await call({ verb: 'attach', mode: 'watch-only', worktree: w });
      const ids = (await loadIntent(store)).captures.map((c) => c.session_id);
      await waitForRow(call, ids[15]!, recording);
      await stop();
      ({ call } = await start());
      for (const id of ids.slice(0, 16)) await waitForRow(call, id, recording);
      for (const id of ids.slice(16)) {
        const row = await captureRow(call, id);
        assert.deepEqual([row.state, row.reason], ['not_recording', 'capture-limit-reached']);
      }
      assert.equal((await call({ verb: 'detach', target: ids[3] })).ok, true);
      await waitForRow(call, ids[16]!, recording);
      assert.equal((await captureRow(call, ids[17]!)).reason, 'capture-limit-reached');
    });
  });

  it('never resumes a capture that was detached before the restart', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      assert.equal((await call({ verb: 'detach', target: id })).ok, true);
      await stop();
      const before = await readFile(sessionLogPath(store, id), 'utf8');
      ({ call } = await start());
      const row = await captureRow(call, id);
      assert.deepEqual([row.state, row.reason], ['stopped', 'detached']);
      assert.equal(await readFile(sessionLogPath(store, id), 'utf8'), before);
    });
  });

  it('honors an archive recorded while no daemon ran: not resumed, and the stop is not backfilled', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      await withdrawOffline(store, { root: a! }, 'archived');
      const before = await readFile(sessionLogPath(store, id), 'utf8');
      ({ call } = await start());
      const row = await captureRow(call, id);
      assert.deepEqual([row.state, row.reason], ['not_recording', 'stop-unconfirmed']);
      assert.equal(await readFile(sessionLogPath(store, id), 'utf8'), before);
    });
  });

  it('stops a capture with reason archived when the archive reaches a running daemon', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call } = await start();
      const id = await attachRecording(call, a!);
      const res = await call({ verb: 'detach', target: a, reason: 'archived' });
      assert.deepEqual([rec(res).state, rec(res).reason], ['stopped', 'archived']);
      const last = (await readLog(store, id)).at(-1)!;
      assert.deepEqual([last.type, last.data.reason], ['slipstream.capture.stopped.v1', 'archived']);
      assert.equal((await loadIntent(store)).captures[0]?.withdrawn_reason, 'archived');
    });
  });

  it('pins every resumed session before the reader is exposed', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      const before = (await readLog(store, id)).length;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { daemon } = await start({ captureDependencies: {
        platform: createRootsPlatform().platform, readQuestionContext: async () => 'selected',
        enumerate: async () => { await held; },
      } });
      try {
        // The resume is mid-reconcile: its resumed and gap records are on disk,
        // but the reader must not publish past the pre-restart high-water.
        for (let i = 0; i < 200 && (await readLog(store, id)).length < before + 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok((await readLog(store, id)).length >= before + 2, 'the resume never reached its reconcile');
        assert.ok(await sessionsSeq(daemon, id) <= BigInt(before));
      } finally {
        release();
      }
      call = controlCall(daemon.socketPath);
      await waitForRow(call, id, recording);
    });
  });

  it('retries a transient start failure with backoff and shows when it will retry', async () => {
    await withRestartableStore(async ({ roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      const fake = createRootsPlatform();
      let failures = 2;
      const platform: Platform = {
        watch: async (o) => {
          if (failures-- > 0) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
          return fake.platform.watch(o);
        },
      };
      let rows: Record<string, unknown>[] = [];
      const started = await start({
        retryBackoff: { baseMs: 100, maxMs: 400 },
        captureDependencies: { platform, enumerate: async () => {}, readQuestionContext: async () => 'selected' },
      });
      call = started.call;
      const failed = await waitForRow(call, id, (row) => row.state === 'not_recording');
      assert.equal(failed.reason, 'resume-failed');
      const res = await fetch(`${started.daemon.readerUrl}/v1/captures`, { headers: { authorization: `Bearer ${started.daemon.readerToken}` } });
      rows = ((await res.json()) as { captures: Record<string, unknown>[] }).captures;
      const retry = rows[0]?.retry as { next_attempt_at_ms: number } | null;
      assert.equal(rows[0]?.reason, 'resume-failed');
      assert.equal(typeof retry?.next_attempt_at_ms, 'number');
      await waitForRow(call, id, recording, 'recording after its retries');
      assert.equal(failures, -1);
      assert.equal((await captureRow(call, id)).retry, null);
    });
  });
});

describe('daemon crash points (contracts.md §6)', () => {
  it('starts a capture admitted just before a crash under its persisted session id', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const record = emptyIntent();
      const id = randomUUID();
      const st = await stat(a!, { bigint: true });
      admitCapture(record, { session_id: id, root: a!, root_identity: { dev: st.dev.toString(), ino: st.ino.toString() } });
      await saveIntent(store, record);
      const { call } = await start();
      await waitForRow(call, id, recording);
      assert.equal((await readLog(store, id))[0]?.type, 'slipstream.session.started.v1');
    });
  });

  it('resumes a capture that crashed after its start but before it was ready', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      const log = await readLog(store, id);
      const ready = log.findIndex((r) => r.type === 'slipstream.capture.ready.v1');
      assert.ok(ready > 0);
      await writeFile(sessionLogPath(store, id), log.slice(0, ready).map((r) => JSON.stringify(r) + '\n').join(''));
      ({ call } = await start());
      await waitForRow(call, id, recording);
      assert.deepEqual(typesAfterRestart(await readLog(store, id)), ['slipstream.session.resumed.v1', 'gap:restart']);
    });
  });

  it('forgets a capture whose session was deleted just before a crash', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await call({ verb: 'detach', target: id });
      await stop();
      await publishTombstone(store, id);
      ({ call } = await start());
      assert.deepEqual(rec(await call({ verb: 'status' })).captures, []);
      assert.deepEqual((await loadIntent(store)).captures, []);
    });
  });
});

/** The records a session appended after its latest resume. */
function sinceResume(log: LogRecord[]): LogRecord[] {
  return log.slice(log.findLastIndex((r) => r.type === 'slipstream.session.resumed.v1'));
}

const pendingAfterResume = (log: LogRecord[]) => sinceResume(log)
  .some((r) => r.type === 'slipstream.agent.connection.v1' && r.data.state === 'setup_pending');

async function linkRecording(call: Call, store: string, root: string, chat: string): Promise<{ id: string; generation: string }> {
  const linked = await linkChat(call, store, root, chat);
  if (!linked.ok) {
    await waitForRow(call, rec(linked).session_id ?? root, recording);
    return linkRecording(call, store, root, chat);
  }
  return { id: rec(linked).session_id!, generation: rec(linked).binding_generation! };
}

/** Claim a chat's setup check, waiting out the moment its link is still being
 * published (the hook would simply call again). */
async function claimCheck(call: Call, store: string, chat: string, root: string): Promise<{ check_id: string }> {
  for (let i = 0; i < 100; i++) {
    const res = await call(claimOf(store, chat, root));
    if (res.ok) {
      const check = (rec(res) as unknown as { setup_check?: { check_id: string } }).setup_check;
      assert.ok(check, `expected a setup check for ${chat}`);
      return check;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${chat} could never claim its setup check`);
}

async function connect(call: Call, store: string, chat: string, root: string): Promise<void> {
  const check = await claimCheck(call, store, chat, root);
  const ack = await call({ verb: 'answer_question', ...chatOf(chat, root), question_id: check.check_id, text: 'connected' });
  assert.equal(ack.ok, true, JSON.stringify(ack));
}

async function bindingState(call: Call, id: string): Promise<Record<string, unknown>> {
  return (await captureRow(call, id)).binding as Record<string, unknown>;
}

describe('linked chats across a daemon restart', () => {
  it('restores each link pending, and each reconnects only through its own chat', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a, b] = await roots(2);
      let { call } = await start();
      const links = [await linkRecording(call, store, a!, 'chat-a'), await linkRecording(call, store, b!, 'chat-b')];
      await connect(call, store, 'chat-a', a!);
      await connect(call, store, 'chat-b', b!);
      await stop();
      ({ call } = await start());
      for (const { id, generation } of links) {
        const after = sinceResume(await waitForLog(store, id, pendingAfterResume));
        assert.equal(after.some((r) => r.type === 'slipstream.agent.binding.v1'), false, 'no new agent.binding on resume');
        assert.equal(after.find((r) => r.type === 'slipstream.agent.connection.v1')?.data.binding_generation, generation);
        assert.equal((await bindingState(call, id)).state, 'setup_pending');
      }
      const checkB = await claimCheck(call, store, 'chat-b', b!);
      const crossed = await call({ verb: 'answer_question', ...chatOf('chat-a', a!), question_id: checkB.check_id, text: 'connected' });
      assert.equal(crossed.ok, false, 'one chat cannot answer another chat\'s check');
      await connect(call, store, 'chat-a', a!);
      assert.equal((await bindingState(call, links[0]!.id)).state, 'connected');
      assert.equal((await bindingState(call, links[1]!.id)).state, 'setup_pending');
      const ack = await call({ verb: 'answer_question', ...chatOf('chat-b', b!), question_id: checkB.check_id, text: 'connected' });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.equal((await bindingState(call, links[1]!.id)).state, 'connected');
    });
  });

  it('offers an unanswered setup check again after its throttle', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call } = await start({ setupReofferMs: 50 });
      await linkRecording(call, store, a!, 'chat-a');
      const first = await claimCheck(call, store, 'chat-a', a!);
      assert.equal((rec(await call(claimOf(store, 'chat-a', a!))) as unknown as { setup_check?: unknown }).setup_check, undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const again = (rec(await call(claimOf(store, 'chat-a', a!))) as unknown as { setup_check?: { check_id: string } }).setup_check;
      assert.equal(again?.check_id, first.check_id);
    });
  });

  it('records a link whose intent was written just before a crash, at its stored generation', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const { id, generation } = await linkRecording(call, store, a!, 'chat-a');
      await stop();
      const log = await readLog(store, id);
      const at = log.findIndex((r) => r.type === 'slipstream.agent.binding.v1');
      assert.ok(at > 0);
      await writeFile(sessionLogPath(store, id), log.slice(0, at).map((r) => JSON.stringify(r) + '\n').join(''));
      ({ call } = await start());
      const after = sinceResume(await waitForLog(store, id, pendingAfterResume));
      const binding = after.find((r) => r.type === 'slipstream.agent.binding.v1');
      assert.equal(binding?.data.binding_generation, generation);
      await connect(call, store, 'chat-a', a!);
    });
  });

  it('does not restore a link revoked while no daemon ran, nor backfill its unlink', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const { id } = await linkRecording(call, store, a!, 'chat-a');
      await stop();
      assert.equal(await unlinkOffline(store, id), true);
      ({ call } = await start());
      await waitForRow(call, id, recording);
      assert.equal((await bindingState(call, id)).state, 'unlinked');
      const after = sinceResume(await readLog(store, id)).map((r) => r.type);
      assert.equal(after.includes('slipstream.agent.unlinked.v1'), false);
      assert.equal(after.includes('slipstream.agent.connection.v1'), false);
      assert.equal((await call(claimOf(store, 'chat-a', a!))).ok, false);
    });
  });

  it('keeps a link whose transcript vanished as unavailable, holding its slot, until the chat attaches again', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const { id } = await linkRecording(call, store, a!, 'chat-a');
      await stop();
      await rm(join(store, 'chat-a.jsonl'));
      ({ call } = await start());
      await waitForRow(call, id, (row) => (row.binding as Record<string, unknown>).state === 'unavailable');
      assert.equal((await bindingState(call, id)).reason, 'transcript-missing');
      assert.equal((await loadIntent(store)).bindings[0]?.unavailable?.reason, 'transcript-missing');
      assert.deepEqual(rec(await call({ verb: 'status' })).binding_slots, { used: 1, limit: 10 });
      assert.equal((await call(claimOf(store, 'chat-a', a!))).ok, false);
      await linkRecording(call, store, a!, 'chat-a');
      assert.equal((await bindingState(call, id)).state, 'setup_pending');
      assert.equal((await loadIntent(store)).bindings[0]?.unavailable, null);
      await connect(call, store, 'chat-a', a!);
      assert.equal((await bindingState(call, id)).state, 'connected');
    });
  });
});

const lastType = (log: LogRecord[]) => log.at(-1)?.type;
const stoppedFor = (log: LogRecord[]) => log.at(-1)?.type === 'slipstream.capture.stopped.v1' ? log.at(-1)?.data.reason : undefined;

describe('a capture whose root or watcher goes away', () => {
  it('stops with root-missing when its live root is deleted', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call, fake } = await start();
      const id = await attachRecording(call, a!);
      await rm(a!, { recursive: true });
      fake.observe(a!, '');
      const log = await waitForLog(store, id, (l) => lastType(l) === 'slipstream.capture.stopped.v1');
      assert.equal(stoppedFor(log), 'root-missing');
      const row = await waitForRow(call, id, (r) => r.state === 'stopped');
      assert.equal(row.reason, 'root-missing');
    });
  });

  it('starts a new session for a root recreated at the same path, inheriting nothing', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call, fake } = await start();
      const id = await attachRecording(call, a!);
      await rm(a!, { recursive: true });
      await mkdir(a!);
      fake.observe(a!, '');
      await waitForLog(store, id, (l) => stoppedFor(l) === 'root-missing');
      const again = await call({ verb: 'attach', mode: 'watch-only', worktree: a });
      assert.equal(again.ok, true, JSON.stringify(again));
      const fresh = rec(again).session_id!;
      assert.notEqual(fresh, id);
      await waitForRow(call, fresh, recording);
      assert.equal((await readLog(store, fresh))[0]?.type, 'slipstream.session.started.v1');
      assert.equal(stoppedFor(await readLog(store, id)), 'root-missing');
      assert.equal((await captureRow(call, a!)).session_id, fresh);
    });
  });

  it('lets a workspace inside a deleted root be captured', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call, fake } = await start();
      const id = await attachRecording(call, a!);
      await rm(a!, { recursive: true });
      fake.observe(a!, '');
      await waitForLog(store, id, (l) => stoppedFor(l) === 'root-missing');
      await mkdir(join(a!, 'inner'), { recursive: true });
      const inner = await call({ verb: 'attach', mode: 'watch-only', worktree: join(a!, 'inner') });
      assert.equal(inner.ok, true, JSON.stringify(inner));
    });
  });

  it('records one watcher-error gap, then stops with watcher-failed, then retries', async () => {
    await withRestartableStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      const { call, fake } = await start({ retryBackoff: { baseMs: 100, maxMs: 100 } });
      const id = await attachRecording(call, a!);
      fake.closeWith(a!, new Error('stream closed'));
      const log = await waitForLog(store, id, (l) => l.some((r) => r.type === 'slipstream.capture.stopped.v1'));
      const tail = log.slice(log.findIndex((r) => r.type === 'slipstream.capture.gap.v1' && r.data.reason === 'watcher-error'));
      assert.deepEqual(tail.slice(0, 2).map((r) => r.type === 'slipstream.capture.stopped.v1' ? `stopped:${String(r.data.reason)}` : `gap:${String(r.data.reason)}`),
        ['gap:watcher-error', 'stopped:watcher-failed']);
      assert.equal(log.filter((r) => r.type === 'slipstream.capture.gap.v1' && r.data.reason === 'watcher-error').length, 1);
      const resumed = await waitForLog(store, id, (l) => l.some((r) => r.type === 'slipstream.session.resumed.v1'));
      assert.equal(resumed.filter((r) => r.type === 'slipstream.session.resumed.v1').length, 1);
      await waitForRow(call, id, recording);
    });
  });

  it('shows a watcher-failed capture as stopped with its retry scheduled', async () => {
    await withRestartableStore(async ({ roots, start }) => {
      const [a] = await roots(1);
      const { call, fake } = await start({ retryBackoff: { baseMs: 60_000, maxMs: 60_000 } });
      const id = await attachRecording(call, a!);
      fake.closeWith(a!, new Error('stream closed'));
      const row = await waitForRow(call, id, (r) => r.state === 'stopped');
      assert.equal(row.reason, 'watcher-failed');
    });
  });

  it('does not resume a capture whose root went missing while the daemon was down', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      const before = (await readLog(store, id)).length;
      await rm(a!, { recursive: true });
      ({ call } = await start());
      const row = await waitForRow(call, id, (r) => r.state === 'not_recording');
      assert.equal(row.reason, 'root-missing');
      assert.equal((await readLog(store, id)).length, before);
    });
  });

  it('does not resume a capture whose root was replaced while the daemon was down', async () => {
    await withRestartableStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await stop();
      const before = (await readLog(store, id)).length;
      await rm(a!, { recursive: true });
      await mkdir(a!);
      ({ call } = await start());
      const row = await waitForRow(call, id, (r) => r.state === 'not_recording');
      assert.equal(row.reason, 'root-missing');
      assert.match(String(row.message), /replaced/);
      assert.equal((await readLog(store, id)).length, before);
    });
  });
});
