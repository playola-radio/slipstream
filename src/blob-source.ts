// BlobSource implementations: resolve a content blob (by sha256) to text, binary,
// oversize, or an honest "missing" with a reason. The reader over HTTP and the
// direct disk reader are the two ways to reach the content-addressed store; both
// feed the same change renderer. Each bounds the bytes it will actually read to
// `maxBytes`, so a snapshot that under-reports its size can't force a huge read.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { blobPath, isValidHex, type RuntimeDescriptor } from './store-reader.ts';
import type { BlobResult, BlobSource } from './change-view.ts';

function decode(buf: Buffer): BlobResult {
  if (buf.includes(0)) return { kind: 'binary' };
  // ignoreBOM keeps a leading U+FEFF as content, so a BOM-only file decodes to a
  // one-char line, not a false "(empty file)".
  try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }; }
  catch { return { kind: 'binary' }; }
}

export function diskBlobSource(storeDir: string): BlobSource {
  return async (sha256, maxBytes) => {
    if (!isValidHex(sha256)) return { kind: 'missing', reason: 'invalid-hex' };
    // O_NOFOLLOW: a symlink planted at a valid CAS path must serve nothing but
    // the blob it names — never the link target's bytes.
    let handle;
    try { handle = await open(blobPath(storeDir, sha256), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) { return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'open-failed' }; }
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) return { kind: 'oversize', size };
      return decode(await handle.readFile());
    }
    catch (err) { return { kind: 'missing', reason: (err as NodeJS.ErrnoException).code ?? 'read-failed' }; }
    finally { await handle.close(); }
  };
}

export function httpBlobSource(desc: RuntimeDescriptor, timeoutMs = 5000): BlobSource {
  return async (sha256, maxBytes) => {
    if (!isValidHex(sha256)) return { kind: 'missing', reason: 'invalid-hex' };
    const url = new URL(`v1/blobs/sha256/${sha256}`, desc.url);
    const ac = new AbortController();
    // The timer stays armed through the body read, not just the header fetch: a
    // server that stalls mid-body must still trip the timeout rather than hang.
    // Aborting on every early return tears down the connection so a stalled body
    // can't hold it open after we've stopped reading.
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${desc.token}` }, redirect: 'error', signal: ac.signal,
      });
      // Only a plain 200 carries the full blob; 204/206 and the rest are not it.
      if (res.status !== 200) { ac.abort(); return { kind: 'missing', reason: `http-${res.status}` }; }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) { ac.abort(); return { kind: 'oversize', size: declared }; }
      if (!res.body) return { kind: 'missing', reason: 'no-body' };
      // Read incrementally so a chunked body with no Content-Length can't be fully
      // buffered before the cap check: stop and abort the moment it exceeds it.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { ac.abort(); return { kind: 'oversize', size: total }; }
        chunks.push(value);
      }
      return decode(Buffer.concat(chunks));
    } catch { return { kind: 'missing', reason: 'fetch-failed' }; }
    finally { clearTimeout(timer); }
  };
}
