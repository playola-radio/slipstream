/**
 * `npm run qa:check` — the Part 5 QA command surface. Two subcommands:
 *
 *  - `acceptance`: a registry + runner that proves each PR did what it claims by
 *    driving a LIVE daemon and asserting on its public reader output.
 *  - `fold`: the `display-fold.v1` oracle (DISPLAY-FOLD.md). `fold --fixture <name>`
 *    or `fold --events <path|->` prints exactly one canonical JSON envelope. Exit
 *    0 = `ok`; 1 = the fold refused (invalid / corrupt / unsupported; the envelope
 *    is still printed); 2 = bad args, missing fixture, unreadable input, invalid
 *    UTF-8, or malformed NDJSON (diagnostic on stderr, nothing on stdout).
 *
 * `acceptance` contract (kept deliberately narrow):
 *  - stdout carries EXACTLY one JSON report on a run that executed checks; all
 *    progress goes to stderr, and the bearer token is never printed anywhere.
 *  - Exit 0 = every selected assertion passed; 1 = a check ran and failed (assertion,
 *    durability deadline, or cleanup); 2 = bad args / missing check / wrong
 *    runtime / wrong daemon revision (a skipped check never counts as passing);
 *    130 = interrupted.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isMainModule } from '../src/entrypoint.ts';
import {
  createReaderClient,
  readQaEnv,
  gitHead,
  gitIsDirty,
  buildReport,
  mkdtempRoot,
  rmMkdtempRoot,
  type CheckResult,
  type ReaderClient,
  type QaEnv,
} from './qa-support.ts';
import { startQaDaemon, type QaDaemonHandle } from './qa/harness-proc.ts';
import { checkExistingRealDir, checkRootAgainstRealStore, readOwnerMarker } from './qa/safety.ts';
import { MODULES } from './qa/acceptance/registry.ts';
import { corpusCasePath, FoldInputError, foldToLine, parseFoldInput } from './display-fold-oracle.ts';
import type { AcceptanceContext, AcceptanceModule } from './qa/acceptance/types.ts';

/**
 * Validate an operator-supplied `--env`'s worktree the same way `qa-daemon.ts`
 * itself validates a root before touching it: not overlapping the real store,
 * and carrying an ownership marker claimed by the SAME run that wrote this env
 * file. Without this, a matching `daemon_commit` alone was enough to accept
 * `env.worktree` — a mistaken or stale env file could point acceptance checks
 * (which write and delete files) at an unrelated, unowned worktree.
 */
async function validateEnvSandbox(env: { worktree: string; run_id: string }): Promise<string | null> {
  const root = dirname(env.worktree);
  const overlap = await checkRootAgainstRealStore(root);
  if (overlap) return overlap.message;
  const marker = await readOwnerMarker(root);
  if (marker === null || marker.run_id !== env.run_id) {
    return `${root} has no ownership marker matching run_id ${env.run_id}; refusing to run against an unowned worktree`;
  }
  // An owned parent root does not vouch for the worktree ENTRY: if it is (or has
  // become) a symlink, the acceptance modules' writes and deletes follow it out of
  // the sandbox. Require the worktree itself to be a real, existing directory.
  const worktreeReason = await checkExistingRealDir(env.worktree);
  if (worktreeReason) return worktreeReason;
  return null;
}

export type Selection = { all: true } | { pr: string };
export interface AcceptanceArgs { selection: Selection; env: string | null }

export class ArgError extends Error {}

/** Parse the args that follow the `acceptance` subcommand. Exactly one of
 * `--all` / `--pr <ID>` is required; `--env <path>` is optional. */
export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceArgs {
  let all = false;
  let pr: string | null = null;
  let env: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--all': all = true; break;
      case '--pr': {
        const v = argv[++i];
        if (v === undefined) throw new ArgError('--pr requires a check id');
        pr = v;
        break;
      }
      case '--env': {
        const v = argv[++i];
        if (v === undefined) throw new ArgError('--env requires a path');
        env = v;
        break;
      }
      default:
        throw new ArgError(`unknown argument: ${arg}`);
    }
  }
  if (all && pr !== null) throw new ArgError('choose --all or --pr <ID>, not both');
  if (!all && pr === null) throw new ArgError('one of --all or --pr <ID> is required');
  return { selection: all ? { all: true } : { pr: pr! }, env };
}

