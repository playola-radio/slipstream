import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { probeSocket, startDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
import type { Platform } from './platform.ts';
import { bothReaders, foldCaptures, comparable } from './test/captures-fold.ts';
import {
  captureRow, chatOf, claimCheck, claimOf, connect, controlCall, createRootsPlatform, fillableStore, linkChat, linkRecording, readLog, rec, waitForLog,
  waitForRow, type Call,
} from './test/daemon-harness.ts';

/** Release acceptance for workspace auto-capture (docs/autocapture/acceptance.md). */

async function withStore(fn: (ctx: {
  store: string;
  roots: (n: number) => Promise<string[]>;
  start: (extra?: Partial<DaemonOptions>) => Promise<{ daemon: Daemon; call: Call }>;
  stop: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-accept-'));
  await chmod(store, 0o700);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'slip-accept-roots-')));
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
    daemon = await startDaemon({ storeDir: store, captureDependencies: {
      platform: createRootsPlatform().platform, enumerate: async () => {}, readQuestionContext: async () => 'selected',
    }, ...extra });
    return { daemon, call: controlCall(daemon.socketPath, 30_000) };
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

type Row = Record<string, unknown>;
const recording = (row: Record<string, unknown>) => row.state === 'recording';

/** The daemon shows a change before its intent record is written; the offline
 * reader can only follow once the record is. */
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

async function untilIntent(store: string, done: (intent: { captures: Row[]; bindings: Row[] }) => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (done(JSON.parse(await readFile(join(store, 'control', 'intent.json'), 'utf8')))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('the intent record never caught up');
}

async function attachRecording(call: Call, root: string): Promise<string> {
  const res = await call({ verb: 'attach', mode: 'watch-only', worktree: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  await waitForRow(call, rec(res).session_id!, recording);
  return rec(res).session_id!;
}

/** Push heartbeats 60 s back and read both readers at once. Their owners refresh
 * every 2 s; a refresh landing before both reads are over spoils the try, so try
 * again. */
async function readStale<T = undefined>(store: string, daemon: Daemon, locks: string[], extraRead?: () => Promise<T>): Promise<{ projection: Record<string, unknown>; extra: T }> {
  for (let i = 0; i < 5; i++) {
    const old = Math.trunc(Date.now() / 1000) - 60;
    for (const lock of locks) await utimes(lock, old, old);
    const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
    const extra = await extraRead?.();
    const held = await Promise.all(locks.map(async (lock) => Math.trunc((await stat(lock)).mtimeMs / 1000) === old));
    if (!held.every(Boolean)) continue;
    assert.deepEqual(fold, projection, 'stale heartbeats');
    return { projection, extra: extra as T };
  }
  assert.fail('a heartbeat refresh spoiled every try');
}

const rowOf = (table: Record<string, unknown>, id: string) =>
  (table.captures as Row[]).find((r) => r.session_id === id)!;
const stateOf = (row: Row) => [row.state, row.reason, (row.binding as Row | null)?.state ?? null];

describe('auto-capture acceptance: two independent readers', () => {
  it('agree on capture and binding states as the table fills, a slot frees, a heartbeat goes stale, and a transcript goes missing', async () => {
    await withStore(async ({ store, roots, start, stop }) => {
      const { daemon, call } = await start();
      const agree = async (what: string) => {
        const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        assert.deepEqual(fold, projection, what);
        return projection;
      };
      const ws = await roots(18);
      const ids: string[] = [];
      for (const root of ws.slice(0, 16)) ids.push(await attachRecording(call, root));
      const waiting: string[] = [];
      for (const root of [ws[16]!, ws[17]!]) {
        const res = await call({ verb: 'attach', mode: 'watch-only', worktree: root });
        assert.equal(res.ok === false && res.code, 'CAPTURE_LIMIT_REACHED');
        waiting.push((rec(await call({ verb: 'status', target: root })).capture as unknown as Row).session_id as string);
      }
      const [seventeenth, eighteenth] = waiting;
      await linkRecording(call, store, ws[0]!, 'chat-pending');
      await linkRecording(call, store, ws[1]!, 'chat-connected');
      await connect(call, store, 'chat-connected', ws[1]!);
      await linkRecording(call, store, ws[2]!, 'chat-unlinked');
      assert.equal((await call({ verb: 'unlink', session_id: ids[2]! })).ok, true);

      let table = await agree('a full table with linked, connected, and unlinked chats');
      assert.deepEqual(stateOf(rowOf(table, seventeenth!)), ['not_recording', 'capture-limit-reached', null]);
      assert.deepEqual(stateOf(rowOf(table, ids[0]!)), ['recording', null, 'setup_pending']);
      assert.deepEqual(stateOf(rowOf(table, ids[1]!)), ['recording', null, 'connected']);
      assert.deepEqual(stateOf(rowOf(table, ids[2]!)), ['recording', null, 'unlinked']);
      assert.deepEqual(table.binding_slots, { used: 2, limit: 10 });

      const status = rec(await call({ verb: 'status' })) as unknown as { captures: Row[] };
      for (const row of status.captures) {
        assert.deepEqual(stateOf(row), stateOf(rowOf(table, row.session_id as string)), 'status verb and reader agree');
      }

      assert.equal((await call({ verb: 'detach', target: ids[3]! })).ok, true);
      await waitForRow(call, seventeenth!, recording, 'the seventeenth recording once a slot freed');
      assert.equal((await call({ verb: 'detach', target: eighteenth! })).ok, true);
      table = await agree('a freed slot, a promoted workspace, and a withdrawn waiting one');
      assert.deepEqual(stateOf(rowOf(table, ids[3]!)), ['stopped', 'detached', null]);
      assert.deepEqual(stateOf(rowOf(table, seventeenth!)), ['recording', null, null]);
      assert.deepEqual(stateOf(rowOf(table, eighteenth!)), ['stopped', 'detached', null]);

      const owner = join(store, 'sessions', ids[4]!, 'owner.lock');
      table = (await readStale(store, daemon, [owner])).projection;
      assert.deepEqual(stateOf(rowOf(table, ids[4]!)), ['queued', null, null],
        'no live owner, but a live daemon: not recording, waiting on the daemon');
      table = (await readStale(store, daemon, [owner, join(store, 'owner.lock')])).projection;
      assert.deepEqual(stateOf(rowOf(table, ids[4]!)), ['not_recording', 'daemon-unavailable', null]);

      await stop();
      const offline = comparable(await foldCaptures(store, Date.now()));
      assert.deepEqual(stateOf(rowOf(offline, ids[0]!)), ['not_recording', 'daemon-unavailable', 'setup_pending'],
        'with no daemon, a running capture is not recording; its chat was never confirmed in a live activation');
      assert.deepEqual(stateOf(rowOf(offline, ids[3]!)), ['stopped', 'detached', null]);

      await rm(join(store, 'chat-pending.jsonl'));
      const restarted = await start();
      for (const id of [...ids.filter((id) => id !== ids[3]), seventeenth!]) await waitForRow(restarted.call, id, recording);
      await waitForRow(restarted.call, ids[0]!, (row) => (row.binding as Row).state === 'unavailable');
      await untilIntent(store, (intent) => intent.bindings.some((b) => b.session_id === ids[0] && b.unavailable !== null));
      const { projection, fold } = await bothReaders(store, restarted.daemon.readerUrl, restarted.daemon.readerToken);
      assert.deepEqual(fold, projection, 'after a restart, with one chat transcript gone');
      assert.deepEqual(stateOf(rowOf(projection, ids[0]!)), ['recording', null, 'unavailable']);
    });
  });
});

describe('auto-capture acceptance: a capture still baselining', () => {
  it('reads as baselining to both readers until its baseline finishes', async () => {
    await withStore(async ({ store, roots, start }) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { daemon, call } = await start({ captureDependencies: {
        platform: createRootsPlatform().platform, enumerate: async () => held, readQuestionContext: async () => 'selected' } });
      const [a] = await roots(1);
      const id = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: a! })).session_id!;
      try {
        // The daemon shows baselining a moment before the heartbeat and session.started
        // that let an offline reader see it; compare once both are on disk.
        const settled = (t: Record<string, unknown>) => rowOf(t, id).state === 'baselining';
        let both = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        for (let i = 0; i < 100 && !(settled(both.projection) && settled(both.fold)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          both = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        }
        assert.deepEqual(both.fold, both.projection);
        assert.deepEqual(stateOf(rowOf(both.projection, id)), ['baselining', null, null]);
      } finally {
        release();
      }
      await waitForRow(call, id, recording);
    });
  });
});

describe('auto-capture acceptance: a capture waiting for the baseline slot', () => {
  /** Hold every baseline, admit two captures, and run `fn` with the second one
   * still waiting behind the first. */
  async function withQueued(fn: (ctx: { store: string; daemon: Daemon; queued: string; stop: () => Promise<void> }) => Promise<void>) {
    await withStore(async ({ store, roots, start, stop }) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      try {
        const { daemon, call } = await start({ captureDependencies: {
          platform: createRootsPlatform().platform, enumerate: async () => held, readQuestionContext: async () => 'selected' } });
        const [a, b] = await roots(2);
        const first = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: a! })).session_id!;
        await waitForRow(call, first, (row) => row.state === 'baselining');
        const queued = rec(await call({ verb: 'attach', mode: 'watch-only', worktree: b! })).session_id!;
        await untilIntent(store, (intent) => intent.captures.some((c) => c.session_id === queued));
        await fn({ store, daemon, queued, stop: async () => { const stopping = stop(); release(); await stopping; } });
      } finally {
        release();
      }
    });
  }

  it('reads as queued to both readers while the daemon holds the store', async () => {
    await withQueued(async ({ store, daemon, queued }) => {
      const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
      assert.deepEqual(fold, projection);
      assert.deepEqual(stateOf(rowOf(projection, queued)), ['queued', null, null]);
    });
  });

  it('reads as daemon-unavailable to both readers once the store heartbeat goes stale, and with the daemon gone', async () => {
    await withQueued(async ({ store, daemon, queued, stop }) => {
      const table = (await readStale(store, daemon, [join(store, 'owner.lock')])).projection;
      assert.deepEqual(stateOf(rowOf(table, queued)), ['not_recording', 'daemon-unavailable', null]);

      await stop();
      await assert.rejects(stat(join(store, 'sessions', queued, 'events.jsonl')), { code: 'ENOENT' }, 'it never began');
      const offline = comparable(await foldCaptures(store, Date.now()));
      assert.deepEqual(stateOf(rowOf(offline, queued)), ['not_recording', 'daemon-unavailable', null]);
    });
  });

  it('reads a restarted capture still waiting to resume as queued to both readers', async () => {
    await withStore(async ({ store, roots, start, stop }) => {
      const first = await start();
      const [a, b] = await roots(2);
      await attachRecording(first.call, a!);
      const waiting = await attachRecording(first.call, b!);
      await stop();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { daemon, call } = await start({ captureDependencies: {
        platform: createRootsPlatform().platform, enumerate: async () => held, readQuestionContext: async () => 'selected' } });
      try {
        const resuming = (await captureRow(call, waiting)).state === 'queued' ? waiting : undefined;
        assert.ok(resuming, 'the second capture waits while the first resumes');
        const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        assert.deepEqual(fold, projection);
        assert.deepEqual(stateOf(rowOf(projection, waiting)), ['queued', null, null]);
      } finally {
        release();
      }
    });
  });

  it('reads a connected chat as setup pending to both readers once its session heartbeat goes stale under a live daemon', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { daemon, call } = await start();
      const [a] = await roots(1);
      const { id } = await linkRecording(call, store, a!, 'chat-a');
      await connect(call, store, 'chat-a', a!);
      const { projection: table, extra: status } = await readStale(store, daemon, [join(store, 'sessions', id, 'owner.lock')],
        async () => rec(await call({ verb: 'status', target: id })).capture as unknown as Row);
      assert.deepEqual(stateOf(rowOf(table, id)), ['queued', null, 'setup_pending']);
      assert.deepEqual(stateOf(status), ['queued', null, 'setup_pending'],
        'control status applies the same heartbeat rule as the public reader');
    });
  });

  it('reads a chat connected before the restart as setup pending to both readers while its capture waits to resume', async () => {
    await withStore(async ({ store, roots, start, stop }) => {
      const first = await start();
      const [a, b] = await roots(2);
      await attachRecording(first.call, a!);
      const { id: waiting } = await linkRecording(first.call, store, b!, 'chat-b');
      await connect(first.call, store, 'chat-b', b!);
      await stop();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const { daemon, call } = await start({ captureDependencies: {
        platform: createRootsPlatform().platform, enumerate: async () => held, readQuestionContext: async () => 'selected' } });
      try {
        assert.equal((await captureRow(call, waiting)).state, 'queued', 'the linked capture waits while the first resumes');
        const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        assert.deepEqual(fold, projection);
        assert.deepEqual(stateOf(rowOf(projection, waiting)), ['queued', null, 'setup_pending']);
      } finally {
        release();
      }
    });
  });
});

