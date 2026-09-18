import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer, type Server } from 'node:http';
import { blobPath } from './store-reader.ts';
import { diskBlobSource, httpBlobSource } from './blob-source.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const CAP = Number.POSITIVE_INFINITY;

async function writeBlob(store: string, hex: string, bytes: Buffer | string): Promise<void> {
  const p = blobPath(store, hex);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, bytes);
}

test('diskBlobSource: reads a UTF-8 blob as text', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  await writeBlob(store, SHA_A, 'hello\nworld');
  assert.deepEqual(await diskBlobSource(store)(SHA_A, CAP), { kind: 'text', text: 'hello\nworld' });
});

test('diskBlobSource: a blob with a NUL byte is binary', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  await writeBlob(store, SHA_A, Buffer.from([0x66, 0x00, 0x67]));
  assert.deepEqual(await diskBlobSource(store)(SHA_A, CAP), { kind: 'binary' });
});

test('diskBlobSource: invalid UTF-8 is binary', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  await writeBlob(store, SHA_A, Buffer.from([0xff, 0xfe, 0xfd]));
  assert.deepEqual(await diskBlobSource(store)(SHA_A, CAP), { kind: 'binary' });
});

test('diskBlobSource: a missing blob is reported, not invented', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  const r = await diskBlobSource(store)(SHA_B, CAP);
  assert.equal(r.kind, 'missing');
});

test('diskBlobSource: an invalid hex is refused', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  const r = await diskBlobSource(store)('../etc/passwd', CAP);
  assert.deepEqual(r, { kind: 'missing', reason: 'invalid-hex' });
});

test('diskBlobSource: a symlink at the CAS path is not followed', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  const secret = join(store, 'secret.txt');
  await writeFile(secret, 'TOP SECRET');
  const p = blobPath(store, SHA_A);
  await mkdir(dirname(p), { recursive: true });
  await symlink(secret, p);
  const r = await diskBlobSource(store)(SHA_A, CAP);
  assert.equal(r.kind, 'missing'); // never returns the symlink target's bytes
});

test('httpBlobSource: fetches text with a bearer token', async () => {
  let authHeader: string | undefined;
  const srv = createServer((req, res) => {
    authHeader = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('http-text');
  });
  const url = await listen(srv);
  try {
    const r = await httpBlobSource({ url, token: 'sekret' })(SHA_A, CAP);
    assert.deepEqual(r, { kind: 'text', text: 'http-text' });
    assert.equal(authHeader, 'Bearer sekret');
  } finally { srv.close(); }
});

test('httpBlobSource: a NUL-containing body is binary', async () => {
  const srv = createServer((_req, res) => { res.writeHead(200); res.end(Buffer.from([0x61, 0x00])); });
  const url = await listen(srv);
  try {
    assert.deepEqual(await httpBlobSource({ url, token: 't' })(SHA_A, CAP), { kind: 'binary' });
  } finally { srv.close(); }
});

test('httpBlobSource: a non-200 is reported as missing with the status', async () => {
  const srv = createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
  const url = await listen(srv);
  try {
    const r = await httpBlobSource({ url, token: 't' })(SHA_A, CAP);
    assert.deepEqual(r, { kind: 'missing', reason: 'http-404' });
  } finally { srv.close(); }
});

test('httpBlobSource: an invalid hex is refused before any request', async () => {
  let hit = false;
  const srv = createServer((_req, res) => { hit = true; res.end(); });
  const url = await listen(srv);
  try {
    assert.deepEqual(await httpBlobSource({ url, token: 't' })("nothex", CAP), { kind: 'missing', reason: 'invalid-hex' });
    assert.equal(hit, false);
  } finally { srv.close(); }
});

test('diskBlobSource: a blob larger than the cap is oversize, not read as text', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  await writeBlob(store, SHA_A, 'x'.repeat(100));
  assert.deepEqual(await diskBlobSource(store)(SHA_A, 10), { kind: 'oversize', size: 100 });
});

test('diskBlobSource: a leading BOM is kept as content, not read as empty', async () => {
  const store = await mkdtemp(join(tmpdir(), 'slip-blob-'));
  await writeBlob(store, SHA_A, Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual(await diskBlobSource(store)(SHA_A, CAP), { kind: 'text', text: '﻿' });
});

test('httpBlobSource: a body larger than the cap is oversize', async () => {
  const srv = createServer((_req, res) => { res.writeHead(200); res.end('x'.repeat(100)); });
  const url = await listen(srv);
  try {
    assert.deepEqual(await httpBlobSource({ url, token: 't' })(SHA_A, 10), { kind: 'oversize', size: 100 });
  } finally { srv.close(); }
});

test('httpBlobSource: a chunked body with no content-length is capped mid-stream', async () => {
  // No content-length header (chunked), so the cap can only be enforced while
  // reading: the body must not be fully buffered first.
  const srv = createServer((_req, res) => {
    res.writeHead(200);
    res.write('x'.repeat(50));
    res.write('x'.repeat(50));
    res.end();
  });
  const url = await listen(srv);
  try {
    const r = await httpBlobSource({ url, token: 't' })(SHA_A, 10);
    assert.equal(r.kind, 'oversize');
    if (r.kind === 'oversize') assert.ok(r.size > 10, `size ${r.size} should exceed the cap`);
  } finally { srv.close(); }
});

test('httpBlobSource: a 204 with no body is missing, never a fake empty blob', async () => {
  const srv = createServer((_req, res) => { res.writeHead(204); res.end(); });
  const url = await listen(srv);
  try {
    assert.deepEqual(await httpBlobSource({ url, token: 't' })(SHA_A, CAP), { kind: 'missing', reason: 'http-204' });
  } finally { srv.close(); }
});

test('httpBlobSource: a body that stalls past the timeout is missing, not a hang', async () => {
  // Send a 200 header, then never finish the body: the timer must still fire.
  const srv = createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  const url = await listen(srv);
  try {
    const r = await httpBlobSource({ url, token: 't' }, 100)(SHA_A, CAP);
    assert.deepEqual(r, { kind: 'missing', reason: 'fetch-failed' });
  } finally { srv.close(); }
});

function listen(srv: Server): Promise<string> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`);
    });
  });
}
