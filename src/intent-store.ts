import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireSessionLock } from './lock.ts';
import {
  emptyIntent, revokeBinding, withdrawCapture,
  type BindingIntent, type CaptureIntent, type IntentRecord,
} from './capture-intent.ts';
import { FILE_MODE, StorageError, assertOwnerOnly, fsyncDir, mkdirpDurable, writeAll } from './storage.ts';

/**
 * The durable intent record, `<store>/control/intent.json` (contracts.md §8). It
 * is control intent, never evidence that capture happened. Every write is
 * write-temp, fsync, rename, fsync directory, and completes before the
 * acknowledgement it backs.
 */

export function intentPath(storeDir: string): string {
  return join(storeDir, 'control', 'intent.json');
}

/** The record exists but is not a version-1 intent record. The daemon refuses to
 * start rather than reset it: a reset would silently forget withdrawals. */
/** Nothing is recorded for a withdrawal's target. */
export class NoCaptureError extends Error {}

export class IntentCorruptError extends Error {
  constructor(path: string, detail: string) {
    super(`the capture intent record ${path} is unreadable (${detail}). Slipstream will not guess what to resume; `
      + 'move the file aside to start with no recorded captures.');
    this.name = 'IntentCorruptError';
  }
}

export async function loadIntent(storeDir: string): Promise<IntentRecord> {
  const path = intentPath(storeDir);
  let text: string;
  try {
    await assertOwnerOnly(path, 'file');
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIntent();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntentCorruptError(path, 'not JSON');
  }
  const problem = intentProblem(parsed);
  if (problem) throw new IntentCorruptError(path, problem);
  return parsed as IntentRecord;
}

export async function saveIntent(storeDir: string, record: IntentRecord): Promise<void> {
  const dir = join(storeDir, 'control');
  const path = intentPath(storeDir);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdirpDurable(dir);
  try {
    const handle = await open(tmp, 'wx', FILE_MODE);
    try {
      await writeAll(handle, Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8'));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err instanceof StorageError ? err : new StorageError(`write(${path})`, err);
  }
  await fsyncDir(dir);
}

export interface OfflineWithdrawal {
  /** Session ids whose intent this call withdrew (empty when all were already withdrawn). */
  withdrawn: string[];
}

/**
 * Withdraw capture intent while no daemon runs (contracts.md §8): under the store
 * lock, so a daemon starting concurrently either sees this write or holds the
 * lock first and refuses it (`SessionOwnedError`). `target` is a session id or a
 * canonical root; a root withdraws every entry recorded at it. No session log is
 * touched: the capture is not running, so nothing is stopped and no
 * `capture.stopped` is written or backfilled.
 */
export async function withdrawOffline(
  storeDir: string,
  target: { sessionId: string } | { root: string },
  reason: 'detached' | 'archived',
): Promise<OfflineWithdrawal> {
  const lock = await acquireSessionLock(storeDir);
  try {
    const record = await loadIntent(storeDir);
    const entries = 'sessionId' in target
      ? record.captures.filter((c) => c.session_id === target.sessionId)
      : record.captures.filter((c) => c.root === target.root);
    const result: OfflineWithdrawal = { withdrawn: [] };
    for (const entry of entries) {
      if (entry.intent === 'withdrawn') continue;
      withdrawCapture(record, entry.session_id, reason);
      revokeBinding(record, entry.session_id);
      result.withdrawn.push(entry.session_id);
    }
    if (entries.length === 0) {
      throw new NoCaptureError(`no capture is recorded for ${'sessionId' in target ? target.sessionId : target.root}`);
    }
    if (result.withdrawn.length > 0) await saveIntent(storeDir, record);
    return result;
  } finally {
    await lock.release();
  }
}

/** Revoke a capture's linked binding while no daemon runs; false when none is linked. */
export async function unlinkOffline(storeDir: string, sessionId: string): Promise<boolean> {
  const lock = await acquireSessionLock(storeDir);
  try {
    const record = await loadIntent(storeDir);
    if (!revokeBinding(record, sessionId)) return false;
    await saveIntent(storeDir, record);
    return true;
  } finally {
    await lock.release();
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDecimal = (v: unknown): boolean => isString(v) && /^(0|[1-9][0-9]*)$/.test(v);

function captureProblem(c: unknown, i: number): string | null {
  if (!isObject(c)) return `captures[${i}] is not an object`;
  const e = c as Partial<CaptureIntent>;
  if (!isString(e.session_id) || !isString(e.root)) return `captures[${i}] lacks a session id or root`;
  if (e.root_identity !== null && !(isObject(e.root_identity) && isDecimal(e.root_identity.dev) && isDecimal(e.root_identity.ino))) {
    return `captures[${i}].root_identity is malformed`;
  }
  if (!['running', 'waiting', 'withdrawn'].includes(e.intent as string)) return `captures[${i}].intent is unknown`;
  if (![null, 'detached', 'archived'].includes(e.withdrawn_reason as string | null)) return `captures[${i}].withdrawn_reason is unknown`;
  if (e.capture_mode !== 'watch-only') return `captures[${i}].capture_mode is unknown`;
  const f = e.last_failure;
  if (f !== null && !(isObject(f) && isString(f.reason) && isString(f.message) && typeof f.at_ms === 'number'
    && (f.next_attempt_at_ms === null || typeof f.next_attempt_at_ms === 'number'))) {
    return `captures[${i}].last_failure is malformed`;
  }
  return null;
}

function bindingProblem(b: unknown, i: number): string | null {
  if (!isObject(b)) return `bindings[${i}] is not an object`;
  const e = b as Partial<BindingIntent>;
  if (![e.session_id, e.harness_session_id, e.canonical_worktree, e.verified_transcript_path].every(isString)) {
    return `bindings[${i}] lacks an identity field`;
  }
  if (e.harness !== 'claude-code' && e.harness !== 'codex') return `bindings[${i}].harness is unknown`;
  if (!isDecimal(e.binding_generation)) return `bindings[${i}].binding_generation is malformed`;
  if (e.intent !== 'linked' && e.intent !== 'revoked') return `bindings[${i}].intent is unknown`;
  const u = e.unavailable;
  if (u !== null && !(isObject(u) && isString(u.reason) && isString(u.message))) return `bindings[${i}].unavailable is malformed`;
  return null;
}

function intentProblem(v: unknown): string | null {
  if (!isObject(v)) return 'not an object';
  if (v.version !== 1) return `unsupported version ${JSON.stringify(v.version)}`;
  if (!isDecimal(v.next_binding_generation)) return 'next_binding_generation is malformed';
  if (!Array.isArray(v.captures) || !Array.isArray(v.bindings)) return 'captures or bindings is not a list';
  for (const [i, c] of v.captures.entries()) {
    const problem = captureProblem(c, i);
    if (problem) return problem;
  }
  for (const [i, b] of v.bindings.entries()) {
    const problem = bindingProblem(b, i);
    if (problem) return problem;
  }
  return null;
}