/** Exit codes as constants so the mapping is legible and testable. */
export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, INTERRUPTED: 130 } as const;

const PER_MODULE_DEADLINE_MS = 180_000;

export interface RunIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  signal: AbortSignal;
}

function selectedModules(selection: Selection, stderr: (l: string) => void): AcceptanceModule[] | null {
  if ('all' in selection) return [...MODULES];
  const mod = MODULES.find((m) => m.id === selection.pr);
  if (mod === undefined) {
    const known = MODULES.map((m) => m.id).join(', ') || '(none)';
    stderr(`qa-check: no acceptance check registered for '${selection.pr}'; known: ${known}`);
    return null;
  }
  return [mod];
}

/** Run one module against a live reader/session, enforcing a deadline and mapping
 * any throw to a failed check. Never throws. Exported for the cleanup test.
 *
 * The deadline ABORTS the module's own signal rather than racing a bare timer:
 * `Promise.race` only stops runModule from *waiting* on `mod.run` — the module
 * promise itself keeps executing, so it can still make requests, write files, or
 * manage child daemons while the runner reports failure and tears down. Deriving
 * a per-module `AbortController` and passing it in `moduleCtx.signal` gives a
 * well-behaved module (which awaits `ctx.signal`, per the {@link AcceptanceContext}
 * contract) a real signal to stop on, and runModule awaits `mod.run` directly so
 * it cannot resolve — and teardown cannot start — before the module actually
 * settles. */
