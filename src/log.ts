import { open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildPublicEnvelope as buildEnvelope, type PublicEvent as AnyEvent, type PublicEventInput as EventInput } from './public-events.ts';
import { FILE_MODE, StorageError, fsyncDir, writeAll } from './storage.ts';

export interface Log {
  /**
   * Assign the next contiguous seq, build the CloudEvents envelope, append it,
   * fsync the log, and only then resolve. Referenced blobs must already be
   * durably published (the caller's responsibility). Returns the written event.
   */
  append(input: EventInput): Promise<AnyEvent>;
  /** Highest seq whose record is durably on disk (0n before the first append). */
  durableSeq(): bigint;
  close(): Promise<void>;
}

/**
 * A hook the log invokes inside its serialized sequencing section — the one
 * place with a total order over appends — so that ordering-dependent fields stay
 * consistent with the assigned seq. `enrich` runs before the envelope is built
 * (to stamp fields such as a change's `task_hint_id`); `onCommitted` runs after
 * the record is durably written and before the next append is processed (to
 * advance state such as the current task). The log stays generic: it knows
 * nothing about tasks, only that a caller may observe and augment appends in
 * order.
 */
export interface AppendSequencer {
  enrich(input: EventInput): EventInput;
  onCommitted(event: AnyEvent): void;
}

export interface CreateLogOptions {
  filePath: string;
  sessionId: string;
  /** Last durable seq recovered from an existing log; the first append is startSeq+1. */
  startSeq?: bigint;
  /** Optional in-order hook for ordering-dependent enrichment (e.g. task grouping). */
  sequencer?: AppendSequencer;
}

/**
 * The single writer for a session's `events.jsonl`. Appends are serialized onto
 * a tail promise so seq assignment and byte order never interleave. Each append
 * is durable before it is acknowledged: writeAll then fsync, then the high-water
 * seq advances. A write failure poisons the log — every later append rejects
 * rather than concatenate onto a possibly half-written line (the log is the
 * source of truth). Recovery repairs and reopens; it does not append through a
 * poisoned handle.
 */
export async function createLog(opts: CreateLogOptions): Promise<Log> {
  const { filePath, sessionId, sequencer } = opts;
  const isNew = !(await stat(filePath).then(() => true).catch(() => false));

  const handle: FileHandle = await open(filePath, 'a', FILE_MODE);
  if (isNew) {
    try {
      await handle.sync();
      await fsyncDir(dirname(filePath));
    } catch (err) {
      await handle.close();
      throw err instanceof StorageError ? err : new StorageError('create-log', err);
    }
  }

  let durableSeq = opts.startSeq ?? 0n;
  let tail: Promise<unknown> = Promise.resolve();
  let poison: Error | null = null;

  const append = (input: EventInput): Promise<AnyEvent> => {
    const result = tail.then(async () => {
      if (poison) throw poison;
      const seq = durableSeq + 1n;
      const event = buildEnvelope(sequencer ? sequencer.enrich(input) : input, seq, sessionId);
      try {
        await writeAll(handle, Buffer.from(`${JSON.stringify(event)}\n`));
        await handle.sync();
      } catch (err) {
        poison = err instanceof StorageError ? err : new StorageError('append', err);
        throw poison;
      }
      durableSeq = seq;
      // Ordered and durable: advance any sequencer state before the next append
      // is processed, so a later change sees this commit and no earlier one does.
      sequencer?.onCommitted(event);
      return event;
    });
    tail = result.catch(() => undefined);
    return result;
  };

  const close = async (): Promise<void> => {
    await tail;
    await handle.close();
  };

  return { append, durableSeq: () => durableSeq, close };
}
