#!/usr/bin/env node
/**
 * The Slipstream CLI. Two families of commands:
 *
 * Standalone capture (Stage 1/2): watch or serve a single worktree into its own
 * store. The JSONL log is the source of truth (see CLAUDE.md).
 *
 *   slipstream watch [dir] [--store <dir>]
 *   slipstream serve [dir] [--store <dir>]
 *   slipstream view  ...
 *
 * Shared daemon (Stage 3): one long-lived daemon owns the shared store, one
 * public reader, and at most one active capture; the other verbs are thin
 * control clients that talk to it over its private socket. `start` comes up
 * detached — attach a worktree to begin capture.
 *
 *   slipstream start  [--store <dir>]
 *   slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id>
 *   slipstream status [--store <dir>]
 *   slipstream detach [--store <dir>]
 *
 * Deletion / GC of retained sessions is a later stage.
 */
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { startCapture } from './session.ts';
import { startReaderServer } from './http-reader.ts';
import { startDaemon } from './daemon.ts';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import { runTui } from './tui.ts';
import { isMainModule } from './entrypoint.ts';

type Args =
  | { command: 'watch'; dir: string; store: string }
  | { command: 'serve'; dir: string; store: string }
  | { command: 'view' }
  | { command: 'start'; store: string }
  | { command: 'status'; store: string }
  | { command: 'detach'; store: string }
  | { command: 'attach'; dir: string; store: string; harness?: string; harnessSessionId?: string };

/** The shared daemon's default store lives under the home dir, not the worktree:
 * one daemon serves every worktree from a single owner-only root. */
const DEFAULT_DAEMON_STORE = join(homedir(), '.slipstream');

function parseDirAndStore(rest: string[]): { dir: string; store: string } | null {
  let dir = process.cwd();
  let store: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    }
    else if (!arg.startsWith('--')) dir = resolve(arg);
  }
  return { dir, store: store ?? resolve(dir, '.slipstream') };
}

/** Store-only flag parse for `start` / `status` / `detach`: a `--store` override
 * and nothing else. A stray positional is a usage error, not a silently ignored
 * arg. */
function parseStoreOnly(rest: string[]): string | null {
  let store: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    } else return null; // positional or unknown flag
  }
  return store ?? DEFAULT_DAEMON_STORE;
}

function parseAttach(rest: string[]): Omit<Extract<Args, { command: 'attach' }>, 'command'> | null {
  let dir = process.cwd();
  let store: string | undefined;
  let harness: string | undefined;
  let harnessSessionId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store' || arg === '--harness' || arg === '--harness-session-id') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      if (arg === '--store') store = resolve(value);
      else if (arg === '--harness') harness = value;
      else harnessSessionId = value;
    }
    else if (!arg.startsWith('--')) dir = resolve(arg);
    else return null; // unknown flag
  }
  return { dir, store: store ?? DEFAULT_DAEMON_STORE, harness, harnessSessionId };
}

export function parseArgs(argv: string[]): Args | null {
  const command = argv[0];
  if (command === 'watch' || command === 'serve') {
    const parsed = parseDirAndStore(argv.slice(1));
    if (!parsed) return null;
    return { command, dir: parsed.dir, store: parsed.store };
  }
  if (command === 'start' || command === 'status' || command === 'detach') {
    const store = parseStoreOnly(argv.slice(1));
    if (store === null) return null;
    return { command, store };
  }
  if (command === 'attach') {
    const parsed = parseAttach(argv.slice(1));
    if (!parsed) return null;
    return { command: 'attach', ...parsed };
  }
  if (command === 'view') return { command: 'view' };
  return null;
}

async function countRecords(logPath: string): Promise<number> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).length;
}

function usage(): void {
  console.error('Usage: slipstream watch  [dir] [--store <dir>]');
  console.error('       slipstream serve  [dir] [--store <dir>]');
  console.error('       slipstream start  [--store <dir>]');
  console.error('       slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id>');
  console.error('       slipstream status [--store <dir>]');
  console.error('       slipstream detach [--store <dir>]');
  console.error('       slipstream view   [--store <dir>] [--session <id>] [--disk] [--changes] [--context N] [--full]');
}