export async function runModule(
  mod: AcceptanceModule,
  ctx: AcceptanceContext,
  stderr: (l: string) => void,
  opts?: { deadlineMs?: number },
): Promise<CheckResult> {
  stderr(`qa-check: running ${mod.id}…`);
  const deadlineMs = opts?.deadlineMs ?? PER_MODULE_DEADLINE_MS;
  const mc = new AbortController();
  let timedOut = false;
  const onOuterAbort = (): void => mc.abort();
  ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; mc.abort(); }, deadlineMs);
  try {
    const moduleCtx: AcceptanceContext = { ...ctx, signal: mc.signal };
    const { assertions } = await mod.run(moduleCtx);
    stderr(`qa-check: ${mod.id} passed (${assertions.length} assertions)`);
    return { id: mod.id, result: 'passed', assertions };
  } catch (err) {
    const message = timedOut ? `check ${mod.id} exceeded ${deadlineMs}ms` : (err as Error).message;
    stderr(`qa-check: ${mod.id} FAILED: ${message}`);
    return { id: mod.id, result: 'failed', assertions: [], error: message };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * The `acceptance` runner. Returns the process exit code and prints at most one
 * JSON report to stdout (only when checks actually executed).
 */
export async function runAcceptance(io: RunIO): Promise<number> {
  let args: AcceptanceArgs;
  try {
    args = parseAcceptanceArgs(io.argv);
  } catch (err) {
    io.stderr(`qa-check: ${(err as Error).message}`);
    io.stderr(`qa-check: usage: qa:check -- --all | --pr <ID> [--env <qa-env.json>]`);
    return EXIT.USAGE;
  }

  const mods = selectedModules(args.selection, io.stderr);
  if (mods === null) return EXIT.USAGE;

  // An already-aborted signal wins over platform gating and setup: the caller asked
  // to stop, so report INTERRUPTED before doing any work. Otherwise a darwin-only
  // module in the selection would return USAGE on Linux before the abort is seen.
  if (io.signal.aborted) return EXIT.INTERRUPTED;

  const head = await gitHead(io.cwd).catch(() => 'unknown');
  const dirty = await gitIsDirty(io.cwd).catch(() => true); // unknown reads as dirty, never a false-clean claim
  if (dirty) {
    io.stderr(`qa-check: this checkout has uncommitted changes; the report's commit ${head} does not fully describe the code under test`);
  }

  // Validate the operator-supplied --env BEFORE the platform gate. The --env
  // contract (fresh commit) and the sandbox-ownership safety check depend only on
  // the env file, not on which modules run or on this host's platform, so they must
  // run first. If they came after the gate, a darwin-only module in the selection
  // would make a stale or unowned --env return the gate's USAGE on Linux instead of
  // being refused for the real reason — and the sandbox safety check would never run.
  let env: QaEnv | null = null;
  if (args.env !== null) {
    env = await readQaEnv(args.env);
    if (env.daemon_commit !== head) {
      io.stderr(`qa-check: --env daemon_commit ${env.daemon_commit} does not match HEAD ${head}; refusing to run against a stale daemon`);
      return EXIT.USAGE;
    }
    if (env.daemon_dirty) {
      io.stderr(`qa-check: --env daemon at ${env.daemon_commit} had uncommitted changes when it started; the commit match does not fully describe the code it runs`);
    }
    // Sandbox gate: a matching commit is not proof the worktree is a harness-owned
    // sandbox. Refuse the same way qa-daemon.ts refuses at startup.
    const refusal = await validateEnvSandbox(env);
    if (refusal !== null) {
      io.stderr(`qa-check: ${refusal}`);
      return EXIT.USAGE;
    }
  }

  // Precondition: platform gate. A module that cannot run here is not skipped-as-pass.
  for (const mod of mods) {
    if (mod.requiresPlatform !== undefined && process.platform !== mod.requiresPlatform) {
      io.stderr(`qa-check: ${mod.id} requires platform ${mod.requiresPlatform}, not ${process.platform}; refusing to report a skipped check as passing`);
      return EXIT.USAGE;
    }
  }

  const checks: CheckResult[] = [];
  let sawFailure = false;

  for (const mod of mods) {
    if (io.signal.aborted) return EXIT.INTERRUPTED;

    let handle: QaDaemonHandle | null = null;
    let ephemeralRoot: string | null = null;
    let reader: ReaderClient;
    let worktree: string;
    let sessionId: string;

    try {
      if (env !== null) {
        // Operator-supplied daemon, already validated above (fresh commit + sandbox).
        reader = createReaderClient(env.url, env.token);
        worktree = env.worktree;
        sessionId = env.session_id;
      } else {
        // Isolated harness: spawn our own daemon from the current checkout.
        ephemeralRoot = await mkdtempRoot('slipstream-qa-check-');
        handle = await startQaDaemon({ root: ephemeralRoot, ...(mod.scenario ? { scenario: mod.scenario } : {}) });
        reader = createReaderClient(handle.env.url, handle.env.token);
        worktree = handle.env.worktree;
        sessionId = handle.env.session_id;
      }
    } catch (err) {
      // Failure to stand up the daemon is a failed check, not a usage error.
      io.stderr(`qa-check: ${mod.id} setup failed: ${(err as Error).message}`);
      checks.push({ id: mod.id, result: 'failed', assertions: [], error: `setup: ${(err as Error).message}` });
      sawFailure = true;
      if (handle) await handle.stop().catch(() => {});
      if (ephemeralRoot) await rmMkdtempRoot(ephemeralRoot).catch(() => {});
      continue;
    }

    const ctx: AcceptanceContext = { worktree, sessionId, reader, signal: io.signal };
    const result = await runModule(mod, ctx, io.stderr);
    checks.push(result);
    if (result.result === 'failed') sawFailure = true;

    // Teardown the harness we started; a teardown failure is itself a check
    // failure, and must be recorded IN THE REPORT — not just in the exit code —
    // or the JSON would claim `passed` while the process exits non-zero. Mutating
    // the pushed result (buildReport recomputes the overall verdict) keeps the two
    // honest in lockstep.
    let stopFailed = false;
    if (handle) {
      try {
        await handle.stop();
      } catch (err) {
        stopFailed = true;
        const message = `cleanup: ${(err as Error).message}`;
        io.stderr(`qa-check: ${mod.id} cleanup failed: ${(err as Error).message}`);
        result.result = 'failed';
        result.error = result.error ? `${result.error}; ${message}` : message;
        sawFailure = true;
      }
    }
    // A failed stop means the daemon's own teardown retained its root for
    // diagnosis (qa-daemon.ts's own failure-retains-root behavior) — deleting the
    // mkdtemp parent here would discard exactly those artifacts, so skip it.
    if (ephemeralRoot && !stopFailed) await rmMkdtempRoot(ephemeralRoot).catch(() => {});
    else if (ephemeralRoot && stopFailed) io.stderr(`qa-check: ${mod.id} retaining ${ephemeralRoot} for inspection after a failed shutdown`);
  }

  if (io.signal.aborted) return EXIT.INTERRUPTED;

  // Re-sample dirtiness now: a checkout clean at the start can be edited mid-run
  // (e.g. before a later module spawns its daemon), and reporting the initial
  // `dirty: false` would falsely claim the commit describes all the tested code.
  // Report dirty if it was dirty at EITHER sample; a clean→dirty flip is disclosed.
  const dirtyNow = await gitIsDirty(io.cwd).catch(() => true);
  if (dirtyNow && !dirty) {
    io.stderr(`qa-check: the checkout became dirty during the run; the report's commit ${head} does not fully describe the code under test`);
  }
  const report = buildReport(head, dirty || dirtyNow, checks);
  io.stdout(JSON.stringify(report));
  return sawFailure || report.result === 'failed' ? EXIT.FAIL : EXIT.PASS;
}

export interface FoldIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  readStdin: () => Promise<Uint8Array>;
}

