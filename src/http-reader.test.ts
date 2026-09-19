import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, access, rm } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import { createCas } from './cas.ts';
import { createHealth } from './health.ts';
import { createBoundaryRegistry } from './boundary-registry.ts';
import { liveBoundary, staticBoundary } from './reader-runtime.ts';

const UUID = '22222222-2222-4222-8222-222222222222';

async function storeWithSession(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-http-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  await writeFile(
    join(dir, 'sessions', UUID, 'events.jsonl'),
    '{"seq":"1","type":"test","data":{}}\n{"seq":"2","type":"test","data":{}}\n',
    'utf8',
  );
  return dir;
}

async function GET(srv: ReaderServer, path: string, headers: Record<string,string> = {}) {
  return fetch(`${srv.url}${path}`, {
    headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}`, ...headers },
  });
}

// fetch() forbids setting a duplicate/custom Host, so drive the raw wire directly.
function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

describe('http-reader core', () => {
  let dir: string; let srv: ReaderServer;
  before(async () => { dir = await storeWithSession(); srv = await startReaderServer({ storeDir: dir }); });
  after(async () => { await srv.close(); });

  it('lists sessions with durable seq and removed flag', async () => {
    const res = await GET(srv, '/v1/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, [{ id: UUID, durable_seq: '2', removed: false }]);
  });

  it('rejects a missing bearer with 401', async () => {
    const res = await fetch(`${srv.url}/v1/sessions`, { headers: { host: `127.0.0.1:${srv.port}` } });
    assert.equal(res.status, 401);
  });

  it('rejects a foreign origin with 403', async () => {
    const res = await GET(srv, '/v1/sessions', { origin: 'http://evil.test' });
    assert.equal(res.status, 403);
  });

  it('rejects a non-GET method with 405 and Allow: GET', async () => {
    const res = await fetch(`${srv.url}/v1/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });

  it('returns 404 for an unknown route', async () => {
    assert.equal((await GET(srv, '/v1/nope')).status, 404);
  });

  it('rejects a request carrying two Host headers with 403', async () => {
    const resp = await rawRequest(srv.port, [
      'GET /v1/sessions HTTP/1.1',
      `Host: 127.0.0.1:${srv.port}`,
      `hOsT: 127.0.0.1:${srv.port}`,
      `Authorization: Bearer ${srv.token}`,
      'Connection: close',
    ]);
    assert.match(resp, /^HTTP\/1\.1 403/);
  });

  it('removes its runtime descriptor on close', async () => {
    const d = await storeWithSession();
    const s = await startReaderServer({ storeDir: d });
    const dp = s.descriptorPath;
    await access(dp); // present while running
    await s.close();
    await assert.rejects(() => access(dp), /ENOENT/);
  });
});

