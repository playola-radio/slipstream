import { open, type FileHandle } from 'node:fs/promises';
import type { Snapshot } from './snapshot.ts';

export interface FileChangedInput {
  type: 'file.changed';
  path: string;
  before: Snapshot;
  after: Snapshot;
  /** High-resolution wall clock (epoch ms) when the change was first observed. */
  observed_at_ms: number;
  /** True when intermediate states may have been coalesced before this commit. */
  coalesced?: boolean;
}

export type CaptureGapReason = 'coalesced' | 'baseline-unreadable' | 'watcher-error';

export interface CaptureGapInput {
  type: 'capture.gap';
  path: string;
  reason: CaptureGapReason;
  observed_at_ms: number;
}

export type RecordInput = FileChangedInput | CaptureGapInput;

export type LoggedRecord = RecordInput & {
  committed_at_ms: number;
};

export interface Log {
  append(input: RecordInput): Promise<void>;
  close(): Promise<void>;
}

/**
 * Write the whole buffer, looping on short writes. A single `handle.write` may
 * commit fewer bytes than requested under storage pressure; the log is the
 * source of truth, so a truncated line would corrupt every record after it.
 */
export async function writeAll(
  handle: Pick<FileHandle, 'write'>,
  buf: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
    if (bytesWritten <= 0) throw new Error('log write made no progress');
    offset += bytesWritten;
  }
}

export async function createLog(filePath: string): Promise<Log> {
  const handle: FileHandle = await open(filePath, 'a');
  let tail: Promise<unknown> = Promise.resolve();
  // A write that fails mid-line leaves the file at an unknown offset. Appending
  // further records would concatenate onto that partial line and corrupt the
  // log — which is the source of truth. Once poisoned, every append rejects
  // rather than risk writing onto a half-written line.
  let poison: Error | null = null;

  const append = (input: RecordInput): Promise<void> => {
    // Chain onto the tail so appends never interleave or lose lines.
    const result = tail.then(async () => {
      if (poison) throw poison;
      // committed_at_ms is the serialized commit instant, stamped immediately
      // before the (un-fsynced, sub-ms) append. Durable publication is Stage 2.
      const record: LoggedRecord = { ...input, committed_at_ms: Date.now() };
      try {
        await writeAll(handle, Buffer.from(`${JSON.stringify(record)}\n`));
      } catch (err) {
        poison = err instanceof Error ? err : new Error(String(err));
        throw poison;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };

  const close = async (): Promise<void> => {
    await tail;
    await handle.close();
  };

  return { append, close };
}
