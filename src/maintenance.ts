import { access, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { FILE_MODE, StorageError, fsyncDir, writeAll } from './storage.ts';
import {
  blobPath, isValidHex, listSessions, onDiskHighWater, sessionLogPath, tombstonePath,
} from './store-reader.ts';
import { openLogCursor, LogCorruptError } from './log-reader.ts';
import { PUBLIC_EVENT_TYPES as EVENT_TYPES } from './public-events.ts';

/**
 * Store maintenance for detached-only session deletion + GC (Stage 3, P5).
 *
 * Deletion is durable-tombstone-first: {@link publishTombstone} makes
 * `removed.json` durable BEFORE {@link removeSessionHistory} removes the log, so
 * a crash between the two leaves a durable tombstone the reader already 410s and
 * a residual log GC finishes later. Nothing here touches the ACTIVE session or
 * decides retention policy — the daemon gates admission (detached-only) and the
 * caller supplies the session ids.
 *
 * Blob reclamation ({@link reclaimUnreferencedBlobs}) is a conservative,
 * whole-store mark-and-sweep over the GLOBAL content-addressed store. Blobs are
 * shared across sessions, so the live set is every hash referenced by every
 * NON-removed session's durable log; anything else is swept. The mark phase is
 * all-or-nothing: a missing, corrupt, or uninterpretable retained log aborts the
 * whole sweep (deletes nothing) rather than risk deleting a live blob.
 */

const TOMBSTONE_BODY = Buffer.from('{"version":1}\n', 'utf8');
const HISTORY_FILES = ['events.jsonl'] as const;
const SHARD_RE = /^[0-9a-f]{2}$/;
const KNOWN_EVENT_TYPES = new Set<string>(EVENT_TYPES);

function sessionDir(storeDir: string, id: string): string {
  return dirname(tombstonePath(storeDir, id));
}

/** blobs/sha256 — the CAS root, derived from store-reader's blobPath so the
 * layout lives in one place (blobPath gives `.../sha256/<ab>/<hex>`). */
function blobBaseDir(storeDir: string): string {
  return dirname(dirname(blobPath(storeDir, '0'.repeat(64))));
}

/** Predicate signalling that in-progress destructive work must stop (e.g. the
 * daemon lost its store lock and a successor may now own the shared blobs).
 * Returns true once the sweep must abort without deleting anything further. */
export type SweepAbort = () => boolean;

/**
 * Durably publish `sessions/<id>/removed.json = {"version":1}`: unique temp,
 * `wx`/0600, write, fsync file, atomic rename over any prior marker, fsync the
 * session dir. Idempotent — republishing is safe and required, because an
 * existing marker does not prove the earlier dir-fsync completed.
 */
export async function publishTombstone(storeDir: string, id: string): Promise<void> {
  const dest = tombstonePath(storeDir, id);
  const dir = dirname(dest);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  let handle;
  try {
    try {
      handle = await open(tmp, 'wx', FILE_MODE);
      await writeAll(handle, TOMBSTONE_BODY);
      await handle.sync();
    } catch (err) {
      throw new StorageError('write-tombstone', err);
    } finally {
      await handle?.close();
    }
    try {
      await rename(tmp, dest);
    } catch (err) {
      throw new StorageError('rename-tombstone', err);
    }
    await fsyncDir(dir);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Remove a removed session's history by an EXPLICIT inventory (never a recursive
 * dir removal), preserving `removed.json` and the session dir so the reader still
 * lists `{removed:true}` and 410s. fsync the dir so the removal is durable.
 */
export async function removeSessionHistory(storeDir: string, id: string): Promise<void> {
  const dir = sessionDir(storeDir, id);
  let removedAny = false;
  for (const name of HISTORY_FILES) {
    try {
      await unlink(join(dir, name));
      removedAny = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageError('remove-history', err);
    }
  }
  if (removedAny) await fsyncDir(dir);
}

/** Whether `sessions/<id>/` exists. A well-formed id naming no dir is a deletion
 * target the caller reports as not-found rather than manufacturing a tombstone. */
export async function sessionExists(storeDir: string, id: string): Promise<boolean> {
  try {
    await access(sessionDir(storeDir, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new StorageError('stat-session', err);
  }
}

/**
 * Mark-and-sweep the global CAS: delete every blob NOT referenced by any
 * non-removed session's durable log. Returns the number of blobs unlinked.
 * Throws (deleting nothing further) if the mark phase cannot be completed
 * safely, or if the {@link SweepAbort} predicate trips before an unlink.
 */
export async function reclaimUnreferencedBlobs(storeDir: string, abort: SweepAbort): Promise<number> {
  const live = new Set<string>();
  for (const s of await listSessions(storeDir)) {
    if (s.removed) continue;
    await collectBlobRefs(storeDir, s.id, live); // throws on any unsafe condition
  }
  return sweepBlobs(storeDir, live, abort);
}

/**
 * Add every blob hash one non-removed session's durable log references to `live`.
 * Reads the whole log up to its durable high-water. Throws — never returns a
 * partial set — if the log is missing, corrupt, carries an event type this
 * version cannot interpret, or holds a content snapshot without a valid sha256.
 */
async function collectBlobRefs(storeDir: string, id: string, live: Set<string>): Promise<void> {
  const logPath = sessionLogPath(storeDir, id);
  const boundary = await onDiskHighWater(logPath); // throws LogCorruptError on a bad tail
  let cursor;
  try {
    cursor = await openLogCursor(logPath, 0n);
  } catch (err) {
    // A non-removed session must have a readable log; a missing one is unsafe to
    // treat as an empty reference set (onDiskHighWater returns 0n for BOTH a
    // missing and an empty log, so distinguish them here).
    throw new StorageError('gc-mark-open', err);
  }
  try {
    // Validate every complete record through the log's PHYSICAL end — never stop at
    // the final record's declared seq. `readThrough(boundary + 1n)` keeps consuming
    // past the high-water, so a log whose tail rewinds below an interior seq (e.g.
    // 1, 2, 1) is caught by the cursor's contiguity check or the reached-seq
    // assertion below, rather than silently skipping the records after the boundary.
    let seq = 0n;
    for (;;) {
      const batch = await cursor.readThrough(boundary + 1n); // throws on non-contiguous seq
      if (!batch.length) break; // physical EOF (or a torn, uncommitted tail)
      for (const ev of batch) {
        addRefsFromEvent(ev.type, ev.data, live);
        seq = ev.seq;
      }
    }
    if (seq !== boundary) {
      // The last complete record read is not the durable high-water: the log is
      // short of, or runs past, its own final seq — corruption. Delete nothing.
      throw new LogCorruptError(`gc-mark: read to seq ${seq}, not durable high-water ${boundary}`);
    }
  } finally {
    await cursor.close();
  }
}

function addRefsFromEvent(type: string, data: Record<string, unknown>, live: Set<string>): void {
  if (!KNOWN_EVENT_TYPES.has(type)) {
    // A newer/unknown type may reference blobs through a mechanism this version
    // does not know. Refuse to sweep rather than risk deleting a live blob.
    throw new LogCorruptError(`gc-mark: unknown event type ${type}; refusing to sweep`);
  }
  // A blob reference is exactly a canonical content snapshot ({kind:'content',
  // sha256}). Collect them wherever they appear in the event's data — not just the
  // fields this version happens to hard-code — so an additive blob-bearing field on
  // an existing type is still marked, never orphaned and swept. Any other shape
  // carries no blob and is ignored.
  addRefsFromValue(data, live);
}

function addRefsFromValue(value: unknown, live: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) addRefsFromValue(item, live);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.kind === 'content' || 'sha256' in record) {
    // Anything shaped like a blob reference — a content snapshot, or any object
    // carrying a sha256 — must be a fully valid content snapshot. A partial or
    // malformed one (a sha256 without kind:'content', or a bad hex) is corruption
    // this version cannot interpret: fail closed rather than silently drop the
    // reference and sweep a blob it may protect.
    const sha = record.sha256;
    if (record.kind !== 'content' || typeof sha !== 'string' || !isValidHex(sha)) {
      throw new LogCorruptError('gc-mark: malformed content snapshot');
    }
    live.add(sha);
  }
  for (const child of Object.values(record)) addRefsFromValue(child, live);
}

/** Delete validated CAS blobs not in `live`, fsyncing each changed shard. Only
 * well-formed, correctly-sharded hash files are ever unlinked — a stray or
 * misplaced file is left untouched. */
async function sweepBlobs(storeDir: string, live: Set<string>, abort: SweepAbort): Promise<number> {
  const base = blobBaseDir(storeDir);
  let shards: string[];
  try {
    shards = await readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new StorageError('gc-sweep-readdir', err);
  }
  let removed = 0;
  for (const shard of shards) {
    if (!SHARD_RE.test(shard)) continue; // not a CAS shard directory
    const shardDir = join(base, shard);
    let names: string[];
    try {
      names = await readdir(shardDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new StorageError('gc-sweep-readdir', err);
    }
    let removedHere = 0;
    for (const name of names) {
      if (!isValidHex(name) || name.slice(0, 2) !== shard) continue; // temp/stray/misplaced
      if (live.has(name)) continue;
      if (abort()) {
        throw new StorageError('gc-sweep-aborted', new Error('store ownership lost mid-sweep'));
      }
      try {
        await unlink(join(shardDir, name));
        removed++;
        removedHere++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new StorageError('gc-sweep-unlink', err);
      }
    }
    if (removedHere > 0) await fsyncDir(shardDir);
  }
  return removed;
}
