// BlobSource implementations: resolve a content blob (by sha256) to text, binary,
// or an honest "missing" with a reason. The reader over HTTP and the direct disk
// reader are the two ways to reach the content-addressed store; both feed the
// same change renderer.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { blobPath, isValidHex, type RuntimeDescriptor } from './store-reader.ts';
import type { BlobResult, BlobSource } from './change-view.ts';

function decode(buf: Buffer): BlobResult {
  if (buf.includes(0)) return { kind: 'binary' };
  try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }; }
  catch { return { kind: 'binary' }; }
}

export function diskBlobSource(storeDir: string): BlobSource {
  return async (sha256) => {
    if (!isValidHex(sha256)) return { kind: 'missing', reason: 'invalid-hex' };
    // O_NOFOLLOW: a symlink planted at a valid CAS path must serve nothing but
    // the blob it names — never the link target's bytes.
    let handle;
    try { handle = await open(blobPath(storeDir, sha256), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) { return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'open-failed' }; }
    try { return decode(await handle.readFile()); }
    catch (err) { return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'read-failed' }; }
    finally { await handle.close(); }
  };
}

export function httpBlobSource(desc: RuntimeDescriptor, timeoutMs = 5000): BlobSource {
  return async (sha256) => {
    if (!isValidHex(sha256)) return { kind: 'missing', reason: 'invalid-hex' };
    const url = new URL(`v1/blobs/sha256/${sha256}`, desc.url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${desc.token}` }, redirect: 'error', signal: ac.signal,
      });
    } catch { return { kind: 'missing', reason: 'fetch-failed' }; }
    finally { clearTimeout(timer); }
    if (!res.ok) return { kind: 'missing', reason: `http-${res.status}` };
    return decode(Buffer.from(await res.arrayBuffer()));
  };
}
