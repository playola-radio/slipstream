/**
 * In-process instrumentation for the auto-capture bench subject. Installed BEFORE
 * any product module is imported: it replaces the `node:fs`, `node:fs/promises`,
 * `node:child_process` and timer exports, then `syncBuiltinESMExports()` makes
 * the product's named ESM imports see the wrappers.
 *
 * Scope, disclosed in the report: main-thread JS calls only. Native-addon I/O
 * (@parcel/watcher's FSEvents thread), libuv internals, and the reader's worker
 * threads (separate isolates) are not traced.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
import { classifyPath, type PathClass } from './probe-model.ts';

export interface ProbeCounters {
  /** calls[class][op] */
  calls: Record<PathClass, Record<string, number>>;
  bytesRead: Record<PathClass, number>;
  bytesWritten: Record<PathClass, number>;
  spawns: number;
  /** Timer callbacks more than 1 ms after the previous one: a lower bound on
   * main-thread timer wakeups (coalesced firings count once). */
  timerWakeups: number;
}

const CLASSES: readonly PathClass[] = ['worktree', 'store', 'lock', 'transcript', 'other'];

function emptyCounters(): ProbeCounters {
  const perClass = <T>(make: () => T) => Object.fromEntries(CLASSES.map((c) => [c, make()])) as Record<PathClass, T>;
  return {
    calls: perClass(() => ({})), bytesRead: perClass(() => 0), bytesWritten: perClass(() => 0),
    spawns: 0, timerWakeups: 0,
  };
}

let counters = emptyCounters();
let roots: { worktrees: string; store: string; transcripts: string } | undefined;
const handlePaths = new WeakMap<object, string>();
const fdPaths = new Map<number, string>();
let lastTimerFireNs = 0n;

export function configureProbeRoots(r: { worktrees: string; store: string; transcripts: string }): void {
  roots = r;
}

export function readProbeCounters(): ProbeCounters {
  return structuredClone(counters);
}

export function resetProbeCounters(): void {
  counters = emptyCounters();
}

function pathOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.pathname;
  if (Buffer.isBuffer(arg)) return arg.toString();
  if (typeof arg === 'number') return fdPaths.get(arg);
  return undefined;
}

function note(path: string | undefined, op: string): PathClass {
  const cls = roots && path !== undefined ? classifyPath(path, roots) : 'other';
  const bucket = counters.calls[cls];
  bucket[op] = (bucket[op] ?? 0) + 1;
  return cls;
}

const READ_OPS = new Set(['read', 'readSync', 'readFile', 'readFileSync']);
const WRITE_OPS = new Set(['write', 'writeSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']);

function byteCount(op: string, result: unknown, args: unknown[]): number {
  if (op === 'read' || op === 'readSync') {
    if (typeof result === 'number') return result;
    if (result && typeof result === 'object' && 'bytesRead' in result) return Number(result.bytesRead);
  }
  if (op === 'write' || op === 'writeSync') {
    if (typeof result === 'number') return result;
    if (result && typeof result === 'object' && 'bytesWritten' in result) return Number(result.bytesWritten);
  }
  if (op.startsWith('readFile')) return typeof result === 'string' ? Buffer.byteLength(result) : Buffer.isBuffer(result) ? result.length : 0;
  if (op.startsWith('writeFile') || op.startsWith('appendFile')) {
    const data = args[1];
    return typeof data === 'string' ? Buffer.byteLength(data) : ArrayBuffer.isView(data) ? data.byteLength : 0;
  }
  return 0;
}

function account(cls: PathClass, op: string, result: unknown, args: unknown[]): void {
  const n = byteCount(op, result, args);
  if (READ_OPS.has(op)) counters.bytesRead[cls] += n;
  else if (WRITE_OPS.has(op)) counters.bytesWritten[cls] += n;
}

type AnyFn = (...args: unknown[]) => unknown;

