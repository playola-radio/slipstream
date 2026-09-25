import { isAbsolute } from 'node:path';
import type { ControlErrorCode } from './control-protocol.ts';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openLogCursor } from './log-reader.ts';
import { blobPath } from './store-reader.ts';
import { sourceFor } from './event.ts';
import type { QuestionQueuedEvent } from './public-events.ts';
export const QUESTION_TTL_MS = 1_800_000;
export const QUESTION_LIMIT = 16;
export const MAX_SOURCE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface QuestionContext {
  change_seq: string;
  path: string;
  snapshot_sha256: string;
  line_start: number;
  line_end: number;
}
export interface QuestionRequest {
  session_id: string;
  request_id: string;
  text: string;
  context: QuestionContext;
}
export class QuestionError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'QuestionError';
  }
}
function invalidContext(message: string): never { throw new QuestionError('INVALID_CONTEXT', message); }
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validRange(start: unknown, end: unknown): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && (start as number) >= 1 && (end as number) >= (start as number) && (end as number) - (start as number) < 200;
}

/** Copy only contract fields: caller mutation and unknown fields cannot retarget a request. */
export function normalizeAsk(value: unknown): QuestionRequest {
  const req = record(value);
  if (typeof req.session_id !== 'string' || !UUID.test(req.session_id)
    || typeof req.request_id !== 'string' || !UUID.test(req.request_id)) {
    throw new QuestionError('PROTOCOL', 'ask requires canonical lowercase session_id and request_id UUIDs');
  }
  if (typeof req.text !== 'string') throw new QuestionError('INVALID_QUESTION', 'question text is required');
  const text = req.text.trim();
  if (Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > 8192) {
    throw new QuestionError('INVALID_QUESTION', 'question must contain 1–8192 UTF-8 bytes after trimming');
  }
  const ctx = record(req.context);
  if (typeof ctx.change_seq !== 'string' || !/^[1-9][0-9]*$/.test(ctx.change_seq)) invalidContext('change_seq must be a canonical positive decimal string');
  if (typeof ctx.path !== 'string' || Buffer.byteLength(ctx.path) < 1 || Buffer.byteLength(ctx.path) > 4096
    || ctx.path.includes('\0') || isAbsolute(ctx.path) || /(^|[\\/])\.\.([\\/]|$)/.test(ctx.path)) invalidContext('context path must be a relative source path of at most 4096 UTF-8 bytes');
  if (typeof ctx.snapshot_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ctx.snapshot_sha256)) invalidContext('snapshot_sha256 must be a lowercase SHA-256');
  if (!validRange(ctx.line_start, ctx.line_end)) invalidContext('select 1–200 source lines using inclusive positive integer bounds');
  return { session_id: req.session_id, request_id: req.request_id, text, context: {
    change_seq: ctx.change_seq, path: ctx.path, snapshot_sha256: ctx.snapshot_sha256,
    line_start: ctx.line_start as number, line_end: ctx.line_end as number,
  } };
}

/** Fixed-order normalized request body; identity excludes derived text and target. */
export function questionBody(req: Pick<QuestionRequest, 'text' | 'context'>): string {
  const c = req.context;
  return JSON.stringify([req.text, c.change_seq, c.path, c.snapshot_sha256, c.line_start, c.line_end]);
}

export function selectSource(bytes: Buffer, range: Pick<QuestionContext, 'line_start' | 'line_end'>): string {
  if (bytes.length > MAX_SOURCE_BYTES || bytes.includes(0)) invalidContext('source is oversized or contains NUL');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalidContext('source is not valid UTF-8'); }
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (!validRange(range.line_start, range.line_end) || range.line_end > lines.length) invalidContext('line range does not exist in the recorded snapshot');
  const selected = lines.slice(range.line_start - 1, range.line_end).join('\n');
  if (Buffer.byteLength(selected) > 16384) invalidContext('selected source exceeds 16384 UTF-8 bytes');
  return selected;
}


export interface QuestionSourceInput {
  storeDir: string;
  logPath: string;
  sessionId: string;
  boundary: bigint;
  context: QuestionContext;
}

/** Finite committed-log lookup and an actually bounded CAS read. Never reads the worktree. */
export async function readQuestionContext(input: QuestionSourceInput): Promise<string> {
  const { context, sessionId } = input;
  const seq = BigInt(context.change_seq);
  if (seq > input.boundary) invalidContext('change is not in the durable prefix');
  let snapshot: { kind?: string; sha256?: string; size?: number };
  try {
    const cursor = await openLogCursor(input.logPath, seq - 1n);
    try {
      const events = await cursor.readThrough(seq);
      const event = events[0];
      if (!event) throw new QuestionError('STORAGE_UNAVAILABLE', 'durable source record is missing');
      const envelope = JSON.parse(event.raw) as { source: string; id: string };
      if (event.type !== 'slipstream.file.changed.v1' || event.seq !== seq
        || event.data.session_id !== sessionId || envelope.source !== sourceFor(sessionId)
        || envelope.id !== context.change_seq || event.data.path !== context.path) invalidContext('context does not identify a change in this capture');
      snapshot = (event.data.after ?? {}) as typeof snapshot;
      if (snapshot.kind !== 'content' || snapshot.sha256 !== context.snapshot_sha256) invalidContext('context does not identify available after-content');
      if (typeof snapshot.size !== 'number' || snapshot.size > MAX_SOURCE_BYTES) invalidContext('source snapshot exceeds 1 MiB');
    } finally { await cursor.close(); }
  } catch (err) {
    if (err instanceof QuestionError) throw err;
    throw new QuestionError('STORAGE_UNAVAILABLE', 'cannot read the durable source log');
  }
  let bytes: Buffer;
  try {
    const handle = await open(blobPath(input.storeDir, context.snapshot_sha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('not a regular blob');
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_SOURCE_BYTES) invalidContext('source blob exceeds 1 MiB');
      bytes = buffer.subarray(0, total);
    } finally { await handle.close(); }
  } catch (err) {
    if (err instanceof QuestionError) throw err;
    throw new QuestionError('STORAGE_UNAVAILABLE', 'recorded source blob is unavailable');
  }
  if (bytes.length !== snapshot.size || createHash('sha256').update(bytes).digest('hex') !== context.snapshot_sha256) {
    throw new QuestionError('STORAGE_UNAVAILABLE', 'recorded source blob does not match its content hash');
  }
  return selectSource(bytes, context);
}

export interface QuestionAccepted {
  session_id: string;
  request_id: string;
  question_id: string;
  seq: string;
  queued_at_ms: number;
  expires_at_ms: number;
  duplicate: boolean;
}
export function questionResult(event: QuestionQueuedEvent): QuestionAccepted {
  const d = event.data;
  return Object.freeze({ session_id: d.session_id, request_id: d.request_id, question_id: d.question_id,
    seq: event.seq, queued_at_ms: d.queued_at_ms, expires_at_ms: d.expires_at_ms, duplicate: false });
}
