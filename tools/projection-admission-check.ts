/**
 * `projection-check.ts admission` — a synthetic saturation checker for the shared
 * projection admission budget (src/projection-admission.ts). It drives fake
 * compute jobs (test-only; no clip or interface code) against the REAL budget
 * module and reports what happened, then validates the core invariant: peak
 * concurrent running work never exceeded C.
 *
 * Two modes:
 *  - `--saturate [--clip N] [--synthetic N] [--job-ms M]`: run a burst across two
 *    workloads and print the observed trace as JSON. Exit 0 if invariants hold,
 *    1 if violated.
 *  - `--check-trace <path>`: validate a trace supplied as JSON (a fabricated
 *    negative control lives here). Exit 0 if invariants hold, 1 if violated.
 *
 * The invariant check is a pure function so the same teeth that the CLI exits on
 * are reused verbatim by the acceptance harness — no separate test-only path.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createProjectionAdmission,
  PROVISIONAL_SHARED_ADMISSION,
  type AdmissionConfig,
  type AdmitOutcome,
  type ComputeHandle,
} from '../src/projection-admission.ts';

export interface AdmissionTrace {
  config: AdmissionConfig;
  submitted: number;
  admitted: number; // entered the budget (ran or queued), i.e. not overloaded
  overloaded: number;
  ok: number;
  timeouts: number;
  errors: number;
  /** Peak concurrent running computes observed. Must be <= config.C. */
  activeMax: number;
  /** Peak admitted-but-not-running units observed. Must be <= config.Q. */
  queueMax: number;
}

export interface InvariantResult {
  ok: boolean;
  violations: string[];
}

/** The load-bearing invariants. An empty violation list is a claim that the
 * budget never let running work exceed C nor waiting work exceed Q. */
export function checkAdmissionInvariants(trace: AdmissionTrace): InvariantResult {
  const violations: string[] = [];
  const { C, Q } = trace.config;
  if (trace.activeMax > C) {
    violations.push(`active work peaked at ${trace.activeMax}, exceeding C=${C}`);
  }
  if (trace.queueMax > Q) {
    violations.push(`waiting work peaked at ${trace.queueMax}, exceeding Q=${Q}`);
  }
  const settled = trace.ok + trace.timeouts + trace.errors + trace.overloaded;
  if (settled !== trace.submitted) {
    violations.push(`only ${settled} of ${trace.submitted} submitted requests settled`);
  }
  return { ok: violations.length === 0, violations };
}

export interface SaturateOptions {
  clip: number;
  synthetic: number;
  jobMs: number;
}

const DEFAULT_SATURATE: SaturateOptions = { clip: 6, synthetic: 6, jobMs: 200 };

// The synthetic job's own duration IS the work; its timer must keep the event
// loop alive so a standalone `--saturate` run completes (the budget's deadline
// timers stay unref'd, as a pending deadline must never hold the process open).
function hold(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}

/** Run a burst of synthetic jobs across two workloads against the real budget. */
export async function runSaturation(opts: SaturateOptions): Promise<AdmissionTrace> {
  const config = PROVISIONAL_SHARED_ADMISSION;
  const budget = createProjectionAdmission(config);
  let activeNow = 0;
  let activeMax = 0;
  let queueMax = 0;

  const makeRun = () => (): ComputeHandle<string> => {
    activeNow++;
    if (activeNow > activeMax) activeMax = activeNow;
    let done = false;
    const finish = (): void => { if (!done) { done = true; activeNow--; } };
    return { promise: hold(opts.jobMs).then((): string => { finish(); return 'v'; }), cancel: finish };
  };

  const sampleQueue = (): void => {
    const s = budget.snapshot();
    const pending = s.queued + s.waiters;
    if (pending > queueMax) queueMax = pending;
  };

  const admits: Promise<AdmitOutcome<string>>[] = [];
  const submit = (workload: string, localConcurrency: number, count: number): void => {
    for (let i = 0; i < count; i++) {
      admits.push(budget.admit<string>({ workload, localConcurrency, key: `${workload}:${i}`, run: makeRun() }));
      sampleQueue();
    }
  };
  // Interleave the two workloads so both compete for the shared budget.
  const rounds = Math.max(opts.clip, opts.synthetic);
  for (let i = 0; i < rounds; i++) {
    if (i < opts.clip) submit('clip', 1, 1);
    if (i < opts.synthetic) submit('synthetic', config.C, 1);
  }
  sampleQueue();

  const outcomes = await Promise.all(admits);
  await budget.close();

  let overloaded = 0, ok = 0, timeouts = 0, errors = 0;
  for (const o of outcomes) {
    if (o.kind === 'overloaded') overloaded++;
    else if (o.kind === 'ok') ok++;
    else if (o.kind === 'timeout') timeouts++;
    else if (o.kind === 'error') errors++;
    else if (o.kind === 'closed') errors++;
  }
  const submitted = outcomes.length;
  return {
    config, submitted, admitted: submitted - overloaded,
    overloaded, ok, timeouts, errors, activeMax, queueMax,
  };
}

