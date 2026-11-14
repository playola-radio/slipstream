import { dirname } from 'node:path';
import type { Cas } from './cas.ts';
import { acquireSessionLock } from './lock.ts';
import { createLog } from './log.ts';
import { recoverSession } from './recovery.ts';
import { finalRecord } from './store-reader.ts';

export interface CloseOutOptions {
  logPath: string;
  sessionId: string;
  cas: Cas;
  reason: 'detached' | 'archived';
  /** Throws if the caller no longer owns the store; checked before every append. */
  assertOwnership: () => void;
}

/**
 * Record the stop of a withdrawn capture whose last activation ended without one
 * (a daemon shutdown or crash; contracts.md §6). Nothing has written to the log
 * since, and the session lock proves nothing is writing now, so the stop is
 * appended at the current time, never backdated, behind a `capture.gap{restart}`
 * that discloses the unobserved time in between. A stop already in the log, once
 * recovery has made it durable, is kept rather than written twice. Returns the
 * final durable seq.
 */
export async function closeOutSession(opts: CloseOutOptions): Promise<bigint> {
  const { logPath, sessionId } = opts;
  let lost: string | undefined;
  const lock = await acquireSessionLock(dirname(logPath), { onCompromised: (reason) => { lost = reason; } });
  const owned = () => {
    if (lost !== undefined) throw new Error(`session ownership lost: ${lost}`);
    opts.assertOwnership();
  };
  // Every daemon capture is watch-only (see the session.resumed schema).
  const captureModeField = { capture_mode: 'watch-only' };
  try {
    const recovered = await recoverSession(logPath, sessionId, opts.cas);
    if (recovered.root === undefined) throw new Error(`session ${sessionId} has no session.started record`);
    // Recovery made the log durable, so an earlier attempt's stop now counts.
    if ((await finalRecord(logPath))?.type === 'slipstream.capture.stopped.v1') return recovered.recoveredThroughSeq;
    const log = await createLog({ filePath: logPath, sessionId, startSeq: recovered.recoveredThroughSeq });
    try {
      owned();
      await log.append({
        type: 'slipstream.session.resumed.v1',
        occurred_at_ms: Date.now(),
        data: {
          recovered_through_seq: recovered.recoveredThroughSeq.toString(),
          discarded_tail_bytes: recovered.discardedTailBytes,
          ...captureModeField,
        },
      });
      owned();
      await log.append({
        type: 'slipstream.capture.gap.v1',
        occurred_at_ms: Date.now(),
        data: { scope: { kind: 'session' }, reason: 'restart' },
      });
      owned();
      await log.append({ type: 'slipstream.capture.stopped.v1', occurred_at_ms: Date.now(), data: { reason: opts.reason } });
      return log.durableSeq();
    } finally {
      await log.close();
    }
  } finally {
    await lock.release();
  }
}
