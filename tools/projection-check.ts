/**
 * `npm run qa:check` — the Part 5 QA command surface. Eight subcommands:
 *
 *  - `acceptance`: a registry + runner that proves each PR did what it claims by
 *    driving a LIVE daemon and asserting on its public reader output.
 *  - `fold`: the `display-fold.v1` oracle (DISPLAY-FOLD.md). `fold --fixture <name>`
 *    or `fold --events <path|->` prints exactly one canonical JSON envelope. Exit
 *    0 = `ok`; 1 = the fold refused (invalid / corrupt / unsupported; the envelope
 *    is still printed); 2 = bad args, missing fixture, unreadable input, invalid
 *    UTF-8, or malformed NDJSON (diagnostic on stderr, nothing on stdout).
 *  - `interface`: the `interface.v1` oracle (INTERFACE-PROJECTION.md).
 *    `interface --fixture <name> [--check]` or `interface --input <path|->` prints
 *    exactly one canonical envelope. Exit 0 = envelope produced (with --check it
 *    matched the fixture's expected.json); 1 = --check mismatch (envelope still
 *    printed); 2 = bad args, missing fixture, unreadable/malformed input.
 *  - `interface-v2-contract`: validates the hand-written `interface.v2` fixtures
 *    (FUNCTION-CHANGES.md §5.3; see tools/interface-v2-contract.ts). Prints one
 *    JSON report; exit 0 = every case valid and the negative control rejected,
 *    1 = otherwise, 2 = bad args or an unloadable contract. Takes no arguments.
 *  - `swift-parse`: the Swift-grammar feasibility checker (SWIFT-GRAMMAR.md).
 *    `swift-parse --fixture <name>` or `swift-parse --file <path|->` loads the
 *    pinned grammar in the isolated host and prints one JSON report (artifact
 *    provenance, root type, `clean`, ERROR/MISSING diagnostics with UTF-8 byte
 *    spans, timings). Exit 0 = clean; 1 = parse errors (report still printed);
 *    2 = bad input or an artifact/host failure (diagnostic on stderr, no report).
 *  - `swift-measure`: cold start (init + language load) and first/warm parse time
 *    for small/medium/large representative sources, as one JSON report. Numbers
 *    are measurements, not budgets (D7). Exit 0 = all clean; 1 = a source parsed
 *    with ERROR/MISSING nodes (report still printed); 2 = artifact/host failure.
 *    Takes no arguments.
 *  - `fold-release`: the display-fold.v1 release gates (fingerprint + immutability;
 *    see tools/fold-release-check.ts). Prints one JSON result; exit 0 = pass, 1 =
 *    a gate failed, 2 = bad args or an unresolvable base ref.
 *  - `admission`: saturates the shared projection admission budget with synthetic
 *    jobs (or validates a supplied trace) and checks its invariants. Exit 0 =
 *    invariants held; 1 = an invariant was violated; 2 = bad args / unreadable
 *    trace. See tools/projection-admission-check.ts.
 *
 * `acceptance` contract (kept deliberately narrow):
 *  - stdout carries EXACTLY one JSON report on a run that executed checks; all
 *    progress goes to stderr, and the bearer token is never printed anywhere.
 *  - Exit 0 = every selected assertion passed; 1 = a check ran and failed (assertion,
 *    durability deadline, or cleanup); 2 = bad args / missing check / wrong
 *    runtime / wrong daemon revision (a skipped check never counts as passing);
 *    130 = interrupted.
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
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
import { canonicalJson } from '../src/display-fold.ts';
import {
  InterfaceInputError,
  corpusCasePath as interfaceCasePath,
  interfaceToLine,
  parseInterfaceInput,
} from './interface-projection-oracle.ts';
import { runSwiftParseChild, runSwiftParseFile, runSwiftParseStdin, swiftFixturePath, SwiftFixtureError } from '../src/swift-parse.ts';
import type { HostResult } from '../src/swift-parse-host.ts';
import { runFoldRelease } from './fold-release-check.ts';
import { runAdmission } from './projection-admission-check.ts';
import { runInterfaceV2Contract } from './interface-v2-contract.ts';
import { runInterfaceV2TypeScriptCheck } from './interface-v2-typescript-check.ts';
import type { AcceptanceContext, AcceptanceModule } from './qa/acceptance/types.ts';

/**
 * Validate an operator-supplied `--env`'s worktree the same way `qa-daemon.ts`
 * itself validates a root before touching it: not overlapping the real store,
 * and carrying an ownership marker claimed by the SAME run that wrote this env
 * file. Without this, a matching `daemon_commit` alone was enough to accept
 * `env.worktree` — a mistaken or stale env file could point acceptance checks
 * (which write and delete files) at an unrelated, unowned worktree.
 */
