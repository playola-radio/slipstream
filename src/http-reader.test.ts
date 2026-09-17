import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReaderServer, type ReaderServer } from './http-reader.ts';
import { createCas } from './cas.ts';
import { createHealth } from './health.ts';

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

  it('serves a known schema verbatim and 404 on an unknown type', async () => {
    const res = await GET(srv, '/v1/schemas/slipstream.file.changed.v1');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { properties: { type: { const: string } } };
    assert.equal(body.properties.type.const, 'slipstream.file.changed.v1');
    assert.equal((await GET(srv, '/v1/schemas/nope.v1')).status, 404);
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
});
