import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES } from './event.ts';

export interface SessionInfo { id: string; durableSeq: bigint; removed: boolean }
export interface Tombstone { version: number }
export interface RuntimeDescriptor { url: string; token: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));

export function isValidSessionId(id: string): boolean { return UUID_RE.test(id); }
export function isValidHex(hex: string): boolean { return HEX_RE.test(hex); }

export function sessionsDir(storeDir: string): string { return join(storeDir, 'sessions'); }
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
  let text: string;
  try { text = await readFile(logPath, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
    throw err;
  }
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return 0n;
  const complete = text.slice(0, lastNl);
  const nl = complete.lastIndexOf('\n');
  const lastLine = complete.slice(nl + 1);
  if (!lastLine) return 0n;
  const seq = (JSON.parse(lastLine) as { seq?: string }).seq;
  return seq ? BigInt(seq) : 0n;
}

export async function readTombstone(storeDir: string, id: string): Promise<Tombstone | null> {
  try {
    const raw = await readFile(tombstonePath(storeDir, id), 'utf8');
    const parsed = JSON.parse(raw) as Tombstone;
    return parsed;
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
    const durableSeq = await onDiskHighWater(sessionLogPath(storeDir, id));
    out.push({ id, durableSeq, removed });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export async function schemaBytes(type: string): Promise<Buffer | null> {
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return null;
  return readFile(join(SCHEMAS_DIR, `${type}.json`));
}

export async function readRuntimeDescriptor(storeDir: string): Promise<RuntimeDescriptor | null> {
  const dir = join(storeDir, 'runtime');
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (files.length === 0) return null;
  let newest = files[0]!; let newestMs = -1;
  for (const f of files) {
    const s = await stat(join(dir, f));
    if (s.mtimeMs > newestMs) { newestMs = s.mtimeMs; newest = f; }
  }
  return JSON.parse(await readFile(join(dir, newest), 'utf8')) as RuntimeDescriptor;
}