describe('http-reader events (finite)', () => {
  let dir: string; let srv: ReaderServer;
  before(async () => { dir = await storeWithSession(); srv = await startReaderServer({ storeDir: dir }); });
  after(async () => { await srv.close(); });

  it('returns (after, H] as ndjson with the durable-seq header', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    assert.deepEqual(lines.map((l) => JSON.parse(l).seq), ['1', '2']);
  });

  it('returns an empty 200 with the header when caught up', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
    assert.equal((await res.text()), '');
  });

  it('400 on an invalid cursor', async () => {
    assert.equal((await GET(srv, `/v1/sessions/${UUID}/events?after=-1`)).status, 400);
  });

  it('404 on an unknown session', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    assert.equal((await GET(srv, `/v1/sessions/${other}/events?after=0`)).status, 404);
  });

  it('409 when the cursor is beyond the durable high-water, with the header', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=99`);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
  });

  it('410 for a tombstoned session', async () => {
    const removed = '44444444-4444-4444-8444-444444444444';
    await mkdir(join(dir, 'sessions', removed), { recursive: true });
    await writeFile(join(dir, 'sessions', removed, 'removed.json'), '{"version":1}', 'utf8');
    assert.equal((await GET(srv, `/v1/sessions/${removed}/events?after=0`)).status, 410);
  });
});

describe('http-reader corruption honesty', () => {
  it('/v1/sessions reports the active session durable_seq from health, not disk', async () => {
    const dir = await storeWithSession();               // disk log has seq 1,2
    const health = createHealth(1n);                    // health H behind the disk
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    try {
      const body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '1', removed: false }]);
    } finally { await srv.close(); }
  });

  it('finite events endpoint returns 500 (not a truncated 200) on mid-log corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slip-http-corrupt-'));
    const id = '66666666-6666-4666-8666-666666666666';
    await mkdir(join(dir, 'sessions', id), { recursive: true });
    await writeFile(
      join(dir, 'sessions', id, 'events.jsonl'),
      '{"seq":"1","type":"t","data":{}}\n{oops\n{"seq":"3","type":"t","data":{}}\n',
      'utf8',
    );
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const res = await GET(srv, `/v1/sessions/${id}/events?after=0`);
      assert.equal(res.status, 500);
      await res.text();
    } finally { await srv.close(); }
  });
});

describe('http-reader blobs + schemas', () => {
  let dir: string; let srv: ReaderServer; let hex: string; let empty: string;
  before(async () => {
    dir = await storeWithSession();
    const cas = await createCas(join(dir, 'blobs'));
    hex = (await cas.put(Buffer.from('hello'))).sha256;
    empty = (await cas.put(Buffer.alloc(0))).sha256;
    srv = await startReaderServer({ storeDir: dir });
  });
  after(async () => { await srv.close(); });

  it('serves blob bytes as octet-stream', async () => {
    const res = await GET(srv, `/v1/blobs/sha256/${hex}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'hello');
  });

  it('serves a genuine zero-byte blob as an empty 200', async () => {
    const res = await GET(srv, `/v1/blobs/sha256/${empty}`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  it('400 on malformed hex, 404 on a missing blob', async () => {
    assert.equal((await GET(srv, '/v1/blobs/sha256/ZZZ')).status, 400);
    assert.equal((await GET(srv, `/v1/blobs/sha256/${'a'.repeat(64)}`)).status, 404);
  });

  it('returns 404 for a symlink planted at a valid blob path and never serves its target', async () => {
    const d = await mkdtemp(join(tmpdir(), 'slip-symlink-'));
    const planted = 'b'.repeat(64);
    const shard = join(d, 'blobs', 'sha256', planted.slice(0, 2));
    await mkdir(shard, { recursive: true });
    const target = join(d, 'secret.txt');
    await writeFile(target, 'SECRET-OUT-OF-STORE', 'utf8');
    await symlink(target, join(shard, planted));
    const s = await startReaderServer({ storeDir: d });
    try {
      const res = await GET(s, `/v1/blobs/sha256/${planted}`);
      assert.equal(res.status, 404);
      assert.notEqual(await res.text(), 'SECRET-OUT-OF-STORE');
    } finally { await s.close(); }
  });

  it('serves a known schema verbatim and 404 on an unknown type', async () => {
    const res = await GET(srv, '/v1/schemas/slipstream.file.changed.v1');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { properties: { type: { const: string } } };
    assert.equal(body.properties.type.const, 'slipstream.file.changed.v1');
    assert.equal((await GET(srv, '/v1/schemas/nope.v1')).status, 404);
  });
});

const ceLine = (seq: number, type: string, data: Record<string, unknown>): string =>
  JSON.stringify({
    specversion: '1.0', id: String(seq), source: `urn:slipstream:session:${UUID}`,
    type, datacontenttype: 'application/json', seq: String(seq),
    time: '2026-01-01T00:00:00.000Z', data: { session_id: UUID, ...data },
  });

// A store with one file.changed.v1 at seq 2 whose before/after reference real blobs.
async function storeWithChange(path = 'x.txt', beforeText = 'a\nb\nc\n', afterText = 'a\nB\nc\n'): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-clips-'));
  const cas = await createCas(join(dir, 'blobs'));
  const before = await cas.put(Buffer.from(beforeText, 'utf8'));
  const after = await cas.put(Buffer.from(afterText, 'utf8'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  const lines = [
    ceLine(1, 'slipstream.session.started.v1', { root: '/w', max_bytes: 1024, started_at_ms: 0 }),
    ceLine(2, 'slipstream.file.changed.v1', {
      path,
      before: { kind: 'content', sha256: before.sha256, size: before.size },
      after: { kind: 'content', sha256: after.sha256, size: after.size },
      observation: 'watcher', observed_at_ms: 0,
    }),
  ];
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  return { dir };
}

describe('http-reader clip projection', () => {
  it('serves the same function projection as a direct-disk client without appending to the log', async () => {
    const { computeClipProjection, parseClipSnapshot } = await import('./clip-blob-reader.ts');
    const before = 'function f(n: string) {\n  return 1;\n}\n';
    const { dir } = await storeWithChange('x.ts', before, before.replace('return 1', 'return 2'));
    const logPath = join(dir, 'sessions', UUID, 'events.jsonl');
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(logPath, 'utf8');
    const event = JSON.parse(original.trim().split('\n')[1]!);
    const direct = await computeClipProjection({ storeDir: dir, before: parseClipSnapshot(event.data.before)!,
      after: parseClipSnapshot(event.data.after)!, opts: { changeSeq: '2', language: 'typescript' } });
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const response = await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), direct);
      assert.equal(direct.status, 'ready');
      assert.equal(direct.clips[0]!.after.method, 'function');
      assert.equal(await readFile(logPath, 'utf8'), original);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('returns a clip projection for a change', async () => {
    const { dir } = await storeWithChange();
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const res = await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await res.json() as {
        change_seq: string; projection_version: string; status: string; clips: unknown[];
      };
      assert.equal(body.change_seq, '2');
      assert.equal(body.projection_version, 'clip.v2');
      assert.equal(body.status, 'fallback');
      assert.ok(body.clips.length >= 1);
    } finally { await srv.close(); }
  });

  it('reports clips unavailable with a reason when the blobs were GC\'d', async () => {
    const { dir } = await storeWithChange();
    await rm(join(dir, 'blobs'), { recursive: true, force: true }); // GC dropped the content
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const res = await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`);
      assert.equal(res.status, 200); // the request succeeded; the projection carries availability
      const body = await res.json() as { status: string; fallback_reason?: string };
      assert.equal(body.status, 'unavailable');
      assert.ok(body.fallback_reason && body.fallback_reason.length > 0); // explicit reason, never faked
    } finally { await srv.close(); }
  });

  it('serves the published projection schema and 404s an unknown version', async () => {
    // Schema lookup is static: it reads no session log or blobs, so an empty
    // store is enough — no captured change needs fabricating.
    const srv = await startReaderServer({ storeDir: await mkdtemp(join(tmpdir(), 'slip-http-')) });
    try {
      const res = await GET(srv, '/v1/schemas/projections/clip.v1');
      assert.equal(res.status, 200);
      const body = await res.json() as { title: string; $id: string };
      assert.equal(body.title, 'clip.v1');
      assert.match(body.$id, /projections\/clip\.v1\.json$/);
      const v2 = await GET(srv, '/v1/schemas/projections/clip.v2');
      assert.equal(v2.status, 200);
      assert.equal((await v2.json() as { title: string }).title, 'clip.v2');
      assert.equal((await GET(srv, '/v1/schemas/projections/nope.v1')).status, 404);
    } finally { await srv.close(); }
  });

  it('404s a seq that is not a file.changed event', async () => {
    const srv = await startReaderServer({ storeDir: (await storeWithChange()).dir });
    try {
      assert.equal((await GET(srv, `/v1/sessions/${UUID}/changes/1/clips`)).status, 404);
    } finally { await srv.close(); }
  });

  it('404s a seq beyond the durable high-water', async () => {
    const srv = await startReaderServer({ storeDir: (await storeWithChange()).dir });
    try {
      assert.equal((await GET(srv, `/v1/sessions/${UUID}/changes/99/clips`)).status, 404);
    } finally { await srv.close(); }
  });

  it('404s a non-canonical (leading-zero) seq rather than stamping it', async () => {
    // "02" resolves to change 2 via BigInt but would be echoed verbatim into a
    // schema-invalid change_seq; reject it instead.
    const srv = await startReaderServer({ storeDir: (await storeWithChange()).dir });
    try {
      assert.equal((await GET(srv, `/v1/sessions/${UUID}/changes/02/clips`)).status, 404);
    } finally { await srv.close(); }
  });

  it('500s a record missing within the durable boundary (corruption, not 404)', async () => {
    // The registry declares the high-water at 2, but the log holds only seq 1:
    // disk is short of its declared boundary. That is corruption, never an
    // ordinary unknown-change 404.
    const dir = await mkdtemp(join(tmpdir(), 'slip-clips-'));
    await mkdir(join(dir, 'sessions', UUID), { recursive: true });
    await writeFile(
      join(dir, 'sessions', UUID, 'events.jsonl'),
      ceLine(1, 'slipstream.session.started.v1', { root: '/w', max_bytes: 1024, started_at_ms: 0 }) + '\n',
      'utf8',
    );
    const registry = createBoundaryRegistry();
    registry.installIfAbsent(UUID, staticBoundary(2n));
    const srv = await startReaderServer({ storeDir: dir, registry });
    try {
      assert.equal((await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`)).status, 500);
    } finally { await srv.close(); }
  });

  it('404s an unknown session and 410s a tombstoned one', async () => {
    const { dir } = await storeWithChange();
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const other = '33333333-3333-4333-8333-333333333333';
      assert.equal((await GET(srv, `/v1/sessions/${other}/changes/2/clips`)).status, 404);
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      assert.equal((await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`)).status, 410);
    } finally { await srv.close(); }
  });

  it('410s (not 404s) a clips request when delete races the boundary check', async () => {
    // Simulate delete_session landing between the initial tombstone check and the
    // boundary read: durable tombstone plus a boundary frozen to 0 makes every
    // positive seq look "beyond" H. That is removal, not an unknown change.
    const { dir } = await storeWithChange();
    const health = createHealth(2n);
    const registry = createBoundaryRegistry();
    registry.installIfAbsent(UUID, liveBoundary(health));
    const srv = await startReaderServer({ storeDir: dir, registry });
    try {
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      registry.freeze(UUID, 0n);
      const res = await GET(srv, `/v1/sessions/${UUID}/changes/2/clips`);
      assert.equal(res.status, 410);
    } finally { await srv.close(); }
  });
});

function sseEvents(text: string): { id: string; data: string }[] {
  return text.split('\n\n').filter((f) => f.includes('data:')).map((frame) => {
    const id = /(^|\n)id: (.*)/.exec(frame)?.[2] ?? '';
    const data = /(^|\n)data: (.*)/.exec(frame)?.[2] ?? '';
    return { id, data };
  });
}

describe('http-reader SSE follow', () => {
  it('replays then follows with one cursor: no gap, no duplicate across the seam', async () => {
    const dir = await storeWithSession();               // has seq 1,2 on disk
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
      signal: ac.signal,
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = ''; const seen: string[] = [];
    async function pump(until: number) {
      while (seen.length < until) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        for (const e of sseEvents(acc)) if (e.data && !seen.includes(e.id)) seen.push(e.id);
      }
    }
    await pump(2);                                       // replayed 1,2
    // live append 3 and advance the durable boundary
    await appendFile(join(dir, 'sessions', UUID, 'events.jsonl'),
      JSON.stringify({ specversion:'1.0', id:'3', source:'urn:slipstream:session:'+UUID,
        type:'slipstream.file.changed.v1', datacontenttype:'application/json', seq:'3',
        time:'2026-01-01T00:00:00.000Z', data:{ session_id: UUID } }) + '\n');
    health.setDurableSeq(3n);
    await pump(3);
    assert.deepEqual(seen, ['1', '2', '3']);            // no gap, no dup
    ac.abort();
    await srv.close();
  });

  it('close() resolves promptly even with a live SSE follower connected', async () => {
    const dir = await storeWithSession();
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    // Leave the follower open; a broken close() would hang here forever.
    const closed = srv.close();
    const guard = new Promise<never>((_r, reject) =>
      setTimeout(() => reject(new Error('srv.close() hung with a live SSE follower')), 4000).unref());
    await Promise.race([closed, guard]);
    ac.abort();
  });

  it('Last-Event-ID overrides after and yields exactly the suffix', async () => {
    const dir = await storeWithSession();
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}`, 'last-event-id': '1' },
      signal: ac.signal,
    });
    const reader = res.body!.getReader(); const decoder = new TextDecoder();
    let acc = ''; let firstId = '';
    while (!firstId) {
      const { value, done } = await reader.read(); if (done) break;
      acc += decoder.decode(value, { stream: true });
      firstId = sseEvents(acc)[0]?.id ?? '';
    }
    assert.equal(firstId, '2');                          // 1 skipped
    ac.abort(); await srv.close();
  });

  it('Last-Event-ID overrides a malformed after param (follows from the LEI)', async () => {
    const dir = await storeWithSession();
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=notanumber&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}`, 'last-event-id': '1' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader(); const decoder = new TextDecoder();
    let acc = ''; let firstId = '';
    while (!firstId) {
      const { value, done } = await reader.read(); if (done) break;
      acc += decoder.decode(value, { stream: true });
      firstId = sseEvents(acc)[0]?.id ?? '';
    }
    assert.equal(firstId, '2');                          // parsed LEI=1, not a 400
    ac.abort(); await srv.close();
  });
});

describe('http-reader deletion', () => {
  it('lists a removed session at durable_seq 0 even with a stale registry entry', async () => {
    const dir = await storeWithSession();
    const registry = createBoundaryRegistry();
    // A prior detach left a frozen entry at the session's final seq; a delete does
    // not clear it, so the listing must not surface that stale boundary.
    registry.installIfAbsent(UUID, staticBoundary(2n));
    await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
    const srv = await startReaderServer({ storeDir: dir, registry });
    try {
      const body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '0', removed: true }]);
    } finally { await srv.close(); }
  });

  it('aborts an in-flight follower on delete, then 410s the reconnect', async () => {
    const dir = await storeWithSession();
    const health = createHealth(2n);
    const registry = createBoundaryRegistry();
    registry.installIfAbsent(UUID, liveBoundary(health));
    const srv = await startReaderServer({ storeDir: dir, registry });
    const ac = new AbortController();
    try {
      const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
        headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
        signal: ac.signal,
      });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      await reader.read(); // headers + first frames flushed: the follower is registered

      // Simulate delete_session: durable tombstone, then freeze(id, 0n).
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      registry.freeze(UUID, 0n);

      // The freeze aborts the in-flight follower: its stream ends (a clean done, or
      // a socket error from the server's abrupt destroy — both are "ended").
      const drain = (async () => {
        try { for (;;) { const r = await reader.read(); if (r.done) return true; } }
        catch { return true; }
      })();
      const guard = new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('follower was not aborted on delete')), 4000).unref());
      assert.equal(await Promise.race([drain, guard]), true);

      // A reconnect now sees the durable tombstone: 410.
      const again = await GET(srv, `/v1/sessions/${UUID}/events?after=0&follow=true`);
      assert.equal(again.status, 410);
      await again.body?.cancel();
    } finally { ac.abort(); await srv.close(); }
  });
});

it('returns 400 for malformed schema tokens and encoding', async () => {
  const srv = await startReaderServer({ storeDir: await storeWithSession() });
  try {
    for (const type of ['%ZZ', '%E0%A4%A', 'bad%20type', '..%2Fsecret', 'bad%00type']) {
      assert.equal((await GET(srv, `/v1/schemas/${type}`)).status, 400, type);
    }
  } finally { await srv.close(); }
});

it('flushes caught-up SSE headers before any event or heartbeat', async () => {
  const srv = await startReaderServer({ storeDir: await storeWithSession() });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1000);
  try {
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=2&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}` }, signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { clearTimeout(timer); ac.abort(); await srv.close(); }
});