describe('auto-capture acceptance: failure states', () => {
  /** The daemon shows a failure a moment before the files that let an offline
   * reader see it; compare once they have caught up. */
  async function agreeOnce(store: string, daemon: Daemon, settled: (table: Record<string, unknown>) => boolean, what: string) {
    let both = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
    for (let i = 0; i < 150 && !(settled(both.projection) && settled(both.fold)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      both = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
    }
    assert.deepEqual(both.fold, both.projection, what);
    return both.projection;
  }

  it('read root-missing, watcher-failed and storage-unavailable the same to both readers', async () => {
    const disk = fillableStore();
    await withStore(async ({ store, roots, start }) => {
      const fake = createRootsPlatform();
      const { daemon, call } = await start({ retryBackoff: { baseMs: 60_000, maxMs: 60_000 }, captureDependencies: {
        platform: fake.platform, enumerate: async () => {}, readQuestionContext: async () => 'selected', createLog: disk.createLog } });
      const [gone, closed, full] = await roots(3);
      const ids = { gone: await attachRecording(call, gone!), closed: await attachRecording(call, closed!), full: await attachRecording(call, full!) };

      await rm(gone!, { recursive: true });
      fake.observe(gone!, '');
      fake.closeWith(closed!, new Error('stream closed'));
      let table = await agreeOnce(store, daemon, (t) => rowOf(t, ids.gone).state === 'stopped' && rowOf(t, ids.closed).retry !== null,
        'a deleted root and a closed watcher');
      assert.deepEqual(stateOf(rowOf(table, ids.gone)), ['stopped', 'root-missing', null]);
      assert.deepEqual(stateOf(rowOf(table, ids.closed)), ['stopped', 'watcher-failed', null]);
      assert.equal(typeof (rowOf(table, ids.closed).retry as Row | null)?.next_attempt_at_ms, 'number');

      await writeFile(join(full!, 'x.ts'), 'x');
      disk.full = true;
      fake.observe(full!, 'x.ts');
      await waitForRow(call, ids.full, (row) => row.reason === 'storage-unavailable', 'the full store to be reported');
      table = await agreeOnce(store, daemon, (t) => rowOf(t, ids.full).reason === 'storage-unavailable', 'a store that refuses appends');
      assert.deepEqual(stateOf(rowOf(table, ids.full)), ['not_recording', 'storage-unavailable', null]);
      disk.full = false;
      await waitForRow(call, ids.full, (row) => row.state === 'recording', 'the store to recover');
      table = await agreeOnce(store, daemon, (t) => rowOf(t, ids.full).state === 'recording', 'a store that recovered');
      assert.deepEqual(stateOf(rowOf(table, ids.full)), ['recording', null, null]);
    });
  });
  it('keeps showing a recovered outage to both readers while the intent record cannot be written', async () => {
    const disk = fillableStore();
    await withStore(async ({ store, roots, start }) => {
      const fake = createRootsPlatform();
      const { daemon, call } = await start({ captureDependencies: {
        platform: fake.platform, enumerate: async () => {}, readQuestionContext: async () => 'selected', createLog: disk.createLog } });
      const [full, next] = await roots(2);
      const id = await attachRecording(call, full!);
      await writeFile(join(full!, 'x.ts'), 'x');
      disk.full = true;
      fake.observe(full!, 'x.ts');
      await waitForRow(call, id, (row) => row.reason === 'storage-unavailable', 'the full store to be reported');
      await untilIntent(store, (i) => (i.captures[0]?.last_failure as Row | null)?.reason === 'storage-unavailable');
      const control = join(store, 'control');
      await chmod(control, 0o500);
      try {
        disk.full = false;
        await waitForLog(store, id, (log) => log.some((r) => r.type === 'slipstream.capture.gap.v1' && r.data.reason === 'storage'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        assert.deepEqual(fold, projection);
        assert.deepEqual(stateOf(rowOf(projection, id)), ['not_recording', 'storage-unavailable', null]);
      } finally {
        await chmod(control, 0o700);
      }
      const attached = await call({ verb: 'attach', mode: 'watch-only', worktree: next! });
      assert.equal(attached.ok, true, 'a failed background notice never permanently refuses later lifecycle controls');
    });
  });
});

describe('auto-capture acceptance: a Codex chat after a restart', () => {
  const codexMeta = (root: string, version: string) => JSON.stringify({ type: 'session_meta', payload: {
    session_id: 'codex-chat', cwd: root, originator: 'codex_sdk_ts', source: 'exec', cli_version: version } }) + '\n';

  async function linkCodex(call: Call, root: string, transcript: string): Promise<string> {
    for (let i = 0; i < 300; i++) {
      const res = await call({ verb: 'attach', worktree: root, harness: 'codex', harness_session_id: 'codex-chat', root_transcript: transcript });
      if (res.ok) return rec(res).session_id!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('the Codex chat never linked');
  }

  for (const { what, change, reason } of [
    { what: 'whose transcript vanished', change: (t: string) => rm(t), reason: 'transcript-missing' },
    { what: 'whose Codex version changed', change: (t: string, root: string) => writeFile(t, codexMeta(root, '9.9.9')), reason: 'identity-changed' },
  ]) {
    it(`reads a link ${what} as unavailable to both readers`, async () => {
      await withStore(async ({ store, roots, start, stop }) => {
        const [a] = await roots(1);
        const transcript = join(store, 'codex-chat.jsonl');
        await writeFile(transcript, codexMeta(a!, '0.154.0'));
        const id = await linkCodex((await start()).call, a!, transcript);
        await stop();
        await change(transcript, a!);
        const { daemon, call } = await start();
        await waitForRow(call, id, (row) => (row.binding as Row).state === 'unavailable');
        await untilIntent(store, (i) => (i.bindings[0]?.unavailable as Row | null)?.reason === reason);
        const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
        assert.deepEqual(fold, projection);
        const binding = rowOf(projection, id).binding as Row;
        assert.deepEqual([binding.harness, binding.state, binding.reason], ['codex', 'unavailable', reason]);
      });
    });
  }
});

describe('auto-capture acceptance: Ask Agent in two workspaces', () => {
  it('delivers each workspace\'s question only to that workspace\'s chat, which alone can answer it', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { call } = await start();
      const [a, b] = await roots(2);
      const chats = [{ chat: 'chat-a', root: a! }, { chat: 'chat-b', root: b! }];
      const ids: string[] = [];
      for (const { chat, root } of chats) {
        ids.push((await linkRecording(call, store, root, chat)).id);
        await connect(call, store, chat, root);
      }
      const context = { change_seq: '1', path: 'x.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1 };
      const questions = [];
      for (const id of ids) {
        const asked = await call({ verb: 'ask', session_id: id, request_id: randomUUID(), text: `About ${id}?`, context });
        assert.equal(asked.ok, true, JSON.stringify(asked));
        questions.push(rec(asked).question_id!);
      }
      for (const [i, { chat, root }] of chats.entries()) {
        const other = chats[1 - i]!;
        const claimed = rec(await call(claimOf(store, chat, root))).question as unknown as { question_id: string };
        assert.equal(claimed.question_id, questions[i], `${chat} receives its own workspace's question`);
        const crossed = await call({ verb: 'answer_question', ...chatOf(other.chat, other.root), question_id: questions[i]!, text: 'not mine' });
        assert.equal(crossed.ok, false, `${other.chat} cannot answer ${chat}'s question`);
        const answered = await call({ verb: 'answer_question', ...chatOf(chat, root), question_id: questions[i]!, text: 'mine' });
        assert.equal(rec(answered).session_id, ids[i]);
      }
      for (const [i, id] of ids.entries()) {
        const answers = (await readLog(store, id)).filter((r) => r.type === 'slipstream.question.answered.v1');
        assert.deepEqual(answers.map((r) => r.data.question_id), [questions[i]], 'each session holds only its own answer');
      }
    });
  });
});

describe('auto-capture acceptance: failed setup', () => {
  it('stays visible while failed, and the retry baselines current bytes without presenting earlier edits as history', async () => {
    await withStore(async ({ store, roots, start }) => {
      const [a] = await roots(1);
      await writeFile(join(a!, 'notes.txt'), 'before setup');
      const fake = createRootsPlatform();
      let failing = true;
      const platform: Platform = {
        watch: async (o) => {
          if (failing) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
          return fake.platform.watch(o);
        },
      };
      // Long enough that both readers see one failure, not a retry in progress.
      const { daemon, call } = await start({
        retryBackoff: { baseMs: 1000, maxMs: 1000 },
        captureDependencies: { platform, readQuestionContext: async () => 'selected' },
      });
      const res = await call({ verb: 'attach', mode: 'watch-only', worktree: a! });
      const id = rec(res).session_id!;
      const failed = await waitForRow(call, id, (row) => row.state === 'not_recording', 'the failed baseline');
      assert.equal(failed.reason, 'baseline-failed');
      assert.match(String(failed.message), /too many open files/);
      await untilIntent(store, (intent) => intent.captures.some((c) => c.session_id === id && c.last_failure !== null));
      const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
      assert.deepEqual(fold, projection, 'a failed setup with no session log');
      assert.deepEqual(stateOf(rowOf(projection, id)), ['not_recording', 'baseline-failed', null]);
      assert.equal(typeof (rowOf(projection, id).retry as Row | null)?.next_attempt_at_ms, 'number');

      await writeFile(join(a!, 'notes.txt'), 'edited while not recording');
      await writeFile(join(a!, 'added.txt'), 'created while not recording');
      failing = false;
      await waitForRow(call, id, recording, 'recording after the retry');

      const log = await readLog(store, id);
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      const baselined = Object.fromEntries(log.filter((r) => r.type === 'slipstream.file.baselined.v1')
        .map((r) => [r.data.path, (r.data.snapshot as Row).sha256]));
      assert.deepEqual(baselined, { 'notes.txt': sha('edited while not recording'), 'added.txt': sha('created while not recording') });
      assert.deepEqual(log.filter((r) => r.type === 'slipstream.file.changed.v1'), [], 'no edit is presented as captured history');
      assert.equal(log.filter((r) => r.type === 'slipstream.session.started.v1').length, 1);
      assert.equal((await captureRow(call, id)).retry, null);
    });
  });
});

describe('auto-capture acceptance: gc and setup checks', () => {
  it('lets no setup check issued before gc connect either chat after it; each connects only through a new check of its own', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { call } = await start();
      const [a, b] = await roots(2);
      const links = [await linkRecording(call, store, a!, 'chat-a'), await linkRecording(call, store, b!, 'chat-b')];
      const before = [await claimCheck(call, store, 'chat-a', a!), await claimCheck(call, store, 'chat-b', b!)];
      assert.equal((await call({ verb: 'gc' })).ok, true);
      for (const { id } of links) {
        await waitForRow(call, id, recording);
        await waitForLog(store, id, (log) => log.slice(log.findLastIndex((r) => r.type === 'slipstream.session.resumed.v1'))
          .some((r) => r.type === 'slipstream.agent.connection.v1' && r.data.state === 'setup_pending'));
      }
      const after = [await claimCheck(call, store, 'chat-a', a!), await claimCheck(call, store, 'chat-b', b!)];
      assert.notEqual(after[0]!.check_id, before[0]!.check_id);
      assert.notEqual(after[1]!.check_id, before[1]!.check_id);
      for (const [chat, root, check] of [['chat-a', a!, before[0]!], ['chat-b', b!, before[1]!]] as const) {
        const late = await call({ verb: 'answer_question', ...chatOf(chat, root), question_id: check.check_id, text: 'connected' });
        assert.equal(late.ok === false && late.code, 'QUESTION_NOT_FOUND', `${chat}'s pre-gc check must not connect`);
      }
      const crossed = await call({ verb: 'answer_question', ...chatOf('chat-a', a!), question_id: after[1]!.check_id, text: 'connected' });
      assert.equal(crossed.ok === false && crossed.code, 'QUESTION_NOT_FOUND', 'chat-a cannot answer chat-b\'s new check');
      for (const { id } of links) assert.equal(((await captureRow(call, id)).binding as Row).state, 'setup_pending');
      for (const [chat, root, check] of [['chat-a', a!, after[0]!], ['chat-b', b!, after[1]!]] as const) {
        const ack = await call({ verb: 'answer_question', ...chatOf(chat, root), question_id: check.check_id, text: 'connected' });
        assert.equal(ack.ok, true, JSON.stringify(ack));
      }
      for (const { id } of links) assert.equal(((await captureRow(call, id)).binding as Row).state, 'connected');
    });
  });

  it('connects a chat exactly once when its setup-check answer is lost and it answers the re-offered check', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { call } = await start({ setupReofferMs: 50 });
      const [a] = await roots(1);
      const { id } = await linkRecording(call, store, a!, 'chat-a');
      const first = await claimCheck(call, store, 'chat-a', a!);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const offered = await claimCheck(call, store, 'chat-a', a!);
      assert.equal(offered.check_id, first.check_id);
      const answer = { verb: 'answer_question', ...chatOf('chat-a', a!), question_id: offered.check_id, text: 'connected' };
      const [one, two] = await Promise.all([call(answer), call(answer)]);
      assert.deepEqual([one.ok, two.ok], [true, true]);
      assert.deepEqual([rec(one).duplicate, rec(two).duplicate].sort(), [false, true]);
      const connections = (await readLog(store, id)).filter((r) => r.type === 'slipstream.agent.connection.v1');
      assert.deepEqual(connections.map((r) => r.data.state), ['setup_pending', 'connected']);
    });
  });
});