async function validateEnvSandbox(env: { worktree: string; run_id: string; owner_run_id?: string }): Promise<string | null> {
  const root = dirname(env.worktree);
  const overlap = await checkRootAgainstRealStore(root);
  if (overlap) return overlap.message;
  const marker = await readOwnerMarker(root);
  const ownerRunId = env.owner_run_id ?? env.run_id;
  if (marker === null || marker.run_id !== ownerRunId) {
    return `${root} has no ownership marker matching owner_run_id ${ownerRunId}; refusing to run against an unowned worktree`;
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
    try {
      env = await readQaEnv(args.env);
    } catch (err) {
      // A missing or malformed --env is an operator-input error, like a bad flag:
      // report it as USAGE with a clear message rather than letting it reach the
      // fatal handler as an uncaught stack trace with no diagnosable output.
      io.stderr(`qa-check: --env ${args.env} could not be read: ${(err as Error).message}`);
      return EXIT.USAGE;
    }
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

    const needsDaemon = mod.needsDaemon !== false;
    let handle: QaDaemonHandle | null = null;
    let ephemeralRoot: string | null = null;
    let reader: ReaderClient;
    let worktree: string;
    let sessionId: string;

    try {
      if (!needsDaemon) {
        // A self-contained module may only use ctx.signal. Keep the existing
        // context shape so daemon-backed modules retain their strict contract.
        reader = {} as ReaderClient;
        worktree = '';
        sessionId = '';
      } else if (env !== null) {
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
  readStdin: (signal?: AbortSignal) => Promise<Uint8Array>;
  signal?: AbortSignal;
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
      bytes = await io.readStdin(io.signal);
    } else {
      bytes = await readFile(resolve(io.cwd, input.events)).catch((err: NodeJS.ErrnoException) => {
        throw new FoldInputError(`cannot read events file: ${err.code ?? err.message}`);
      });
    }
    records = parseFoldInput(bytes);
  } catch (err) {
    if (!(err instanceof ArgError) && !(err instanceof FoldInputError) && !(err instanceof StdinReadAbortError)) throw err;
    io.stderr(`qa-check fold: ${err.message}`);
    return EXIT.USAGE;
  }
  const { line, exit } = foldToLine(records);
  io.stdout(line);
  return exit === 0 ? EXIT.PASS : EXIT.FAIL;
}

export interface InterfaceIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  readStdin: (signal?: AbortSignal) => Promise<Uint8Array>;
  signal?: AbortSignal;
}

export interface SwiftParseIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
  readStdin: (signal?: AbortSignal) => Promise<Uint8Array>;
  signal?: AbortSignal;
}

type InterfaceArgs = { fixture: string; check: boolean } | { input: string };

function parseInterfaceArgs(argv: readonly string[]): InterfaceArgs {
  let fixture: string | null = null;
  let input: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') {
      check = true;
      continue;
    }
    if (flag !== '--fixture' && flag !== '--input') throw new ArgError(`unknown interface argument '${flag}'`);
    const value = argv[++i];
    if (value === undefined) throw new ArgError(`${flag} requires a value`);
    if (fixture !== null || input !== null) {
      throw new ArgError('interface takes exactly one of --fixture <name> / --input <path|->');
    }
    if (flag === '--fixture') fixture = value;
    else input = value;
  }
  if (fixture === null && input === null) throw new ArgError('interface requires --fixture <name> or --input <path|->');
  if (input !== null) {
    if (check) throw new ArgError('--check compares against a fixture; use it with --fixture <name>');
    return { input };
  }
  return { fixture: fixture!, check };
}

/**
 * `qa:check interface`: the interface.v1 oracle. Reads and validates the whole
 * input before building, so an exit-2 run never prints a partial envelope.
 * Exit 0 = a valid envelope was produced (any status; with --check it matched
 * the fixture's expected.json); 1 = --check mismatch (the actual envelope is
 * still printed for diffing); 2 = bad args / unreadable / malformed input
 * (diagnostic on stderr, nothing on stdout).
 */