export class AdmissionArgError extends Error {}

type AdmissionMode =
  | { mode: 'saturate'; opts: SaturateOptions }
  | { mode: 'check-trace'; path: string };

export function parseAdmissionArgs(argv: readonly string[]): AdmissionMode {
  let saturate = false;
  let checkTrace: string | null = null;
  const opts: SaturateOptions = { ...DEFAULT_SATURATE };
  const intArg = (flag: string, v: string | undefined): number => {
    if (v === undefined) throw new AdmissionArgError(`${flag} requires a number`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new AdmissionArgError(`${flag} must be a non-negative integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--saturate': saturate = true; break;
      case '--clip': opts.clip = intArg('--clip', argv[++i]); break;
      case '--synthetic': opts.synthetic = intArg('--synthetic', argv[++i]); break;
      case '--job-ms': opts.jobMs = intArg('--job-ms', argv[++i]); break;
      case '--check-trace': {
        const v = argv[++i];
        if (v === undefined) throw new AdmissionArgError('--check-trace requires a path');
        checkTrace = v;
        break;
      }
      default: throw new AdmissionArgError(`unknown argument: ${arg}`);
    }
  }
  if (saturate && checkTrace !== null) throw new AdmissionArgError('choose --saturate or --check-trace, not both');
  if (!saturate && checkTrace === null) throw new AdmissionArgError('one of --saturate or --check-trace <path> is required');
  if (checkTrace !== null) return { mode: 'check-trace', path: checkTrace };
  if (opts.jobMs < 1) throw new AdmissionArgError('--job-ms must be at least 1');
  return { mode: 'saturate', opts };
}

export interface AdmissionIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
}

/** Exit codes mirror the checker's other subcommands. */
const EXIT = { PASS: 0, FAIL: 1, USAGE: 2 } as const;

export async function runAdmission(io: AdmissionIO): Promise<number> {
  let parsed: AdmissionMode;
  try {
    parsed = parseAdmissionArgs(io.argv);
  } catch (err) {
    if (!(err instanceof AdmissionArgError)) throw err;
    io.stderr(`admission: ${err.message}`);
    io.stderr('admission: usage: admission --saturate [--clip N] [--synthetic N] [--job-ms M] | --check-trace <path>');
    return EXIT.USAGE;
  }

  let trace: AdmissionTrace;
  if (parsed.mode === 'saturate') {
    io.stderr(`admission: saturating (clip=${parsed.opts.clip}, synthetic=${parsed.opts.synthetic}, job-ms=${parsed.opts.jobMs})…`);
    trace = await runSaturation(parsed.opts);
  } else {
    let raw: string;
    try {
      raw = await readFile(resolve(io.cwd, parsed.path), 'utf8');
    } catch (err) {
      io.stderr(`admission: cannot read trace: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      return EXIT.USAGE;
    }
    try {
      trace = JSON.parse(raw) as AdmissionTrace;
    } catch {
      io.stderr('admission: trace is not valid JSON');
      return EXIT.USAGE;
    }
    if (typeof trace?.config?.C !== 'number' || typeof trace.activeMax !== 'number') {
      io.stderr('admission: trace is missing required fields (config.C, activeMax)');
      return EXIT.USAGE;
    }
  }

  const verdict = checkAdmissionInvariants(trace);
  io.stdout(JSON.stringify({ ...trace, invariantsHeld: verdict.ok, violations: verdict.violations }));
  if (!verdict.ok) {
    for (const v of verdict.violations) io.stderr(`admission: INVARIANT VIOLATED: ${v}`);
    return EXIT.FAIL;
  }
  return EXIT.PASS;
}
