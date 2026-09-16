import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BlobRef {
  sha256: string;
  size: number;
}

export interface Cas {
  put(bytes: Buffer): Promise<BlobRef>;
  read(sha256: string): Promise<Buffer>;
  has(sha256: string): Promise<boolean>;
  pathFor(sha256: string): string;
}

export async function createCas(rootDir: string): Promise<Cas> {
  const base = join(rootDir, 'sha256');
  await mkdir(base, { recursive: true });

  const pathFor = (sha256: string): string => join(base, sha256.slice(0, 2), sha256);

  const has = async (sha256: string): Promise<boolean> => {
    try {
      await access(pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  };

  const put = async (bytes: Buffer): Promise<BlobRef> => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dest = pathFor(sha256);
    if (!(await has(sha256))) {
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, dest);
    }
    return { sha256, size: bytes.length };
  };

  const read = (sha256: string): Promise<Buffer> => readFile(pathFor(sha256));

  return { put, read, has, pathFor };
}