export async function runInterface(io: InterfaceIO): Promise<number> {
  let line: string;
  let expectedPath: string | null = null;
  try {
    const args = parseInterfaceArgs(io.argv);
    let bytes: Uint8Array;
    if ('fixture' in args) {
      const path = interfaceCasePath(args.fixture, 'input.json');
      bytes = await readFile(path).catch(() => {
        throw new InterfaceInputError(`no fixture named '${args.fixture}'`);
      });
      if (args.check) expectedPath = interfaceCasePath(args.fixture, 'expected.json');
    } else if (args.input === '-') {
      bytes = await io.readStdin(io.signal);
    } else {
      bytes = await readFile(resolve(io.cwd, args.input)).catch((err: NodeJS.ErrnoException) => {
        throw new InterfaceInputError(`cannot read input file: ${err.code ?? err.message}`);
      });
    }
    line = interfaceToLine(parseInterfaceInput(bytes));
  } catch (err) {
    if (!(err instanceof ArgError) && !(err instanceof InterfaceInputError) && !(err instanceof StdinReadAbortError)) throw err;
    io.stderr(`qa-check interface: ${err.message}`);
    return EXIT.USAGE;
  }

  if (expectedPath !== null) {
    let expected: string;
    try {
      const bytes = await readFile(expectedPath);
      expected = canonicalJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (err) {
      io.stderr(`qa-check interface: cannot read expected.json: ${(err as Error).message}`);
      return EXIT.USAGE;
    }
    io.stdout(line);
    return line === expected ? EXIT.PASS : EXIT.FAIL;
  }

  io.stdout(line);
  return EXIT.PASS;
}

/** Bad input for `swift-parse` (missing/unreadable source, invalid UTF-8) —
 * distinct from ArgError so both map to exit 2 but read clearly. */
class SwiftParseInputError extends Error {}

type SwiftParseSelector = { fixture: string } | { file: string };

function parseSwiftParseArgs(argv: readonly string[]): SwiftParseSelector {
  let input: SwiftParseSelector | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--fixture' && flag !== '--file') throw new ArgError(`unknown swift-parse argument '${flag}'`);
    const value = argv[++i];
    if (value === undefined) throw new ArgError(`${flag} requires a value`);
    if (input) throw new ArgError('swift-parse takes exactly one of --fixture <name> / --file <path|->');
    input = flag === '--fixture' ? { fixture: value } : { file: value };
  }
  if (!input) throw new ArgError('swift-parse requires --fixture <name> or --file <path|->');
  return input;
}

/** `projection-check swift-parse`: load the pinned Swift grammar in the isolated
 * host, parse one source, and print a JSON report (artifact provenance, root
 * type, `clean`, ERROR/MISSING diagnostics with UTF-8 byte spans, timings).
 * Named files are read and decoded only by the isolated host; stdin bytes are
 * forwarded directly to it. Exit 0 = clean parse; 1 = parse produced ERROR/MISSING nodes;
 * 2 = bad input or an artifact/host failure. */
export async function runSwiftParseCheck(io: SwiftParseIO): Promise<number> {
  let run: () => Promise<Extract<HostResult, { op: 'parse' }>>;
  try {
    const input = parseSwiftParseArgs(io.argv);
    if ('fixture' in input) {
      let path: string;
      try {
        path = swiftFixturePath(input.fixture);
      } catch (err) {
        if (err instanceof SwiftFixtureError) throw new SwiftParseInputError(err.message);
        throw err;
      }
      run = () => runSwiftParseFile<Extract<HostResult, { op: 'parse' }>>(path, { signal: io.signal });
    } else if (input.file === '-') {
      const bytes = await io.readStdin(io.signal);
      run = () => runSwiftParseStdin<Extract<HostResult, { op: 'parse' }>>(bytes, { signal: io.signal });
    } else {
      const path = resolve(io.cwd, input.file);
      await access(path).catch((err: NodeJS.ErrnoException) => {
        throw new SwiftParseInputError(`cannot read Swift file: ${err.code ?? err.message}`);
      });
      run = () => runSwiftParseFile<Extract<HostResult, { op: 'parse' }>>(path, { signal: io.signal });
    }
  } catch (err) {
    if (!(err instanceof ArgError) && !(err instanceof SwiftParseInputError) && !(err instanceof StdinReadAbortError)) throw err;
    io.stderr(`swift-parse: ${err.message}`);
    return EXIT.USAGE;
  }

  let res: Extract<HostResult, { op: 'parse' }>;
  try {
    res = await run();
  } catch (err) {
    // A host/artifact failure (sha mismatch, ABI reject, crash) is not a clean
    // parse-error result — surface it as exit 2, never as a passing report.
    io.stderr(`swift-parse: artifact/host failed: ${(err as Error).message}`);
    return EXIT.USAGE;
  }

  io.stdout(JSON.stringify({
    artifact: res.provenance,
    rootType: res.result.rootType,
    clean: res.result.clean,
    byteLength: res.result.byteLength,
    diagnostics: res.result.diagnostics,
    timings: res.timings,
  }));
  return res.result.clean ? EXIT.PASS : EXIT.FAIL;
}

