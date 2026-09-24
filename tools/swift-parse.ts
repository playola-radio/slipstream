/**
 * Runner + corpus helpers for the Swift-parse feasibility harness. Everything
 * that must load the grammar goes through `runSwiftParseChild`, which spawns the
 * isolated `--liftoff-only` host (tools/swift-parse-host.ts), so the calling
 * process (checker, test runner, acceptance) never loads Swift itself and can
 * never be aborted by the OOM. The runner owns the child's deadline, abort
 * wiring, and abnormal-exit reporting.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SWIFT_UNISOLATED_ENV } from '../src/swift-grammar.ts';
import type { HostRequest, HostResult } from './swift-parse-host.ts';

export const SWIFT_CORPUS_DIR = fileURLToPath(new URL('../contracts/swift-syntax/v1/', import.meta.url));
const HOST_PATH = fileURLToPath(new URL('./swift-parse-host.ts', import.meta.url));
const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class SwiftFixtureError extends Error {}

export function swiftFixturePath(name: string, file: 'input.swift' | 'expected.json' = 'input.swift'): string {
  if (!CASE_NAME.test(name)) throw new SwiftFixtureError(`invalid fixture name '${name}'`);
  return join(SWIFT_CORPUS_DIR, name, file);
}

export async function listSwiftFixtures(): Promise<string[]> {
  const entries = await readdir(SWIFT_CORPUS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && CASE_NAME.test(e.name)).map((e) => e.name).sort();
}

/** A child that exited abnormally (non-zero, killed by the deadline, or aborted).
 * Carries the exit code/signal and captured stderr for an honest report. */
export class SwiftChildError extends Error {
  readonly detail: { code: number | null; signal: NodeJS.Signals | null; stderr: string };
  constructor(message: string, detail: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) {
    super(message);
    this.name = 'SwiftChildError';
    this.detail = detail;
  }
}

interface RunChildOpts {
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Default true. Set false ONLY for the negative control that proves the
   * default launch aborts (the child is expected to crash). This also passes the
   * isolation-guard escape env so the child reaches the load before aborting. */
  liftoffOnly?: boolean;
}

const DEFAULT_DEADLINE_MS = 30_000;

/** Spawn the isolated host, feed it `request` on stdin, and resolve with its one
 * JSON result. Rejects with SwiftChildError on any abnormal exit. */
export async function runSwiftParseChild<T extends HostResult = HostResult>(
  request: HostRequest,
  opts: RunChildOpts = {},
): Promise<T> {
  // An already-aborted signal must never launch work (the abort listener below
  // only fires on FUTURE aborts).
  if (opts.signal?.aborted) {
    throw new SwiftChildError('swift-parse child aborted before start', { code: null, signal: null, stderr: '' });
  }

  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const unisolated = opts.liftoffOnly === false;
  const execArgv = unisolated ? [] : ['--liftoff-only'];
  const env = unisolated ? { ...process.env, [SWIFT_UNISOLATED_ENV]: '1' } : process.env;
  const child = spawn(process.execPath, [...execArgv, HOST_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { stdout += d; });
  child.stderr.on('data', (d: string) => { stderr += d; });
  // Terminating the child while its stdin still holds buffered input emits EPIPE
  // on the write side; swallow it so a cancellation never escapes the
  // SwiftChildError contract as an uncaught error. The real cause is reported
  // from the close/deadline path below.
  child.stdin.on('error', () => {});

  const timer = setTimeout(() => { killed = 'deadline'; child.kill('SIGKILL'); }, deadlineMs);
  let killed: 'deadline' | 'abort' | null = null;
  const onAbort = (): void => { killed = 'abort'; child.kill('SIGKILL'); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    child.stdin.end(JSON.stringify(request));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (c, s) => resolve([c, s]));
    });
    if (killed === 'deadline') throw new SwiftChildError(`swift-parse child exceeded ${deadlineMs}ms deadline`, { code, signal, stderr });
    if (killed === 'abort') throw new SwiftChildError('swift-parse child aborted by signal', { code, signal, stderr });
    if (code !== 0 || signal !== null) {
      throw new SwiftChildError(`swift-parse child exited abnormally (code=${code}, signal=${signal})`, { code, signal, stderr });
    }
    const line = stdout.trimEnd().split('\n').at(-1) ?? '';
    if (!line) throw new SwiftChildError('swift-parse child produced no result line', { code, signal, stderr });
    return JSON.parse(line) as T;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
