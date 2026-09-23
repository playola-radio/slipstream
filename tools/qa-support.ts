/**
 * Shared support for the QA harness: the descriptor bootstrap the native client
 * uses, authenticated finite + SSE reader helpers, and the durability core — a
 * write-a-real-file-then-await-its-exact-public-observation helper that is the
 * whole proof each acceptance check rests on.
 *
 * Everything here consumes ONLY the public reader API and the runtime-descriptor
 * bootstrap. There is no privileged back channel to the daemon; a native client
 * could reach every fact this file reads.
 */
import { createHash } from 'node:crypto';
import { open, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { readRuntimeDescriptor, type RuntimeDescriptor } from '../src/store-reader.ts';
import type { Snapshot } from '../src/snapshot.ts';
import { FILE_MODE } from '../src/storage.ts';

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The current git HEAD of `cwd`, short form. Used to stamp reports/env so a
 * `--env` handoff can refuse a daemon built from a different revision. */
export function gitHead(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Descriptor bootstrap
// ---------------------------------------------------------------------------

/** Read the reader's runtime descriptor the same way the native client does:
 * from `<store>/runtime/*.json`, never from daemon internals. Retries briefly
 * because the descriptor is published as the reader comes up. */
export async function bootstrapReader(
  storeDir: string,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<RuntimeDescriptor> {
  const deadlineMs = opts.deadlineMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const descriptor = await readRuntimeDescriptor(storeDir);
    if (descriptor) return descriptor;
    if (Date.now() >= deadline) {
      throw new Error(`no reader descriptor published under ${join(storeDir, 'runtime')} within ${deadlineMs}ms`);
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Reader HTTP client (authenticated, loopback)
// ---------------------------------------------------------------------------

export interface SessionEntry { id: string; durable_seq: string; removed: boolean }
export interface FiniteEvents { events: AnyRecord[]; durableSeq: bigint }
/** A parsed log record. The reader is the public interface, so we read it
 * loosely (unknown fields ignored) rather than importing daemon event types. */
export type AnyRecord = { type?: string; seq?: string; data?: Record<string, unknown> } & Record<string, unknown>;

export interface RawResponse { status: number; headers: Headers; body: Buffer }

export interface ReaderClient {
  url: string;
  /** GET a path. With `auth: false`, omit the bearer token (used to prove 401). */
  raw(path: string, opts?: { auth?: boolean; signal?: AbortSignal }): Promise<RawResponse>;
  sessions(): Promise<SessionEntry[]>;
  finite(sessionId: string, after: bigint): Promise<FiniteEvents>;
  blob(sha256: string): Promise<Buffer>;
  /** Follow the SSE stream, invoking `onEvent` per frame until `signal` aborts
   * or the stream ends. Resolves when it stops. */
  follow(
    sessionId: string,
    after: bigint,
    signal: AbortSignal,
    onEvent: (frame: SseFrame) => void,
  ): Promise<void>;
}

export function createReaderClient(url: string, token: string): ReaderClient {
  const authHeaders = { authorization: `Bearer ${token}` } as const;

  async function raw(path: string, opts: { auth?: boolean; signal?: AbortSignal } = {}): Promise<RawResponse> {
    const res = await fetch(url + path, {
      headers: opts.auth === false ? {} : authHeaders,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  }

  async function sessions(): Promise<SessionEntry[]> {
    const r = await raw('/v1/sessions');
    if (r.status !== 200) throw new Error(`GET /v1/sessions → ${r.status}`);
    return JSON.parse(r.body.toString('utf8')) as SessionEntry[];
  }

  async function finite(sessionId: string, after: bigint): Promise<FiniteEvents> {
    const r = await raw(`/v1/sessions/${sessionId}/events?after=${after.toString()}`);
    if (r.status !== 200) throw new Error(`GET finite events → ${r.status}`);
    const durableHeader = r.headers.get('slipstream-durable-seq');
    if (durableHeader === null) throw new Error('finite events response missing slipstream-durable-seq header');
    return { events: parseNdjson(r.body.toString('utf8')), durableSeq: BigInt(durableHeader) };
  }

  async function blob(sha256: string): Promise<Buffer> {
    const r = await raw(`/v1/blobs/sha256/${sha256}`);
    if (r.status !== 200) throw new Error(`GET blob ${sha256} → ${r.status}`);
    return r.body;
  }

  async function follow(
    sessionId: string,
    after: bigint,
    signal: AbortSignal,
    onEvent: (frame: SseFrame) => void,
  ): Promise<void> {
    const res = await fetch(`${url}/v1/sessions/${sessionId}/events?follow=true&after=${after.toString()}`, {
      headers: { ...authHeaders, accept: 'text/event-stream' },
      signal,
    });
    if (res.status !== 200 || !res.body) throw new Error(`SSE follow → ${res.status}`);
    const decoder = createSseDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const frame of decoder.push(Buffer.from(chunk).toString('utf8'))) onEvent(frame);
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  return { url, raw, sessions, finite, blob, follow };
}

export function parseNdjson(text: string): AnyRecord[] {
  const out: AnyRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    out.push(JSON.parse(line) as AnyRecord);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE frame decoding
// ---------------------------------------------------------------------------

export interface SseFrame { id?: string; event?: string; data: string }

/** A minimal SSE decoder: accumulates lines until a blank line ends a frame.
 * Heartbeat comment lines (`:`-prefixed) are ignored. Frames with no `data`
 * (a lone `id`/`event`) are dropped — only data-carrying frames are surfaced. */
export function createSseDecoder(): { push(text: string): SseFrame[] } {
  let buffer = '';
  let cur: { id?: string; event?: string; data: string[] } = { data: [] };
  const frames: SseFrame[] = [];
  const flush = () => {
    if (cur.data.length > 0) {
      frames.push({ ...(cur.id !== undefined ? { id: cur.id } : {}), ...(cur.event !== undefined ? { event: cur.event } : {}), data: cur.data.join('\n') });
    }
    cur = { data: [] };
  };
  return {
    push(text: string): SseFrame[] {
      frames.length = 0;
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') { flush(); continue; }
        if (line.startsWith(':')) continue; // heartbeat/comment
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') cur.id = value;
        else if (field === 'event') cur.event = value;
        else if (field === 'data') cur.data.push(value);
      }
      return [...frames];
    },
  };
}

// ---------------------------------------------------------------------------
// Durability core — write a real file, await its exact public observation
// ---------------------------------------------------------------------------

export const FILE_CHANGED_TYPE = 'slipstream.file.changed.v1';
export const BASELINE_COMPLETED_TYPE = 'slipstream.capture.baseline.completed.v1';

/** What the caller expects a snapshot side to be. For a content state the caller
 * supplies the exact bytes it wrote, so the matcher can recompute the SHA-256 and
 * compare the served blob byte-for-byte. */
export type ExpectSnap =
  | { kind: 'absent' }
  | { kind: 'content'; bytes: Buffer };

export interface StateExpectation {
  /** Worktree-relative path (records store paths relative to the worktree root). */
  relPath: string;
  before: ExpectSnap;
  after: ExpectSnap;
}

export interface ObservedChange {
  seq: bigint;
  path: string;
  before: Snapshot;
  after: Snapshot;
  observation: string;
  /** The `slipstream-durable-seq` high-water of the response that carried it. */
  durableSeq: bigint;
}

/** True when an actual public snapshot matches the caller's expectation. Content
 * matches only on identical SHA-256 AND size — an intentionally wrong expected
 * hash therefore never matches (the negative control). */
export function snapshotMatches(actual: Snapshot, expect: ExpectSnap): boolean {
  if (expect.kind === 'absent') return actual.kind === 'absent';
  if (actual.kind !== 'content') return false;
  return actual.sha256 === sha256Hex(expect.bytes) && actual.size === expect.bytes.length;
}

export class DurabilityTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = 'DurabilityTimeoutError'; }
}

export interface PollOpts { deadlineMs?: number; pollMs?: number }

/** Poll finite `/events` from `after` until a record of `type` appears; return
 * its seq and the durable high-water. Throws {@link DurabilityTimeoutError} on
 * deadline — a state that never becomes durable is a real failure, never a pass. */
export async function awaitEventType(
  reader: ReaderClient,
  sessionId: string,
  type: string,
  after: bigint,
  opts: PollOpts = {},
): Promise<{ seq: bigint; durableSeq: bigint }> {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  let cursor = after;
  for (;;) {
    const { events, durableSeq } = await reader.finite(sessionId, cursor);
    for (const ev of events) {
      if (ev.type === type) return { seq: BigInt(ev.seq as string), durableSeq };
    }
    if (durableSeq > cursor) cursor = durableSeq;
    if (Date.now() >= deadline) {
      throw new DurabilityTimeoutError(`no ${type} record within ${deadlineMs}ms (durable high-water ${durableSeq})`);
    }
    await sleep(pollMs);
  }
}

/**
 * Await the exact public observation of one state.
 *
 * Matches session/path/observation and the expected before/after snapshot tags,
 * requires the record's seq to be within the response's durable high-water, and —
 * for every content side whose bytes the caller supplied — independently
 * recomputes the SHA-256 and fetches the served blob to compare exact bytes. A
 * rising high-water alone proves nothing; only this specific, byte-checked record
 * publishes "ready" for the state.
 */
export async function awaitObservedChange(
  reader: ReaderClient,
  sessionId: string,
  expect: StateExpectation,
  after: bigint,
  opts: PollOpts = {},
): Promise<ObservedChange> {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + deadlineMs;
  let cursor = after;
  for (;;) {
    const { events, durableSeq } = await reader.finite(sessionId, cursor);
    for (const ev of events) {
      if (ev.type !== FILE_CHANGED_TYPE) continue;
      const data = ev.data ?? {};
      if (data.path !== expect.relPath) continue;
      const before = data.before as Snapshot | undefined;
      const after2 = data.after as Snapshot | undefined;
      if (!before || !after2) continue;
      if (!snapshotMatches(before, expect.before) || !snapshotMatches(after2, expect.after)) continue;
      const seq = BigInt(ev.seq as string);
      if (seq > durableSeq) {
        throw new Error(`matched change seq ${seq} exceeds durable high-water ${durableSeq}`);
      }
      if (data.observation !== 'watcher') {
        throw new Error(`change ${seq} carried observation ${String(data.observation)}, expected watcher`);
      }
      await verifyBlobBytes(reader, before, expect.before);
      await verifyBlobBytes(reader, after2, expect.after);
      return { seq, path: expect.relPath, before, after: after2, observation: 'watcher', durableSeq };
    }
    if (durableSeq > cursor) cursor = durableSeq;
    if (Date.now() >= deadline) {
      throw new DurabilityTimeoutError(
        `no durable ${FILE_CHANGED_TYPE} matching ${expect.relPath} within ${deadlineMs}ms (durable high-water ${durableSeq})`,
      );
    }
    await sleep(pollMs);
  }
}

/** For a content snapshot whose expected bytes are known, fetch the served blob
 * and require exact byte equality; the SHA-256 identity was already checked by
 * {@link snapshotMatches}. Absent snapshots have no blob to verify. */
async function verifyBlobBytes(reader: ReaderClient, actual: Snapshot, expect: ExpectSnap): Promise<void> {
  if (expect.kind !== 'content' || actual.kind !== 'content') return;
  const bytes = await reader.blob(actual.sha256);
  if (!bytes.equals(expect.bytes)) {
    throw new Error(`blob ${actual.sha256} bytes (${bytes.length}) did not match the ${expect.bytes.length} bytes written`);
  }
}

// ---------------------------------------------------------------------------
// QA env bookkeeping file
// ---------------------------------------------------------------------------

export const QA_ENV_FORMAT = 'slipstream-qa.v1';
export const QA_ENV_NAME = 'qa-env.json';

export interface QaEnv {
  format: typeof QA_ENV_FORMAT;
  state: 'ready' | 'stopped';
  run_id: string;
  daemon_commit: string;
  store: string;
  worktree: string;
  descriptor_path: string;
  url: string;
  token: string;
  session_id: string;
  ready_through_seq: string;
  scenario: string | null;
}

/** Atomically write the owner-only (0600) QA env bookkeeping file. */
export async function writeQaEnv(path: string, env: QaEnv): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, 'w', FILE_MODE);
  try {
    await handle.writeFile(Buffer.from(JSON.stringify(env, null, 2), 'utf8'));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export async function readQaEnv(path: string): Promise<QaEnv> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as QaEnv;
  if (parsed.format !== QA_ENV_FORMAT) {
    throw new Error(`${path} is not a ${QA_ENV_FORMAT} env file`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Report shape (shared with projection-check)
// ---------------------------------------------------------------------------

export const QA_REPORT_FORMAT = 'slipstream-qa-report.v1';

export interface Assertion { id: string; claim: string; evidence: unknown }
export interface CheckResult { id: string; result: 'passed' | 'failed'; assertions: Assertion[]; error?: string }
export interface QaReport {
  format: typeof QA_REPORT_FORMAT;
  commit: string;
  result: 'passed' | 'failed';
  checks: CheckResult[];
}

export function buildReport(commit: string, checks: CheckResult[]): QaReport {
  const result = checks.every((c) => c.result === 'passed') ? 'passed' : 'failed';
  return { format: QA_REPORT_FORMAT, commit, result, checks };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