/** Three representative Swift sources of increasing size, for the cold/warm
 * measurement the brief requires (small / medium / large). Synthetic and
 * deterministic so the byte sizes are stable across machines; the timings are
 * not (they are the point). */
function representativeSwiftSources(): { label: string; source: string }[] {
  const small = 'func greet(name: String) -> String { return name }\n';
  const medium =
    'import Foundation\n\nstruct Widget {\n' +
    Array.from({ length: 40 }, (_, i) => `  func step${i}(_ x: Int) -> Int { return x + ${i} }`).join('\n') +
    '\n}\n';
  const large =
    'import Foundation\n\n' +
    Array.from({ length: 4000 }, (_, i) => `func f${i}(_ a: Int, _ b: Int) -> Int { let c = a + b; return c * ${i} }`).join('\n') +
    '\n';
  return [{ label: 'small', source: small }, { label: 'medium', source: medium }, { label: 'large', source: large }];
}

/** `projection-check swift-measure`: load the pinned grammar once in the isolated
 * host and report cold start (init + language load) plus first/warm parse time
 * for small/medium/large representative sources. Prints one JSON report; the
 * numbers are measurements, not budgets (D7). Exit 0 = all parsed clean; 1 = a
 * source parsed with ERROR/MISSING nodes; 2 = an artifact/host failure. Takes no
 * arguments. */
export async function runSwiftMeasure(io: { argv: readonly string[]; stdout: (l: string) => void; stderr: (l: string) => void; signal?: AbortSignal }): Promise<number> {
  if (io.argv.length > 0) {
    io.stderr(`swift-measure: unexpected argument '${io.argv[0]}' (takes none)`);
    return EXIT.USAGE;
  }
  let res: Extract<HostResult, { op: 'measure' }>;
  try {
    res = await runSwiftParseChild<Extract<HostResult, { op: 'measure' }>>({ op: 'measure', sources: representativeSwiftSources() }, { signal: io.signal });
  } catch (err) {
    io.stderr(`swift-measure: artifact/host failed: ${(err as Error).message}`);
    return EXIT.USAGE;
  }
  io.stdout(JSON.stringify({ artifact: res.provenance, initAndLoadMs: res.initAndLoadMs, parses: res.parses }));
  return res.parses.every((p) => p.clean) ? EXIT.PASS : EXIT.FAIL;
}

export class StdinReadAbortError extends Error {
  constructor() {
    super('stdin read aborted by signal');
  }
}

/** Read stdin until EOF, or stop the underlying stream as soon as the caller aborts. */
export async function readAllStdin(signal?: AbortSignal, stdin: Readable = process.stdin): Promise<Uint8Array> {
  let aborted = signal?.aborted ?? false;
  const onAbort = (): void => {
    aborted = true;
    stdin.destroy();
  };
  if (aborted) stdin.destroy();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
  } catch (err) {
    if (aborted) throw new StdinReadAbortError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (aborted) throw new StdinReadAbortError();
  return Buffer.concat(chunks);
}

export async function main(io: Omit<RunIO, 'argv' | 'signal'> & { argv: readonly string[] }): Promise<number> {
  const [sub, ...rest] = io.argv;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (sub === 'fold') return runFold({ ...io, argv: rest, readStdin: readAllStdin, signal: controller.signal });
    if (sub === 'interface') return runInterface({ ...io, argv: rest, readStdin: readAllStdin, signal: controller.signal });
    if (sub === 'swift-parse') return runSwiftParseCheck({ ...io, argv: rest, readStdin: readAllStdin, signal: controller.signal });
    if (sub === 'swift-measure') return runSwiftMeasure({ argv: rest, stdout: io.stdout, stderr: io.stderr, signal: controller.signal });
    if (sub === 'fold-release') return runFoldRelease({ ...io, argv: rest });
    if (sub === 'admission') return runAdmission({ argv: rest, stdout: io.stdout, stderr: io.stderr, cwd: io.cwd });
    if (sub === 'interface-v2-contract') return runInterfaceV2Contract({ argv: rest, stdout: io.stdout, stderr: io.stderr });
    if (sub === 'interface-v2') return runInterfaceV2TypeScriptCheck(rest, io.stdout, io.stderr);
    if (sub !== 'acceptance') {
      io.stderr(`qa-check: unknown subcommand '${sub ?? ''}'; expected 'acceptance', 'fold', 'interface', 'interface-v2-contract', 'interface-v2', 'swift-parse', 'swift-measure', 'fold-release', or 'admission'`);
      return EXIT.USAGE;
    }
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
