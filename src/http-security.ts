import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirpDurable, writeAll, fsyncDir, FILE_MODE } from './storage.ts';
import type { RuntimeDescriptor } from './store-reader.ts';

export function generateToken(): string { return randomBytes(32).toString('hex'); }

export async function publishDescriptor(storeDir: string, descriptor: RuntimeDescriptor): Promise<string> {
  const dir = join(storeDir, 'runtime');
  await mkdirpDurable(dir);
  const path = join(dir, `${randomUUID()}.json`);
  const tmp = `${path}.tmp`;
  const body = Buffer.from(JSON.stringify(descriptor), 'utf8');
  const handle = await open(tmp, 'wx', FILE_MODE);
  try { await writeAll(handle, body); await handle.sync(); }
  finally { await handle.close(); }
  await rename(tmp, path);
  await fsyncDir(dir);
  return path;
}

export function checkAuth(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export function checkHostOrigin(
  headers: Record<string, string | string[] | undefined>,
  expectedHostPort: string,
): boolean {
  const host = headers.host;
  if (typeof host !== 'string' || host !== expectedHostPort) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return origin === `http://${expectedHostPort}`;
}
