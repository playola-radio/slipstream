/**
 * `npm run qa:daemon` — a one-command local Slipstream for testing.
 *
 * Starts a REAL daemon in-process (`startDaemon`, the same entry the CLI's
 * `start` uses — production watcher, no capture injection), attaches a sandbox
 * worktree under an owner-only root with a synthetic `qa` identity, discovers the
 * reader's credentials the way the native client will (from the runtime
 * descriptor, never from `daemon.readerToken`), optionally seeds a scenario of
 * real files, then prints paste-ready curl commands and leaves the daemon running
 * until Ctrl-C.
 *
 * It touches only a harness-owned sandbox: it refuses the operator's real store
 * and any overlapping path, refuses a root whose daemon is live or whose
 * ownership is ambiguous, and never deletes anything it did not create.
 */
import { stat, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDaemon, probeSocket, PROBE_TIMEOUT_MS } from '../src/daemon.ts';
import { sendControlRequest } from '../src/control-client.ts';
import { controlSocketPath } from '../src/daemon-location.ts';
import { isMainModule } from '../src/entrypoint.ts';
import {
  checkRootAgainstRealStore,
  evaluateRoot,
  prepareRoot,
  readOwnerMarker,
  type DaemonLiveness,
} from './qa/safety.ts';
import { getScenario, scenarioNames } from './qa/scenarios.ts';
import {
  bootstrapReader,
  createReaderClient,
  awaitEventType,
  gitHead,
  writeQaEnv,
  readQaEnv,
  BASELINE_COMPLETED_TYPE,
  QA_ENV_FORMAT,
  QA_ENV_NAME,
  type QaEnv,
} from './qa-support.ts';

export interface QaDaemonArgs {
  root: string;
  scenario: string | null;
  keep: boolean;
  reuse: boolean;
}

export const DEFAULT_ROOT_REL = join('.slipstream-qa', 'local');

export function defaultRoot(home: string = homedir()): string {
  return join(home, DEFAULT_ROOT_REL);
}

export class ArgError extends Error {}

/** Parse qa-daemon flags. `--root` resolves relative to cwd; the rest are simple
 * toggles / one-value options. Unknown flags are a usage error, never ignored. */
export function parseArgs(argv: readonly string[], home: string = homedir()): QaDaemonArgs {
  let root: string | null = null;
  let scenario: string | null = null;
  let keep = false;
  let reuse = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--root': {
        const v = argv[++i];
        if (v === undefined) throw new ArgError('--root requires a directory');
        root = resolve(v);
        break;
      }
      case '--scenario': {
        const v = argv[++i];
        if (v === undefined) throw new ArgError('--scenario requires a name');
        scenario = v;
        break;
      }
      case '--keep': keep = true; break;
      case '--reuse': reuse = true; break;
      default:
        throw new ArgError(`unknown argument: ${arg}`);
    }
  }
  return { root: root ?? defaultRoot(home), scenario, keep, reuse };
}

/** Probe whether a daemon is live in a store, mapping a missing control socket to
 * `none` (a store that has never run a daemon). */
export async function probeStoreLiveness(storeDir: string): Promise<DaemonLiveness> {
  const sock = controlSocketPath(storeDir);
  try {
    await stat(sock);
  } catch {
    return 'none';
  }
  return probeSocket(sock, PROBE_TIMEOUT_MS);
}

export interface CurlContext { url: string; token: string; sessionId: string }

/** Paste-ready curl commands for the operator. The bearer token is deliberately
 * included — qa-daemon's whole purpose is to hand the operator a working session.
 * (projection-check, by contrast, must never print the token.) */
export function curlCommands({ url, token, sessionId }: CurlContext): string[] {
  const auth = `-H 'authorization: Bearer ${token}'`;
  return [
    `curl -s ${auth} ${url}/v1/sessions`,
    `curl -s ${auth} '${url}/v1/sessions/${sessionId}/events?after=0'`,
    `curl -N ${auth} '${url}/v1/sessions/${sessionId}/events?after=0&follow=true'`,
  ];
}

export interface RunIO {
  home: string;
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
}

/**
 * The orchestrator. Resolves to an exit code for the failure paths; on success it
 * does NOT resolve — it installs signal handlers and keeps the daemon alive until
 * the process is signalled, at which point it cleans up and exits directly.
 */