/** Refuse a standalone capture over a store a daemon owns: its control socket is
 * the tell. Two writers over one store would fight for the lock and the reader;
 * failing here gives a clear message instead of a lock error. Returns true when
 * the caller should stop. */
async function isDaemonOwned(store: string): Promise<boolean> {
  const controlSock = join(store, 'control.sock');
  const owned = await access(controlSock).then(() => true, () => false);
  if (owned) {
    console.error(`slipstream: ${store} is owned by a running daemon (${controlSock} present).`);
    console.error('slipstream: use `slipstream attach` to capture through the daemon, or choose another --store.');
    process.exitCode = 2;
  }
  return owned;
}

/** Print a control response: ok fields to stdout, an error to stderr with a
 * non-zero exit. */
function reportControl(res: ResponseEnvelope): void {
  if (res.ok) {
    for (const [key, value] of Object.entries(res)) {
      if (key === 'v' || key === 'ok') continue;
      console.log(`${key}: ${String(value)}`);
    }
    return;
  }
  console.error(`slipstream: ${res.code}: ${res.message}`);
  process.exitCode = 1;
}

async function runControl(store: string, request: Record<string, unknown> & { verb: string }): Promise<void> {
  const socketPath = join(store, 'control.sock');
  try {
    const res = await sendControlRequest({ socketPath, request: { v: 1, ...request } });
    reportControl(res);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      // Honesty: the request reached the daemon but its outcome is unknowable —
      // never report it as "nothing happened".
      console.error(`slipstream: outcome unknown — ${err.message}`);
      console.error('slipstream: run `slipstream status` before retrying; the request may have committed.');
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (args.command === 'view') {
    await runTui(process.argv.slice(3), console.log);
    return;
  }

  if (args.command === 'start') {
    const daemon = await startDaemon({ storeDir: args.store });
    console.error(`slipstream: daemon control ${daemon.socketPath}`);
    console.error(`slipstream: reader ${daemon.readerUrl}`);
    console.error('slipstream: detached; `slipstream attach <dir>` a worktree to begin capture');
    console.error('slipstream: press Ctrl-C to stop');
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (args.command === 'status') {
    await runControl(args.store, { verb: 'status' });
    return;
  }

  if (args.command === 'detach') {
    await runControl(args.store, { verb: 'detach' });
    return;
  }

  if (args.command === 'attach') {
    await runControl(args.store, {
      verb: 'attach',
      worktree: args.dir,
      harness: args.harness,
      harness_session_id: args.harnessSessionId,
    });
    return;
  }

  // Standalone capture: never over a daemon-owned store.
  if (await isDaemonOwned(args.store)) return;

  const session = await startCapture({ root: args.dir, storeDir: args.store });
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${session.sessionId}`);
  console.error(`slipstream: log ${session.logPath}`);

  // Shared clean-shutdown wiring for both watch and serve. `teardown` runs any
  // subsystem stop (e.g. the reader server) BEFORE capture stops, so both report
  // cleanly and the log's tail append and drain complete.
  const onSignal = (teardown: () => Promise<void>): void => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await teardown();
      await session.stop();
      const n = await countRecords(session.logPath);
      console.error(`slipstream: stopped; ${n} record(s) committed to ${session.logPath}`);
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  };

  if (args.command === 'watch') {
    console.error('slipstream: press Ctrl-C to stop');
    // The active watcher subscription keeps the process alive until a signal.
    onSignal(async () => {});
    return;
  }

  // args.command === 'serve'
  let server;
  try {
    server = await startReaderServer({
      storeDir: args.store,
      active: { id: session.sessionId, health: session.health, logPath: session.logPath },
    });
  } catch (err) {
    try { await session.stop(); }
    catch (stopError) { console.error('slipstream: capture cleanup failed', stopError); }
    throw err;
  }
  console.error(`slipstream: reader ${server.url}`);
  console.error(`slipstream: reader descriptor ${server.descriptorPath}`);
  console.error('slipstream: press Ctrl-C to stop');

  // Stop accepting readers (aborting live SSE followers) before tearing down capture.
  onSignal(async () => { await server.close(); });
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
