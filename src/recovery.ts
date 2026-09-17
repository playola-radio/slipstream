import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Cas } from './cas.ts';
import { EVENT_TYPES, sourceFor, type AnyEvent, type EventType } from './event.ts';
import { loadAllSchemas, validate, type JsonSchema } from './schema.ts';
import { snapshotsEqual, type Snapshot } from './snapshot.ts';

/**
 * A mid-log defect that cannot be honestly repaired. Only bytes after the final
 * newline are ever removable (an interrupted append); any *terminated* record
 * that fails to validate means the durable history is untrustworthy, so we stop
 * hard rather than skip an event and silently lie about what was captured.
 */
export class CorruptLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptLogError';
  }
}

export interface RecoveredSession {
  /** Canonical worktree from `session.started`; undefined if the log had no records. */
  root: string | undefined;
  maxBytes: number | undefined;
  recoveredThroughSeq: bigint;
  discardedTailBytes: number;
  /** Last committed snapshot per path (baseline + changes replayed in order). Its
   * keys are every path ever observed, for restart reconciliation. */
  committed: Map<string, Snapshot>;
  /** Directories whose prior coverage is unknown (failed baseline scans, or the
   * whole root when baseline enumeration never completed before a crash). */
  baselineUnknownDirs: Set<string>;
  /** Seq of the disclosing gap for each recovered storage outage episode, so a
   * retried recovery reuses the surviving gap instead of appending a duplicate. */
  storageGapSeqByEpisode: Map<string, string>;
}

/** The envelope constraints every record must satisfy, regardless of type — so an
 * unknown event type cannot smuggle a malformed envelope past validation. */
const ENVELOPE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['specversion', 'id', 'source', 'type', 'datacontenttype', 'seq', 'time'],
  properties: {
    specversion: { const: '1.0' },
    datacontenttype: { const: 'application/json' },
    id: { type: 'string', pattern: '^[1-9][0-9]*$' },
    source: { type: 'string', pattern: '^urn:slipstream:session:' },
    type: { type: 'string' },
    seq: { type: 'string', pattern: '^[1-9][0-9]*$' },
    time: { type: 'string', format: 'date-time' },
  },
};

/** A captured path is relative to the worktree root and never escapes it. A log
 * whose path escapes (absolute, or with a `..` segment) is corrupt — reconciling
 * it would read outside the watched tree. */
function assertSafePath(path: string, at: string): void {
  if (path === '' || isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new CorruptLogError(`${at}: unsafe path ${JSON.stringify(path)}`);
  }
}

/** Like {@link assertSafePath} but for a directory scope, where the empty string
 * legitimately names the worktree root (a failed root enumeration emits a
 * `baseline-unreadable` gap whose `relative(root, root)` scope path is ""). */
function assertSafeDir(path: string, at: string): void {
  if (isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new CorruptLogError(`${at}: unsafe path ${JSON.stringify(path)}`);
  }
}

/**
 * Validate and replay an existing session log. Throws CorruptLogError on any
 * mid-log defect; truncates only an unterminated trailing suffix. Never uses the
 * lenient test reader — every terminated line must parse and validate here.
 */
