import { open, stat as fsStat } from 'node:fs/promises';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';

/** The real filesystem IO for transcript files. Missing → `missing`; any other
 * stat/read error → `inaccessible` (disclosed, never a silent empty read). */
export const nodeTranscriptFileIO: TranscriptFileIO = {
  async stat(path: string): Promise<StatResult> {
    try {
      const s = await fsStat(path);
      return { ok: true, size: s.size, dev: s.dev, ino: Number(s.ino) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'inaccessible' };
    }
  },
  async read(path: string, start: number, end: number): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const length = end - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};
