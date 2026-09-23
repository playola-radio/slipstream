/**
 * `npm run qa:check` — the Part 5 QA command surface. This PR implements only the
 * `acceptance` subcommand: a registry + runner that proves each PR did what it
 * claims by driving a LIVE daemon and asserting on its public reader output.
 *
 * Contract (kept deliberately narrow):
 *  - stdout carries EXACTLY one JSON report on a run that executed checks; all
 *    progress goes to stderr, and the bearer token is never printed anywhere.
 *  - Exit 0 = every selected assertion passed; 1 = a check ran and failed (assertion,
 *    durability deadline, or cleanup); 2 = bad args / missing check / wrong
 *    runtime / wrong daemon revision (a skipped check never counts as passing);
 *    130 = interrupted.
 */
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../src/entrypoint.ts';
import {
  createReaderClient,
  readQaEnv,
  gitHead,
  buildReport,
  type CheckResult,
  type ReaderClient,
} from './qa-support.ts';
import { startQaDaemon, type QaDaemonHandle } from './qa/harness-proc.ts';
import { MODULES } from './qa/acceptance/registry.ts';
import type { AcceptanceContext, AcceptanceModule } from './qa/acceptance/types.ts';

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
 * any throw to a failed check. Never throws. Exported for the cleanup test. */
export async function runModule(
  mod: AcceptanceModule,
  ctx: AcceptanceContext,
  stderr: (l: string) => void,
): Promise<CheckResult> {
  stderr(`qa-check: running ${mod.id}…`);
  // Hoisted so the finally can clear the timer and drop the abort listener on
  // every path — a module that WINS the race (the common case) must not leak a
  // 180s timer that keeps the loop alive, nor an abort listener that accumulates
  // on the shared signal across modules.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`check ${mod.id} exceeded ${PER_MODULE_DEADLINE_MS}ms`)), PER_MODULE_DEADLINE_MS);
    onAbort = (): void => reject(new Error('interrupted'));
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const { assertions } = await Promise.race([mod.run(ctx), timeout]);
    stderr(`qa-check: ${mod.id} passed (${assertions.length} assertions)`);
    return { id: mod.id, result: 'passed', assertions };
  } catch (err) {
    const message = (err as Error).message;
    stderr(`qa-check: ${mod.id} FAILED: ${message}`);
    return { id: mod.id, result: 'failed', assertions: [], error: message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) ctx.signal.removeEventListener('abort', onAbort);
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

  const head = await gitHead(io.cwd).catch(() => 'unknown');

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
      if (args.env !== null) {
        // Operator-supplied daemon: verify it was built from this checkout.
        const env = await readQaEnv(args.env);
        if (env.daemon_commit !== head) {
          io.stderr(`qa-check: --env daemon_commit ${env.daemon_commit} does not match HEAD ${head}; refusing to run against a stale daemon`);
          return EXIT.USAGE;
        }
        reader = createReaderClient(env.url, env.token);
        worktree = env.worktree;
        sessionId = env.session_id;
      } else {
        // Isolated harness: spawn our own daemon from the current checkout.
        ephemeralRoot = join(await mkdtemp(join(tmpdir(), 'slipstream-qa-check-')), 'root');
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
      if (ephemeralRoot) await rm(ephemeralRoot, { recursive: true, force: true }).catch(() => {});
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
    if (handle) {
      try {
        await handle.stop();
      } catch (err) {
        const message = `cleanup: ${(err as Error).message}`;
        io.stderr(`qa-check: ${mod.id} cleanup failed: ${(err as Error).message}`);
        result.result = 'failed';
        result.error = result.error ? `${result.error}; ${message}` : message;
        sawFailure = true;
      }
    }
    if (ephemeralRoot) await rm(ephemeralRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (io.signal.aborted) return EXIT.INTERRUPTED;

  const report = buildReport(head, checks);
  io.stdout(JSON.stringify(report));
  return sawFailure || report.result === 'failed' ? EXIT.FAIL : EXIT.PASS;
}

export async function main(io: Omit<RunIO, 'argv' | 'signal'> & { argv: readonly string[] }): Promise<number> {
  const [sub, ...rest] = io.argv;
  if (sub !== 'acceptance') {
    io.stderr(`qa-check: unknown subcommand '${sub ?? ''}'; only 'acceptance' is supported in this PR`);
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
    (code) => process.exit(code),
    (err) => { console.error(`qa-check: fatal: ${(err as Error).stack ?? err}`); process.exit(EXIT.USAGE); },
  );
}
