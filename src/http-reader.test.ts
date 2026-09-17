import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReaderServer, type ReaderServer } from './http-reader.ts';

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
