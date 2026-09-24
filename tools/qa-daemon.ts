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
  mayDeleteRoot,
  readOwnerMarker,
  type DaemonLiveness,
} from './qa/safety.ts';
import { getScenario, scenarioNames } from './qa/scenarios.ts';
import {
  bootstrapReader,
  createReaderClient,
  awaitEventType,
  gitHead,
  gitIsDirty,
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
  /** Launch nonce from a parent process (harness-proc). When set it becomes the
   * run_id and is stamped into qa-env.json, so the parent can require the env it
   * reads back was published by THIS child and not a stale/dead predecessor. */
  runId: string | null;
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
  let runId: string | null = null;
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
      case '--run-id': {
        const v = argv[++i];
        if (v === undefined) throw new ArgError('--run-id requires a value');
        runId = v;
        break;
      }
      case '--keep': keep = true; break;
      case '--reuse': reuse = true; break;
      default:
        throw new ArgError(`unknown argument: ${arg}`);
    }
  }
  return { root: root ?? defaultRoot(home), scenario, keep, reuse, runId };
}

/** Probe whether a daemon is live in a store, mapping a missing control socket to
 * `none` (a store that has never run a daemon). */
export async function probeStoreLiveness(storeDir: string): Promise<DaemonLiveness> {
  const sock = controlSocketPath(storeDir);
  try {
    await stat(sock);
  } catch (err) {
    // Only a genuinely absent socket means "no daemon ever ran here". Any other
    // stat error (a permission wall, an I/O fault) is ambiguous and must fail
    // closed — never fail open to 'none' and risk disturbing a live daemon.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return 'ambiguous';
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

  // The launch nonce (if a parent supplied one) IS the run_id, so the env this
  // child publishes can be told apart from any stale predecessor's env. Under
  // `--reuse` this nonce is fresh per spawn and so differs from the id the keep
  // run stamped into the owner marker; `prepareRoot({ reuse })` adopts the kept
  // root rather than mistaking the fresh nonce for a concurrent claimant.
  const runId = args.runId ?? randomUUID();
  const { store, worktree } = await prepareRoot(args.root, runId, { reuse: args.reuse });
  const owner = await readOwnerMarker(args.root);
  if (owner === null) throw new Error(`QA root ${args.root} lost its ownership marker after preparation`);
  const daemonCommit = await gitHead(io.cwd).catch(() => 'unknown');
  const daemonDirty = await gitIsDirty(io.cwd).catch(() => true); // unknown reads as dirty, never a false-clean claim
  const envPath = join(args.root, QA_ENV_NAME);

  const controller = new AbortController();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
  // The in-flight `startDaemon()` promise, tracked separately from `daemon` so a
  // signal arriving while it is still pending can await its outcome instead of
  // seeing `daemon === null` and wrongly concluding there is nothing to stop.
  // `startDaemon` binds a real control socket internally before it resolves, so
  // skipping this would leak that socket and report a false clean exit(0).
  let starting: ReturnType<typeof startDaemon> | null = null;
  let stopping = false;
  // The in-flight shutdown, so any code path that observes `stopping === true`
  // can await the SAME cleanup a signal already triggered instead of racing it
  // with a second cleanup or reading `exitCode` before shutdown has set it.
  let shutdownComplete: Promise<number> | null = null;
  let readyResolve: (() => void) | null = null;
  let exitCode = 0;

  // Tear down whatever has been created so far. Safe to call at any point in
  // startup: `daemon` may be null, the env file may not exist yet, and the root
  // is deleted only when it still carries THIS run's marker. Returns whether any
  // teardown step failed (a failure retains the root and is reported honestly).
  const performCleanup = async (): Promise<boolean> => {
    // Every exit path funnels through here exactly once; removing the handlers
    // here (rather than only inside `shutdown`) also covers the thrown-error and
    // gate-failure returns, which never signal at all. Without this, a listener
    // leaks onto `process` for the life of the host process — harmless for the
    // real one-shot CLI entrypoint, but a real leak for any caller (tests, or a
    // future in-process embedding) that invokes `runQaDaemon` more than once.
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    controller.abort();
    let teardownFailed = false;
    if (daemon === null && starting !== null) {
      try {
        daemon = await starting;
      } catch (err) {
        // startDaemon itself failed. This is a FAILED startup, not a clean one:
        // report it as a teardown failure so the exit code is non-zero and the
        // root is retained for diagnosis, rather than deleting the sandbox and
        // exiting 0. A signal path reaching here could otherwise `process.exit(0)`
        // and mask the failure before the main flow's own rejection propagates.
        daemon = null;
        teardownFailed = true;
        io.stderr(`qa-daemon: startup failed: ${(err as Error).message}; retaining ${args.root}`);
      }
    }
    if (daemon !== null) {
      try {
        await daemon.stop();
      } catch (err) {
        teardownFailed = true;
        io.stderr(`qa-daemon: shutdown failed: ${(err as Error).message}; retaining ${args.root}`);
      }
    }
    await markStopped(envPath, runId).catch(() => {});
    if (!args.keep && !args.reuse && !teardownFailed) {
      try {
        if (await mayDeleteRoot(args.root, runId)) await rm(args.root, { recursive: true, force: true });
      } catch (err) {
        teardownFailed = true;
        io.stderr(`qa-daemon: cleanup failed: ${(err as Error).message}; retaining ${args.root}`);
      }
    }
    return teardownFailed;
  };

  // Install signal handlers BEFORE the slow startup steps so a Ctrl-C during
  // attach/baseline/seeding still runs managed cleanup rather than orphaning the
  // daemon and leaving the sandbox behind.
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    shutdownComplete = performCleanup().then((teardownFailed) => {
      exitCode = teardownFailed ? 1 : 0;
      if (readyResolve !== null) readyResolve();
      else process.exit(exitCode); // signalled before ready: no keep-alive waiter to release
      return exitCode;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Defense in depth: after creating the layout, prove the real store/worktree
  // (symlinks already refused by prepareRoot) still do not overlap the real store,
  // in case a symlinked ancestor was planted between the first gate and now.
  for (const dir of [store, worktree]) {
    const reCheck = await checkRootAgainstRealStore(dir);
    if (reCheck) {
      io.stderr(`qa-daemon: ${reCheck.message}`);
      await performCleanup();
      return 2;
    }
  }

  // From here on, a thrown failure must still tear down whatever startDaemon
  // and the following steps created — a live daemon, an attached session, an
  // env file — or it leaks exactly like an unhandled signal would, minus the
  // cleanup. Only the explicit `return` paths above (which already call
  // performCleanup themselves) are exempt; everything else funnels through
  // this catch so there is exactly one cleanup per failure.
  try {
    starting = startDaemon({ storeDir: store });
    daemon = await starting;
    starting = null;
    // A signal that arrived while startDaemon was in flight already handed the
    // daemon to performCleanup (see the `starting` handoff above) — continuing
    // here would race a concurrent daemon.stop() and drive a live socket through
    // attach/bootstrap/awaitEventType after shutdown has already claimed it. Await
    // the SAME shutdown so the exit code reflects its actual teardown outcome.
    if (stopping) return await shutdownComplete!;

    // Attach the sandbox worktree with an explicitly synthetic identity. `qa` is a
    // capture SCOPE marker, never a claim of authorship.
    const attach = await sendControlRequest({
      socketPath: daemon.socketPath,
      request: { v: 1, verb: 'attach', worktree, harness: 'qa', harness_session_id: `qa:${runId}` },
    });
    // A signal can land anywhere in this in-flight window, not only during
    // startDaemon (the check above). Once shutdown has begun it has already claimed
    // the daemon and aborted the controller, so this attach round-trip may have
    // failed only because the socket was closing underneath it. Defer to the SAME
    // managed shutdown so the exit code reflects its teardown, instead of reporting
    // an attach-failure code for what is really a clean interrupt.
    if (stopping) return await shutdownComplete!;
    if (!attach.ok) {
      io.stderr(`qa-daemon: attach failed (${attach.code}): ${attach.message}`);
      await performCleanup();
      return 1;
    }
    const sessionId = attach.session_id as string;

    const descriptor = await bootstrapReader(store);
    const descriptorPath = (await readRuntimeDescriptorPath(store)) ?? join(store, 'runtime');
    const reader = createReaderClient(descriptor.url, descriptor.token);

    // Ready = the attached session's baseline is durably published.
    const baseline = await awaitEventType(reader, sessionId, BASELINE_COMPLETED_TYPE, 0n);
    if (stopping) return await shutdownComplete!;
    let readyThroughSeq = baseline.durableSeq;

    if (args.scenario !== null) {
      const scenario = getScenario(args.scenario)!;
      io.stderr(`qa-daemon: seeding scenario ${scenario.name}…`);
      readyThroughSeq = await scenario.seed({
        worktree, sessionId, reader, signal: controller.signal, after: baseline.seq,
      });
      if (stopping) return await shutdownComplete!;
    }

    const env: QaEnv = {
      format: QA_ENV_FORMAT,
      state: 'ready',
      run_id: runId,
      owner_run_id: owner.run_id,
      daemon_commit: daemonCommit,
      daemon_dirty: daemonDirty,
      store,
      worktree,
      descriptor_path: descriptorPath,
      url: descriptor.url,
      token: descriptor.token,
      session_id: sessionId,
      ready_through_seq: readyThroughSeq.toString(),
      scenario: args.scenario,
    };
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

    // Success path: keep the daemon alive until a signal fires the shared shutdown,
    // which cleans up and releases this waiter. The exit code reflects whether
    // teardown succeeded — a failed shutdown reports non-zero, never a false 0.
    if (stopping) return exitCode; // a signal already arrived during startup
    await new Promise<void>((resolvePromise) => { readyResolve = resolvePromise; });
    return exitCode;
  } catch (err) {
    // If a shutdown is already in flight, this throw is a byproduct of the
    // concurrent teardown — the control socket closed underneath an in-flight
    // attach/baseline/seed step (e.g. write EPIPE). The signal handler's
    // performCleanup owns teardown and the exit code, so defer to it rather than
    // running a second cleanup and surfacing a teardown-induced error as a startup
    // failure. Only a throw with no shutdown in progress is a genuine startup
    // failure that must clean up and propagate.
    if (stopping) return await shutdownComplete!;
    await performCleanup().catch(() => {});
    throw err;
  }
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

/** Mark THIS run's published qa-env.json as stopped, guarded by run_id. A run
 * only ever relabels the env it itself published. Two `--reuse` runs can slip
 * past the liveness refusal (each mints a fresh nonce and adopts the same kept
 * marker) and contend for the one control socket; the loser's `startDaemon`
 * fails and its cleanup must NOT rewrite the winner's still-live env as
 * `stopped` and strand the winner's readiness wait. A mismatched env is left
 * untouched — a no-op, never a false stop for another run. (This is the
 * documented concurrent-`--reuse` behavior: the liveness refusal handles the
 * common case; beyond it the runs degrade to pre-5a86f14 semantics rather than
 * a new lock, and neither corrupts the other's readiness metadata.) */
export async function markStopped(envPath: string, runId: string): Promise<void> {
  const env = await readQaEnv(envPath);
  if (env.run_id !== runId) return;
  await writeQaEnv(envPath, { ...env, state: 'stopped' });
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
