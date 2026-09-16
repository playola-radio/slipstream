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

export interface CaptureGapInput {
  type: 'capture.gap';
  path: string;
  reason: 'coalesced';
  observed_at_ms: number;
}

export type RecordInput = FileChangedInput | CaptureGapInput;

export type LoggedRecord = RecordInput & {
  seq: number;
  committed_at_ms: number;
};

export interface Log {
  append(input: RecordInput): Promise<LoggedRecord>;
  close(): Promise<void>;
}

export async function createLog(filePath: string): Promise<Log> {
  const handle: FileHandle = await open(filePath, 'a');
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const append = (input: RecordInput): Promise<LoggedRecord> => {
    // Chain onto the tail so appends never interleave and seq stays contiguous.
    const result = tail.then(async () => {
      const record: LoggedRecord = {
        ...input,
        seq: ++seq,
        committed_at_ms: Date.now(),
      };
      await handle.write(`${JSON.stringify(record)}\n`);
      return record;
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
