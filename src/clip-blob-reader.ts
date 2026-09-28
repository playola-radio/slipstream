/**
 * The I/O-scoped clip module: resolve a change's before/after snapshots to raw
 * blob bytes from the content-addressed store and run the pure
 * {@link projectClips} core. This is the reusable entry the TUI / any
 * independent client calls directly against on-disk artifacts, and the same
 * function the projection worker runs off the main thread. It reads RAW bytes
 * (not decoded text): the core owns UTF-8 validation and needs bytes for
 * byte-offset spans.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { blobPath, isValidHex } from './store-reader.ts';
import {
  projectClips,
  MAX_UTF8_BYTES,
  type ClipProjection,
  type ProjectOptions,
  type SideInput,
} from './clip-projection.ts';

export type ClipSnapshot =
  | { kind: 'content'; sha256: string; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string };

export interface ClipJob {
  storeDir: string;
  before: ClipSnapshot;
  after: ClipSnapshot;
  opts: ProjectOptions;
}

/** Parse an event snapshot (`data.before` / `data.after`) into a
 *  {@link ClipSnapshot}, or null if malformed. Mirrors change-view's parser. */
export function parseClipSnapshot(v: unknown): ClipSnapshot | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  if (s.kind === 'content') {
    if (typeof s.sha256 === 'string' && isValidHex(s.sha256)
      && typeof s.size === 'number' && Number.isInteger(s.size) && s.size >= 0) {
      return { kind: 'content', sha256: s.sha256, size: s.size };
    }
    return null;
  }
  if (s.kind === 'absent') return { kind: 'absent' };
  if (s.kind === 'unavailable' && typeof s.reason === 'string') {
    return { kind: 'unavailable', reason: s.reason };
  }
  return null;
}

/** Resolve one snapshot to a {@link SideInput}. A content blob larger than
 *  `maxBytes`, or one that under-reports its size, becomes `oversize`; a blob
 *  that cannot be opened/read (GC'd, missing, unreadable) becomes `missing` with
 *  an explicit reason — never faked content. */
export async function resolveClipSide(
  storeDir: string,
  snap: ClipSnapshot,
  maxBytes: number,
  onPhase?: (phase: string, durationNs: bigint) => void,
): Promise<SideInput> {
  const startedAtNs = onPhase ? process.hrtime.bigint() : undefined;
  let readOccurred = false;
  try {
    if (snap.kind === 'absent') return { kind: 'absent' };
    if (snap.kind === 'unavailable') return { kind: 'unavailable', reason: snap.reason };
    if (snap.size > maxBytes) return { kind: 'oversize' };
    if (!isValidHex(snap.sha256)) return { kind: 'missing', reason: 'invalid-hex' };
    // O_NOFOLLOW: a symlink planted at a valid CAS path must serve nothing but the
    // blob it names, never the link target's bytes.
    let handle;
    try {
      handle = await open(blobPath(storeDir, snap.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'open-failed' };
    }
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) return { kind: 'oversize' };
      const bytes = await handle.readFile();
      readOccurred = true;
      return { kind: 'bytes', bytes };
    } catch (err) {
      return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'read-failed' };
    } finally {
      await handle.close();
    }
  } finally {
    if (readOccurred && startedAtNs !== undefined) onPhase?.('cas-read', process.hrtime.bigint() - startedAtNs);
  }
}

/** Resolve both sides and run the pure projection. Successful spans are determined by
 *  bytes, language and version; timeouts/availability remain explicit transient
 *  outcomes. The caller decides where it runs (worker or directly). */
export async function computeClipProjection(job: ClipJob,
  onPhase?: (phase: string, durationNs: bigint) => void): Promise<ClipProjection> {
  const maxBytes = job.opts.maxBytes ?? MAX_UTF8_BYTES;
  const [before, after] = await Promise.all([
    resolveClipSide(job.storeDir, job.before, maxBytes, onPhase),
    resolveClipSide(job.storeDir, job.after, maxBytes, onPhase),
  ]);
  const language = job.opts.language ?? 'unsupported';
  if (language === 'unsupported' || (before.kind !== 'bytes' && after.kind !== 'bytes')) {
    return projectClips(before, after, job.opts,
      () => ({ functions: [], errors: [], reason: 'unsupported-language' }));
  }
  // Only supported-content computations load the parser. HTTP snapshot
  // validation and honest unsupported/unavailable results need no WASM startup.
  const loadStartedAtNs = onPhase ? process.hrtime.bigint() : undefined;
  const { createFunctionIndexer } = await import('./clip-function-parser.ts');
  const indexer = await createFunctionIndexer(language);
  if (loadStartedAtNs !== undefined) onPhase?.('grammar-load', process.hrtime.bigint() - loadStartedAtNs);
  const parseStartedAtNs = onPhase ? process.hrtime.bigint() : undefined;
  const result = projectClips(before, after, job.opts, indexer);
  if (parseStartedAtNs !== undefined) onPhase?.('parse-compare', process.hrtime.bigint() - parseStartedAtNs);
  return result;
}