type FoldInput = { fixture: string } | { events: string };

function parseFoldArgs(argv: readonly string[]): FoldInput {
  let input: FoldInput | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--fixture' && flag !== '--events') throw new ArgError(`unknown fold argument '${flag}'`);
    const value = argv[++i];
    if (value === undefined) throw new ArgError(`${flag} requires a value`);
    if (input) throw new ArgError('fold takes exactly one of --fixture <name> / --events <path|->');
    input = flag === '--fixture' ? { fixture: value } : { events: value };
  }
  if (!input) throw new ArgError('fold requires --fixture <name> or --events <path|->');
  return input;
}

/** `qa:check fold`: the display-fold.v1 oracle. All input is read and parsed
 * before folding, so an exit-2 run never prints a partial envelope. */
export async function runFold(io: FoldIO): Promise<number> {
  let records: unknown[];
  try {
    const input = parseFoldArgs(io.argv);
    let bytes: Uint8Array;
    if ('fixture' in input) {
      const path = corpusCasePath(input.fixture, 'input.ndjson');
      bytes = await readFile(path).catch(() => { throw new FoldInputError(`no fixture named '${input.fixture}'`); });
    } else if (input.events === '-') {
      bytes = await io.readStdin();
    } else {
      bytes = await readFile(resolve(io.cwd, input.events)).catch((err: NodeJS.ErrnoException) => {
        throw new FoldInputError(`cannot read events file: ${err.code ?? err.message}`);
      });
    }
    records = parseFoldInput(bytes);
  } catch (err) {
    if (!(err instanceof ArgError) && !(err instanceof FoldInputError)) throw err;
    io.stderr(`qa-check fold: ${err.message}`);
    return EXIT.USAGE;
  }
  const { line, exit } = foldToLine(records);
  io.stdout(line);
  return exit === 0 ? EXIT.PASS : EXIT.FAIL;
}

async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function main(io: Omit<RunIO, 'argv' | 'signal'> & { argv: readonly string[] }): Promise<number> {
  const [sub, ...rest] = io.argv;
  if (sub === 'fold') return runFold({ ...io, argv: rest, readStdin: readAllStdin });
  if (sub !== 'acceptance') {
    io.stderr(`qa-check: unknown subcommand '${sub ?? ''}'; expected 'acceptance' or 'fold'`);
    return EXIT.USAGE;
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await runAcceptance({ argv: rest, stdout: io.stdout, stderr: io.stderr, cwd: io.cwd, signal: controller.signal });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  main({
    argv: process.argv.slice(2),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
    cwd: process.cwd(),
  }).then(
    // process.exit discards stdout still queued for an async pipe (macOS), so a
    // large fold envelope would be truncated; exit only once it has flushed.
    (code) => process.stdout.write('', () => process.exit(code)),
    (err) => { console.error(`qa-check: fatal: ${(err as Error).stack ?? err}`); process.exit(EXIT.USAGE); },
  );
}