describe('auto-capture acceptance: races and recovery', () => {
  it('never offers a setup check to a subagent callback, and a refused one does not use up the root chat\'s offer', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { call } = await start({ setupReofferMs: 60_000 });
      const [a] = await roots(1);
      await linkRecording(call, store, a!, 'chat-a');
      const subagent = await call({ ...claimOf(store, 'chat-a', a!), agent_id: 'child', agent_type: 'general-purpose' });
      assert.equal(subagent.ok === false && subagent.code, 'IDENTITY_UNRESOLVED');
      const root = await call(claimOf(store, 'chat-a', a!));
      assert.equal(typeof (rec(root) as unknown as { setup_check?: { check_id: string } }).setup_check?.check_id, 'string');
    });
  });

  it('settles a concurrent unlink and relink of one chat into a single consistent link', async () => {
    await withStore(async ({ store, roots, start }) => {
      const { daemon, call } = await start();
      const [a] = await roots(1);
      const { id, generation } = await linkRecording(call, store, a!, 'chat-a');
      const [unlinked, relinked] = await Promise.all([call({ verb: 'unlink', session_id: id }), linkChat(call, store, a!, 'chat-a')]);
      assert.equal(unlinked.ok, true, JSON.stringify(unlinked));
      const binding = (await captureRow(call, id)).binding as Row;
      if (relinked.ok && rec(relinked).binding_generation === generation) {
        assert.equal(binding.state, 'unlinked', 'the attach found the old link, and the unlink then revoked it');
      } else if (relinked.ok) {
        assert.ok(BigInt(rec(relinked).binding_generation!) > BigInt(generation));
        if (binding.state === 'unlinked') assert.equal(binding.binding_generation, rec(relinked).binding_generation);
        else assert.deepEqual([binding.state, binding.binding_generation], ['setup_pending', rec(relinked).binding_generation]);
      } else {
        assert.equal(binding.state, 'unlinked');
      }
      const { projection, fold } = await bothReaders(store, daemon.readerUrl, daemon.readerToken);
      assert.deepEqual(fold, projection);
      assert.ok((projection.binding_slots as { used: number }).used <= 1);
      const unlinks = (await readLog(store, id)).filter((r) => r.type === 'slipstream.agent.unlinked.v1');
      assert.ok(unlinks.every((r) => BigInt(r.data.binding_generation as string) >= BigInt(generation)));
      assert.equal(new Set(unlinks.map((r) => r.data.binding_generation)).size, unlinks.length, 'each link is unlinked at most once');
    });
  });

  it('honors an archive that arrives while a restarted capture is still failing to resume', async () => {
    await withStore(async ({ store, roots, start, stop }) => {
      const [a] = await roots(1);
      let { call } = await start();
      const id = await attachRecording(call, a!);
      await linkRecording(call, store, a!, 'chat-a');
      await stop();
      const fake = createRootsPlatform();
      let failing = true;
      let attempts = 0;
      const platform: Platform = {
        watch: async (o) => {
          attempts++;
          if (failing) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
          return fake.platform.watch(o);
        },
      };
      const restarted = await start({
        retryBackoff: { baseMs: 50, maxMs: 50 },
        captureDependencies: { platform, enumerate: async () => {}, readQuestionContext: async () => 'selected' },
      });
      call = restarted.call;
      await waitForRow(call, id, (row) => row.reason === 'resume-failed', 'a failing resume');
      const before = await readFile(join(store, 'sessions', id, 'events.jsonl'), 'utf8');
      const archived = await call({ verb: 'detach', target: a!, reason: 'archived' });
      assert.equal(archived.ok, true, JSON.stringify(archived));
      failing = false;
      const tries = attempts;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(attempts, tries, 'an archived capture is not retried');
      const row = await captureRow(call, id);
      assert.deepEqual(stateOf(row), ['not_recording', 'stop-unconfirmed', 'unlinked'],
        'the stop was never recorded in the log, so it is not shown as cleanly stopped');
      assert.equal(await readFile(join(store, 'sessions', id, 'events.jsonl'), 'utf8'), before, 'nothing resumed after the archive');
      const { projection, fold } = await bothReaders(store, restarted.daemon.readerUrl, restarted.daemon.readerToken);
      assert.deepEqual(fold, projection);
      assert.deepEqual(projection.binding_slots, { used: 0, limit: 10 });
    });
  });
});