export async function runQaDaemon(io: RunIO): Promise<number> {
  let args: QaDaemonArgs;
  try {
    args = parseArgs(io.argv, io.home);
  } catch (err) {
    io.stderr(`qa-daemon: ${(err as Error).message}`);
    io.stderr(`qa-daemon: usage: qa:daemon [--root <dir>] [--scenario <name>] [--keep] [--reuse]`);
    return 2;
  }

  if (args.scenario !== null && getScenario(args.scenario) === undefined) {
    io.stderr(`qa-daemon: unknown scenario ${args.scenario}; known: ${scenarioNames().join(', ') || '(none)'}`);
    return 2;
  }

  // Safety gate 1: never touch the real store or an overlapping path.
  const overlap = await checkRootAgainstRealStore(args.root);
  if (overlap) {
    io.stderr(`qa-daemon: ${overlap.message}`);
    return 2;
  }

  // Safety gate 2: fresh-vs-reuse rules + a live/ambiguous daemon refusal.
  const verdict = await evaluateRoot(args.root, { reuse: args.reuse, probe: probeStoreLiveness });
  if (!verdict.ok) {
    io.stderr(`qa-daemon: ${verdict.message}`);
    return 2;
  }

  const runId = randomUUID();
  const { store, worktree } = await prepareRoot(args.root, runId);
  const daemonCommit = await gitHead(io.cwd).catch(() => 'unknown');

  const controller = new AbortController();
  const daemon = await startDaemon({ storeDir: store });

  // Attach the sandbox worktree with an explicitly synthetic identity. `qa` is a
  // capture SCOPE marker, never a claim of authorship.
  const attach = await sendControlRequest({
    socketPath: daemon.socketPath,
    request: { v: 1, verb: 'attach', worktree, harness: 'qa', harness_session_id: `qa:${runId}` },
  });
  if (!attach.ok) {
    io.stderr(`qa-daemon: attach failed (${attach.code}): ${attach.message}`);
    await daemon.stop();
    if (!args.keep && !args.reuse) await removeOwnedRoot(args.root);
    return 1;
  }
  const sessionId = attach.session_id as string;

  const descriptor = await bootstrapReader(store);
  const descriptorPath = (await readRuntimeDescriptorPath(store)) ?? join(store, 'runtime');
  const reader = createReaderClient(descriptor.url, descriptor.token);

  // Ready = the attached session's baseline is durably published.
  const baseline = await awaitEventType(reader, sessionId, BASELINE_COMPLETED_TYPE, 0n);
  let readyThroughSeq = baseline.durableSeq;

  if (args.scenario !== null) {
    const scenario = getScenario(args.scenario)!;
    io.stderr(`qa-daemon: seeding scenario ${scenario.name}…`);
    readyThroughSeq = await scenario.seed({
      worktree, sessionId, reader, signal: controller.signal, after: baseline.seq,
    });
  }

  const env: QaEnv = {
    format: QA_ENV_FORMAT,
    state: 'ready',
    run_id: runId,
    daemon_commit: daemonCommit,
    store,
    worktree,
    descriptor_path: descriptorPath,
    url: descriptor.url,
    token: descriptor.token,
    session_id: sessionId,
    ready_through_seq: readyThroughSeq.toString(),
    scenario: args.scenario,
  };
  const envPath = join(args.root, QA_ENV_NAME);
  await writeQaEnv(envPath, env);

  io.stdout(`slipstream qa daemon ready`);
  io.stdout(`  store       ${store}`);
  io.stdout(`  worktree    ${worktree}`);
  io.stdout(`  descriptor  ${descriptorPath}`);
  io.stdout(`  reader url  ${descriptor.url}`);
  io.stdout(`  token       ${descriptor.token}`);
  io.stdout(`  session     ${sessionId}`);
  io.stdout(`  ready seq   ${readyThroughSeq.toString()}`);
  io.stdout(`  env file    ${envPath}`);
  io.stdout(`  scenario    ${args.scenario ?? '(none)'}`);
  io.stdout(``);
  io.stdout(`try:`);
  for (const cmd of curlCommands({ url: descriptor.url, token: descriptor.token, sessionId })) {
    io.stdout(`  ${cmd}`);
  }
  io.stderr(`qa-daemon: press Ctrl-C to stop`);

  // Success path: keep the daemon alive until a signal, then clean up.
  await new Promise<void>((resolvePromise) => {
    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      controller.abort();
      let stopFailed = false;
      try {
        await daemon.stop();
      } catch (err) {
        stopFailed = true;
        io.stderr(`qa-daemon: shutdown failed: ${(err as Error).message}; retaining ${args.root}`);
      }
      await markStopped(envPath).catch(() => {});
      // Remove the owned root only on a clean default shutdown.
      if (!args.keep && !args.reuse && !stopFailed) {
        await removeOwnedRoot(args.root).catch((err) => {
          io.stderr(`qa-daemon: cleanup failed: ${(err as Error).message}`);
        });
      }
      resolvePromise();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

/** The concrete path of the newest runtime descriptor, for the env file / display. */
async function readRuntimeDescriptorPath(store: string): Promise<string | null> {
  const dir = join(store, 'runtime');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (newest === null || st.mtimeMs > newest.mtime) newest = { path, mtime: st.mtimeMs };
    } catch {
      // ignore an entry that vanished mid-scan
    }
  }
  return newest?.path ?? null;
}

async function markStopped(envPath: string): Promise<void> {
  const env = await readQaEnv(envPath);
  await writeQaEnv(envPath, { ...env, state: 'stopped' });
}

/** Delete the root only if it still carries our ownership marker. */
async function removeOwnedRoot(root: string): Promise<void> {
  if ((await readOwnerMarker(root)) === null) return; // not harness-owned; never delete
  await rm(root, { recursive: true, force: true });
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  runQaDaemon({
    home: homedir(),
    argv: process.argv.slice(2),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
    cwd: process.cwd(),
  }).then(
    (code) => { if (code !== 0) process.exit(code); },
    (err) => { console.error(`qa-daemon: fatal: ${(err as Error).stack ?? err}`); process.exit(1); },
  );
}