function wrapPromiseApi(target: Record<string, unknown>, name: string): void {
  const original = target[name];
  if (typeof original !== 'function' || /^[A-Z]/.test(name)) return;
  target[name] = function wrapped(this: unknown, ...args: unknown[]) {
    const path = pathOf(args[0]);
    const cls = note(path, name);
    const out = (original as AnyFn).apply(this, args);
    if (out instanceof Promise) {
      return out.then((result) => {
        if (name === 'open' && result && typeof result === 'object' && path !== undefined) handlePaths.set(result, path);
        account(cls, name, result, args);
        return result;
      });
    }
    return out;
  };
}

function wrapSyncOrCallbackApi(target: Record<string, unknown>, name: string): void {
  const original = target[name];
  if (typeof original !== 'function' || /^[A-Z]/.test(name) || name === 'promises') return;
  target[name] = function wrapped(this: unknown, ...args: unknown[]) {
    const path = pathOf(args[0]);
    const cls = note(path, name);
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = (err: unknown, result: unknown, ...rest: unknown[]) => {
        if (!err) {
          if (name === 'open' && typeof result === 'number' && path !== undefined) fdPaths.set(result, path);
          if (name === 'close' && typeof args[0] === 'number') fdPaths.delete(args[0]);
          account(cls, name, result, args);
        }
        return (last as AnyFn)(err, result, ...rest);
      };
    }
    const result = (original as AnyFn).apply(this, args);
    if (name.endsWith('Sync')) {
      if (name === 'openSync' && typeof result === 'number' && path !== undefined) fdPaths.set(result, path);
      if (name === 'closeSync' && typeof args[0] === 'number') fdPaths.delete(args[0]);
      account(cls, name, result, args);
    }
    return result;
  };
}

function wrapFileHandle(proto: Record<string, unknown>): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function' || name === 'constructor') continue;
    const original = desc.value as AnyFn;
    proto[name] = function wrapped(this: object, ...args: unknown[]) {
      const cls = note(handlePaths.get(this), `fh.${name}`);
      const out = original.apply(this, args);
      // A handle method has no path argument, so its data sits one slot earlier than in fs.writeFile(path, data).
      if (out instanceof Promise) return out.then((result) => { account(cls, name, result, [undefined, ...args]); return result; });
      return out;
    };
  }
}

function wrapTimer(target: Record<string, unknown>, name: 'setTimeout' | 'setInterval'): void {
  const original = target[name] as AnyFn;
  target[name] = function wrapped(this: unknown, callback: unknown, ...rest: unknown[]) {
    if (typeof callback !== 'function') return original.call(this, callback, ...rest);
    const fire = function (this: unknown, ...cbArgs: unknown[]) {
      const now = process.hrtime.bigint();
      if (now - lastTimerFireNs > 1_000_000n) counters.timerWakeups++;
      lastTimerFireNs = now;
      return (callback as AnyFn).apply(this, cbArgs);
    };
    return original.call(this, fire, ...rest);
  };
}

export async function installProbes(): Promise<void> {
  const fh = await fsp.open(new URL(import.meta.url), 'r');
  const fileHandleProto = Object.getPrototypeOf(fh) as Record<string, unknown>;
  await fh.close();

  for (const name of Object.keys(fsp)) wrapPromiseApi(fsp as unknown as Record<string, unknown>, name);
  for (const name of Object.keys(fs)) wrapSyncOrCallbackApi(fs as unknown as Record<string, unknown>, name);
  wrapFileHandle(fileHandleProto);

  const cp = childProcess as unknown as Record<string, unknown>;
  for (const name of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync']) {
    const original = cp[name] as AnyFn;
    cp[name] = function wrapped(this: unknown, ...args: unknown[]) {
      counters.spawns++;
      return original.apply(this, args);
    };
  }

  for (const target of [globalThis as unknown as Record<string, unknown>, timers as unknown as Record<string, unknown>]) {
    wrapTimer(target, 'setTimeout');
    wrapTimer(target, 'setInterval');
  }
  syncBuiltinESMExports();
}