describe('auto-capture acceptance: end to end through real processes', () => {
  it('traces Conductor setup, the Codex refusal, a Claude attach, a setup check, and Ask Agent through to both readers', { timeout: 120_000 }, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'slip-accept-e2e-')));
    const store = join(dir, 'store'); const wsA = join(dir, 'ws-a'); const wsB = join(dir, 'ws-b');
    const claudeChat = '11111111-2222-4333-8444-555555555555';
    const codexChat = '019a0000-0000-7000-8000-000000000001';
    await mkdir(wsA); await mkdir(wsB);
    const base = { PATH: process.env.PATH!, HOME: dir };
    const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
        const child = execFile(process.execPath, ['src/cli.ts', ...args], { env: { ...base, ...env }, timeout: 30_000 },
          (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
        child.stdin?.end(input ?? '');
      });
    const daemon = spawn(process.execPath, ['src/cli.ts', 'start', '--store', store], { env: base, stdio: 'ignore' });
    let forwarder: ChildProcessByStdio<Writable, Readable, null> | undefined;
    let replies: ReturnType<typeof createInterface> | undefined;
    const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
      const reply = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the MCP forwarder never answered ${method}`)), 10_000);
        forwarder!.once('exit', (code) => reject(new Error(`the MCP forwarder exited (${code}) during ${method}`)));
        replies!.once('line', (line) => { clearTimeout(timer); resolve(line); });
      });
      forwarder!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return JSON.parse(await reply) as { result: { isError?: boolean; content?: { text: string }[] } };
    };
    const until = async (what: string, done: () => Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await done()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail(what);
    };
    const answer = async (id: number, question_id: string, text: string) =>
      (await rpc(id, 'tools/call', { name: 'slipstream_answer_question', arguments: { question_id, text } })).result;
    // The hook command `slipstream attach` installed, run the way Claude Code runs it.
    let hookCommand = '';
    const hook = (chat: string, cwd: string) => new Promise<{ stdout: string; stderr: string }>((done, fail) => {
      const child = execFile('/bin/sh', ['-c', hookCommand], { env: base, timeout: 30_000 },
        (error, stdout, stderr) => (error ? fail(new Error(`${error.message}\n${stderr}`)) : done({ stdout, stderr })));
      child.stdin?.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: chat, cwd,
        transcript_path: join(dir, 'claude', 'projects', 'p', `${chat}.jsonl`) }));
    });
    try {
      await until('the daemon never came up', async () => await probeSocket(join(store, 'control.sock'), 200) === 'live');
      const setup = async (ws: string) => {
        const res = await run(['conductor', 'setup', '--store', store], { CONDUCTOR_WORKSPACE_PATH: ws });
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, /state: recording/);
        return /session_id: (\S+)/.exec(res.stdout)![1]!;
      };
      const idA = await setup(wsA);
      const idB = await setup(wsB);
      const descriptor = (await readdir(join(store, 'runtime'))).find((f) => f.endsWith('.json'))!;
      const { url, token } = JSON.parse(await readFile(join(store, 'runtime', descriptor), 'utf8')) as { url: string; token: string };
      const readers = async () => {
        const both = await bothReaders(store, url, token);
        assert.deepEqual(both.fold, both.projection);
        return both.projection;
      };
      const events = async (id: string) => {
        const res = await fetch(`${url}/v1/sessions/${id}/events`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
      };

      // Conductor bundles Codex 0.156.1, which Slipstream has not verified: an explicit refusal, nothing changed.
      const rollouts = join(dir, '.codex', 'sessions', '2026', '10', '18');
      await mkdir(rollouts, { recursive: true });
      await writeFile(join(rollouts, `rollout-2026-10-18T00-00-00-${codexChat}.jsonl`), JSON.stringify({ type: 'session_meta',
        payload: { session_id: codexChat, cwd: wsA, originator: 'codex_sdk_ts', source: 'exec', cli_version: '0.156.1' } }) + '\n');
      const codex = await run(['attach', wsA, '--store', store], { CODEX_THREAD_ID: codexChat, CONDUCTOR_SESSION_ID: 'c' });
      assert.equal(codex.code, 1);
      assert.match(codex.stderr, /not a runtime Slipstream has verified.*nothing was installed or recorded/s);
      await assert.rejects(stat(join(wsA, '.codex')));
      await assert.rejects(stat(join(dir, '.codex', 'config.toml')));
      assert.equal(rowOf(await readers(), idA).binding, null);

      // The existing Claude attach workflow, run from a Conductor chat, links to the same auto-capture.
      const config = join(dir, 'claude');
      await mkdir(join(config, 'projects', 'p'), { recursive: true });
      await writeFile(join(config, 'projects', 'p', `${claudeChat}.jsonl`), JSON.stringify({ type: 'user', sessionId: claudeChat,
        cwd: wsA, version: '2.1.293', entrypoint: 'sdk-ts', userType: 'external', isSidechain: false }) + '\n');
      const fakeClaude = join(dir, 'claude-bin');
      await writeFile(fakeClaude, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n`
        + `const sep = args.indexOf('--'); fs.writeFileSync(${JSON.stringify(join(config, '.claude.json'))}, JSON.stringify({ projects: `
        + `{ [process.cwd()]: { mcpServers: { slipstream: { type: 'stdio', command: args[sep + 1], args: args.slice(sep + 2) } } } } }));\n`);
      await chmod(fakeClaude, 0o755);
      const claude = await run(['attach', wsA, '--store', store], { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: claudeChat,
        CLAUDE_CODE_EXECPATH: fakeClaude, CONDUCTOR_SESSION_ID: 'c' });
      assert.equal(claude.code, 0, claude.stderr);
      assert.match(claude.stdout, /agent setup pending/);
      assert.equal(/session_id: (\S+)/.exec(claude.stdout)?.[1], idA);
      assert.equal((rowOf(await readers(), idA).binding as Row).state, 'setup_pending');

      // Start the answer tool and the hook exactly as attach installed them.
      const installed = JSON.parse(await readFile(join(config, '.claude.json'), 'utf8')) as {
        projects: Record<string, { mcpServers: { slipstream: { command: string; args: string[] } } }> };
      const tool = Object.values(installed.projects)[0]!.mcpServers.slipstream;
      forwarder = spawn(tool.command, tool.args, { env: { ...base, CLAUDE_CODE_SESSION_ID: claudeChat, CLAUDE_PROJECT_DIR: wsA },
        stdio: ['pipe', 'pipe', 'inherit'] });
      replies = createInterface({ input: forwarder.stdout });
      const settings = JSON.parse(await readFile(join(wsA, '.claude', 'settings.local.json'), 'utf8')) as {
        hooks: { PostToolUse: { hooks: { command: string }[] }[] } };
      hookCommand = settings.hooks.PostToolUse.flatMap((group) => group.hooks).find((h) => h.command.includes(' hook '))!.command;

      // The chat's next tool call delivers the setup check; its MCP tool answers it.
      await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '1' } });
      const offered = await hook(claudeChat, wsA);
      const check = /Slipstream setup check (\S+)\./.exec(offered.stdout)?.[1];
      assert.ok(check, offered.stdout + offered.stderr);
      const ack = await answer(2, check, 'connected');
      assert.equal(ack.isError, false, ack.content?.[0]?.text);
      let table = await readers();
      assert.equal((rowOf(table, idA).binding as Row).state, 'connected');
      assert.deepEqual(table.binding_slots, { used: 1, limit: 10 });

      // A real edit reaches the log and the reader serves exactly the durable log.
      await writeFile(join(wsA, 'a.ts'), 'one\ntwo\n');
      let change: Row | undefined;
      for (let i = 0; i < 200 && !change; i++) {
        change = (await events(idA)).find((e) => e.type === 'slipstream.file.changed.v1' && (e.data as Row).path === 'a.ts');
        if (!change) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(change, 'the edit never reached the reader');
      const served = await events(idA);
      const disk = (await readFile(join(store, 'sessions', idA, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as Row);
      assert.deepEqual(served, disk.slice(0, served.length));

      // Ask Agent: only the linked chat, in its own workspace, receives and answers the question.
      const input = join(dir, 'question.json');
      await writeFile(input, JSON.stringify({ text: 'Why two lines?', context: { change_seq: change.seq, path: 'a.ts',
        snapshot_sha256: ((change.data as Row).after as Row).sha256, line_start: 1, line_end: 2 } }));
      const asked = await run(['ask', '--store', store, '--session', idA, '--request-id', randomUUID(), '--input', input]);
      assert.equal(asked.code, 0, asked.stderr);
      const question = (JSON.parse(asked.stdout) as { question_id: string }).question_id;
      assert.deepEqual((await hook(claudeChat, wsB)).stdout, '', 'the chat called back from another workspace gets nothing');
      assert.deepEqual((await hook('22222222-2222-4333-8444-555555555555', wsA)).stdout, '', 'another chat gets nothing');
      const delivered = await hook(claudeChat, wsA);
      assert.match(delivered.stdout, new RegExp(`Slipstream question ${question} about`));
      const answered = await answer(3, question, 'Because the file has two lines.');
      assert.equal(answered.isError, false, answered.content?.[0]?.text);
      const onA = (await events(idA)).filter((e) => e.type === 'slipstream.question.answered.v1');
      assert.deepEqual(onA.map((e) => (e.data as Row).question_id), [question]);
      assert.equal((await events(idB)).some((e) => String(e.type).startsWith('slipstream.question.')), false);
      table = await readers();
      assert.deepEqual(stateOf(rowOf(table, idB)), ['recording', null, null]);
    } finally {
      replies?.close();
      await Promise.all([forwarder, daemon].map((child) => child && stopped(child)));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