it('replays many batches over finite and SSE, then follows exactly once up to H', async () => {
  const count = 1600;
  const dir = await storeWithSession();
  const path = join(dir, 'sessions', UUID, 'events.jsonl');
  const line = (n: number) => JSON.stringify({ seq: String(n), type: 'test', data: { text: 'x'.repeat(1024) } }) + '\n';
  await writeFile(path, Array.from({ length: count + 1 }, (_, i) => line(i + 1)).join(''));
  const health = createHealth(BigInt(count));
  const srv = await startReaderServer({ storeDir: dir, active: { id: UUID, health, logPath: path } });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const finite = await GET(srv, `/v1/sessions/${UUID}/events`);
    assert.equal(finite.headers.get('slipstream-durable-seq'), String(count));
    const expected = Array.from({ length: count }, (_, i) => String(i + 1));
    assert.deepEqual((await finite.text()).trimEnd().split('\n').map(l => JSON.parse(l).seq), expected);
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?follow=true`, {
      headers: { authorization: `Bearer ${srv.token}` }, signal: ac.signal,
    });
    const reader = res.body!.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (sseEvents(text).length < count) {
      const part = await reader.read(); assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    assert.deepEqual(sseEvents(text).map(e => e.id), expected);
    health.setDurableSeq(BigInt(count + 1));
    while (sseEvents(text).length < count + 1) {
      const part = await reader.read(); assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    assert.deepEqual(sseEvents(text).map(e => e.id), [...expected, String(count + 1)]);
  } finally { clearTimeout(timer); ac.abort(); await srv.close(); }
});

it('finite replay waits for drain before writing the next record', async () => {
  const srv = await startReaderServer({ storeDir: await storeWithSession() });
  const original = ServerResponse.prototype.write;
  let waiting = false; let ignored = false; let writes = 0;
  const patched = mock.method(ServerResponse.prototype, 'write', function (this: ServerResponse, chunk: string) {
    if (waiting) ignored = true;
    writes++;
    original.call(this, chunk, 'utf8');
    waiting = true;
    setTimeout(() => { waiting = false; this.emit('drain'); }, 30);
    return false;
  });
  try {
    const res = await GET(srv, `/v1/sessions/${UUID}/events`);
    assert.equal((await res.text()).trimEnd().split('\n').length, 2);
    assert.equal(writes, 2);
    assert.equal(ignored, false, 'wrote while waiting for drain');
  } finally { patched.mock.restore(); await srv.close(); }
});

it('returns 500 for corruption after the first replay batch', async () => {
  const dir = await storeWithSession();
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'),
    Array.from({ length: 700 }, (_, i) =>
      JSON.stringify({ seq: String(i + 1), type: 'test', data: {} }) + '\n').join('')
      + 'broken\n{"seq":"702","type":"test","data":{}}\n');
  const srv = await startReaderServer({ storeDir: dir });
  try { assert.equal((await GET(srv, `/v1/sessions/${UUID}/events`)).status, 500); }
  finally { await srv.close(); }
});

it('keeps history readable when tombstone contents are malformed', async () => {
  const dir = await storeWithSession();
  const srv = await startReaderServer({ storeDir: dir });
  try {
    for (const raw of ['{}', '{"version":2}', '[]', 'true', 'not JSON']) {
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), raw);
      const res = await GET(srv, `/v1/sessions/${UUID}/events`);
      assert.equal(res.status, 200, raw);
      assert.equal((await res.text()).trimEnd().split('\n').length, 2);
    }
  } finally { await srv.close(); }
});

describe('http-reader with a boundary registry', () => {
  it('a reserved session lists durable_seq 0 despite disk records, then tracks health once active', async () => {
    const dir = await storeWithSession();               // disk log has seq 1,2
    const registry = createBoundaryRegistry();
    registry.reserve(UUID);                              // reserved before capture commits
    const srv = await startReaderServer({ storeDir: dir, registry });
    try {
      let body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '0', removed: false }]);
      const health = createHealth(2n);
      registry.activate(UUID, liveBoundary(health));
      body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '2', removed: false }]);
    } finally { await srv.close(); }
  });

  it('falls back to disk high-water for a session the registry never knew', async () => {
    const dir = await storeWithSession();               // disk log has seq 1,2
    const registry = createBoundaryRegistry();          // empty: UUID is daemon-unknown
    const srv = await startReaderServer({ storeDir: dir, registry });
    try {
      const body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '2', removed: false }]);
      const res = await GET(srv, `/v1/sessions/${UUID}/events?after=0`);
      assert.equal(res.status, 200);
      assert.equal((await res.text()).trimEnd().split('\n').length, 2);
    } finally { await srv.close(); }
  });

  it('aborts a live SSE follower when its session freezes (transition)', async () => {
    const dir = await storeWithSession();               // disk log has seq 1,2
    const registry = createBoundaryRegistry();
    const health = createHealth(2n);
    registry.reserve(UUID);
    registry.activate(UUID, liveBoundary(health));
    const srv = await startReaderServer({ storeDir: dir, registry });
    const ac = new AbortController();
    try {
      const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
        headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let acc = ''; const seen: string[] = [];
      while (seen.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        for (const e of sseEvents(acc)) if (e.data && !seen.includes(e.id)) seen.push(e.id);
      }
      assert.deepEqual(seen, ['1', '2']);                // replayed up to the boundary
      registry.freeze(UUID, 2n);                         // detach: transition aborts followers
      // The server destroys the follower's response; the client stream must end
      // (a clean done, or a socket error from the abrupt close — both are "ended").
      const done = (async () => {
        try { for (;;) { const r = await reader.read(); if (r.done) return true; } }
        catch { return true; }
      })();
      const guard = new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('follower was not aborted on freeze')), 4000).unref());
      assert.equal(await Promise.race([done, guard]), true);
    } finally { ac.abort(); await srv.close(); }
  });

  it('a registry entry shadows the active option when both are supplied', async () => {
    const dir = await storeWithSession();
    const registry = createBoundaryRegistry();
    registry.installIfAbsent(UUID, staticBoundary(1n)); // registry says 1
    const health = createHealth(2n);                    // active says 2
    const srv = await startReaderServer({
      storeDir: dir, registry, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    try {
      const body = await (await GET(srv, '/v1/sessions')).json();
      assert.deepEqual(body, [{ id: UUID, durable_seq: '1', removed: false }]);
    } finally { await srv.close(); }
  });
});