export async function recoverSession(
  logPath: string,
  expectedSessionId: string,
  cas: Cas,
): Promise<RecoveredSession> {
  const raw = await readFile(logPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  });

  const lastLf = raw.lastIndexOf(0x0a);
  const keptLen = lastLf + 1; // bytes through the final newline (0 if none)
  const discardedTailBytes = raw.length - keptLen;
  const terminated = raw.subarray(0, keptLen);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(terminated);
  } catch {
    throw new CorruptLogError('log contains invalid UTF-8 before its final newline');
  }

  const schemas = await loadAllSchemas();
  const expectedSource = sourceFor(expectedSessionId);

  const committed = new Map<string, Snapshot>();
  const baselineUnknownDirs = new Set<string>();
  const storageGapSeqByEpisode = new Map<string, string>();
  const verifiedBlobs = new Map<string, number>(); // sha256 -> verified byte length

  let root: string | undefined;
  let maxBytes: number | undefined;
  let baselineCompleted = false;
  let seq = 0n;

  const verifyBlob = async (snap: Snapshot, where: string): Promise<void> => {
    if (snap.kind !== 'content') return;
    const cached = verifiedBlobs.get(snap.sha256);
    if (cached !== undefined) {
      if (cached !== snap.size) {
        throw new CorruptLogError(`${where}: blob ${snap.sha256} size ${snap.size} != verified ${cached}`);
      }
      return; // hash the bytes once, but re-check each reference's declared size
    }
    let bytes: Buffer;
    try {
      bytes = await cas.read(snap.sha256);
    } catch {
      throw new CorruptLogError(`${where}: referenced blob ${snap.sha256} is missing`);
    }
    if (bytes.length !== snap.size) {
      throw new CorruptLogError(`${where}: blob ${snap.sha256} size ${bytes.length} != ${snap.size}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== snap.sha256) {
      throw new CorruptLogError(`${where}: blob content does not hash to ${snap.sha256}`);
    }
    await cas.ensureDurable(snap.sha256); // durability barrier before reuse (Q5)
    verifiedBlobs.set(snap.sha256, bytes.length);
  };

  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = `record ${i + 1}`;
    if (line.length === 0) throw new CorruptLogError(`${at}: blank terminated line`);

    let event: AnyEvent;
    try {
      event = JSON.parse(line) as AnyEvent;
    } catch {
      throw new CorruptLogError(`${at}: invalid JSON`);
    }

    const envelopeErrors = validate(ENVELOPE_SCHEMA, event);
    if (envelopeErrors.length > 0) {
      throw new CorruptLogError(`${at}: envelope invalid: ${envelopeErrors[0]}`);
    }

    seq += 1n;
    const expectedSeq = seq.toString();
    if (event.seq !== expectedSeq) {
      throw new CorruptLogError(`${at}: seq ${event.seq} != expected ${expectedSeq}`);
    }
    if (event.id !== expectedSeq) {
      throw new CorruptLogError(`${at}: id ${event.id} != seq ${expectedSeq}`);
    }
    if (event.source !== expectedSource) {
      throw new CorruptLogError(`${at}: source ${event.source} != ${expectedSource}`);
    }
    if (event.data?.session_id !== expectedSessionId) {
      throw new CorruptLogError(`${at}: session_id disagrees with session directory`);
    }

    // The first record binds identity and worktree; enforce it before any
    // forward-compat skip so an unknown type cannot stand in for session.started.
    if (i === 0 && event.type !== 'slipstream.session.started.v1') {
      throw new CorruptLogError(`${at}: first record must be session.started, got ${event.type}`);
    }

    if (!EVENT_TYPES.includes(event.type as EventType)) {
      continue; // forward-compat: unknown type, seq still advanced
    }
    const schema = schemas.get(event.type) as JsonSchema;
    const errors = validate(schema, event);
    if (errors.length > 0) {
      throw new CorruptLogError(`${at}: ${event.type} fails schema: ${errors[0]}`);
    }

    switch (event.type) {
      case 'slipstream.session.started.v1': {
        if (i !== 0) throw new CorruptLogError(`${at}: duplicate session.started`);
        root = event.data.root;
        maxBytes = event.data.max_bytes;
        break;
      }
      case 'slipstream.file.baselined.v1': {
        assertSafePath(event.data.path, at);
        await verifyBlob(event.data.snapshot, at);
        committed.set(event.data.path, event.data.snapshot);
        break;
      }
      case 'slipstream.capture.baseline.completed.v1': {
        for (const dir of event.data.unknown_scopes) {
          assertSafeDir(dir, at);
          baselineUnknownDirs.add(dir);
        }
        baselineCompleted = true;
        break;
      }
      case 'slipstream.file.changed.v1': {
        assertSafePath(event.data.path, at);
        await verifyBlob(event.data.before, `${at} before`);
        await verifyBlob(event.data.after, `${at} after`);
        const prior = committed.get(event.data.path);
        if (prior !== undefined && !snapshotsEqual(prior, event.data.before)) {
          throw new CorruptLogError(`${at}: before contradicts replayed state for ${event.data.path}`);
        }
        committed.set(event.data.path, event.data.after);
        break;
      }
      case 'slipstream.capture.gap.v1': {
        if (event.data.reason === 'baseline-unreadable' && 'path' in event.data.scope) {
          assertSafeDir(event.data.scope.path, at);
          baselineUnknownDirs.add(event.data.scope.path);
        }
        if (event.data.reason === 'storage' && event.data.episode_id !== undefined) {
          storageGapSeqByEpisode.set(event.data.episode_id, event.seq);
        }
        break;
      }
      case 'slipstream.session.resumed.v1':
        break;
    }
  }

  // A crash before `baseline.completed` means the initial scan never finished:
  // every path we did not baseline is of genuinely unknown prior state, so the
  // whole root is baseline-unknown. Without this, restart reconciliation would
  // fabricate `absent -> content` for pre-existing files it simply never saw.
  if (root !== undefined && !baselineCompleted) {
    baselineUnknownDirs.add('');
  }

  if (discardedTailBytes > 0) {
    const handle = await open(logPath, 'r+');
    try {
      await handle.truncate(keptLen);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return {
    root,
    maxBytes,
    recoveredThroughSeq: seq,
    discardedTailBytes,
    committed,
    baselineUnknownDirs,
    storageGapSeqByEpisode,
  };
}
