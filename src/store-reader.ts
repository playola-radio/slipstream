import { constants } from 'node:fs';
import { readdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_EVENT_TYPES as EVENT_TYPES } from './public-events.ts';
import { LogCorruptError } from './log-reader.ts';

export interface SessionInfo { id: string; durableSeq: bigint; removed: boolean }
export interface Tombstone { version: number }
export interface RuntimeDescriptor { url: string; token: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const SEQ_RE = /^[1-9][0-9]*$/;
const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
const PROJECTIONS_DIR = fileURLToPath(new URL('../schemas/projections/', import.meta.url));
const INTERFACE_SCHEMA = fileURLToPath(new URL('../contracts/interface/v2/schema.json', import.meta.url));

/** The published projection schemas, by projection_version. Not gated to
 *  EVENT_TYPES: a projection is a reader-derived view, not a log event. */
const PROJECTION_SCHEMAS = new Set<string>(['clip.v1', 'clip.v2', 'clip.v3']);

export function isValidSessionId(id: string): boolean { return UUID_RE.test(id); }
export function isValidHex(hex: string): boolean { return HEX_RE.test(hex); }

function sessionsDir(storeDir: string): string { return join(storeDir, 'sessions'); }
export function sessionLogPath(storeDir: string, id: string): string {
  return join(sessionsDir(storeDir), id, 'events.jsonl');
}
export function tombstonePath(storeDir: string, id: string): string {
  return join(sessionsDir(storeDir), id, 'removed.json');
}
export function blobPath(storeDir: string, hex: string): string {
  return join(storeDir, 'blobs', 'sha256', hex.slice(0, 2), hex);
}

export async function onDiskHighWater(logPath: string): Promise<bigint> {
  let handle;
  try { handle = await open(logPath, 'r'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
    throw err;
  }
  let lastLine: string;
  try {
    // Scan backwards in fixed-size windows, discarding a torn tail without
    // retaining it. Only the final complete record needs to be assembled.
    let pos = (await handle.stat()).size;
    let foundEnd = false;
    const pieces: Buffer[] = [];
    while (pos > 0) {
      const size = Math.min(pos, 64 * 1024);
      pos -= size;
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, pos);
      if (bytesRead !== size) throw new LogCorruptError('high-water: log truncated during read');
      let end = size;
      if (!foundEnd) {
        end = buffer.lastIndexOf(0x0a);
        if (end < 0) continue;
        foundEnd = true;
      }
      const start = end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1;
      pieces.push(buffer.subarray(start + 1, end));
      if (start >= 0) break;
    }
    if (!foundEnd) return 0n;
    lastLine = Buffer.concat(pieces.reverse()).toString('utf8');
  } finally { await handle.close(); }
  if (lastLine === '') throw new LogCorruptError('high-water: blank final record');
  let seq: unknown;
  try { seq = (JSON.parse(lastLine) as { seq?: unknown }).seq; }
  catch { throw new LogCorruptError('high-water: invalid JSON in final record'); }
  if (typeof seq !== 'string' || !SEQ_RE.test(seq)) {
    throw new LogCorruptError('high-water: final record has no valid decimal-string seq');
  }
  return BigInt(seq);
}

export async function readTombstone(storeDir: string, id: string): Promise<Tombstone | null> {
  try {
    const raw = await readFile(tombstonePath(storeDir, id), 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && (parsed as Tombstone).version === 1 ? { version: 1 } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listSessions(storeDir: string): Promise<SessionInfo[]> {
  let entries: string[];
  try { entries = await readdir(sessionsDir(storeDir)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SessionInfo[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const removed = (await readTombstone(storeDir, id)) !== null;
    // A removed session advertises no history. Short-circuit to 0 without reading
    // high-water: a delete interrupted before cleanup can leave a corrupt residual
    // log under a durable tombstone, and that must never break listing.
    const durableSeq = removed ? 0n : await onDiskHighWater(sessionLogPath(storeDir, id));
    out.push({ id, durableSeq, removed });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export async function schemaBytes(type: string): Promise<Buffer | null> {
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return null;
  return readFile(join(SCHEMAS_DIR, `${type}.json`));
}

export async function projectionSchemaBytes(version: string): Promise<Buffer | null> {
  if (version === 'interface.v2') return readFile(INTERFACE_SCHEMA);
  if (!PROJECTION_SCHEMAS.has(version)) return null;
  return readFile(join(PROJECTIONS_DIR, `${version}.json`));
}

export async function readRuntimeDescriptor(storeDir: string): Promise<RuntimeDescriptor | null> {
  const dir = join(storeDir, 'runtime');
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let newest: RuntimeDescriptor | null = null;
  let newestMs = -1;
  for (const f of files) {
    // Validate the same fd we read; never follow symlinks or block on a FIFO.
    let handle;
    try {
      handle = await open(join(dir, f), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) continue;
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const { url, token } = parsed as Record<string, unknown>;
      if (typeof url !== 'string' || typeof token !== 'string') continue;
      const origin = new URL(url);
      if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) continue;
      if (info.mtimeMs > newestMs) { newestMs = info.mtimeMs; newest = { url, token }; }
    } catch {
      // A stale, inaccessible or malformed candidate must not hide a usable one.
    } finally { await handle?.close(); }
  }
  return newest;
}
