import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { startDiagnosticLoad } from './fd5-diag-load.ts';

test('bounded load worker streams every clip attempt, never retries overload, and stops at the shared cap', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"skipped","fallback_reason":"overloaded"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const messages: Array<{ type: string; attempt?: { status: string }; summary?: { attemptLimitReached: boolean } }> = [];
  const sharedCount = new SharedArrayBuffer(4);
  const worker = new Worker(new URL('./fd5-diag-load-worker.ts', import.meta.url), { workerData: {
    kind: 'clip', url: `http://127.0.0.1:${address.port}`, token: 'test-token', slots: 2,
    corpus: Array.from({ length: 10 }, (_, i) => ({ sessionId: '11111111-1111-4111-8111-111111111111',
      seq: String(i + 1), key: `unique-${i}` })),
    maxAttempts: 3, sharedCount, minRequestIntervalMs: 0, requestTimeoutMs: 1000,
  } });
  worker.on('message', message => messages.push(message));
  try {
    const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(5_000) });
    assert.equal(code, 0);
    assert.equal(messages.filter(message => message.type === 'attempt').length, 3);
    assert.deepEqual(messages.filter(message => message.type === 'attempt').map(message => message.attempt?.status),
      ['skipped', 'skipped', 'skipped']);
    assert.equal(messages.find(message => message.type === 'summary')?.summary?.attemptLimitReached, true);
    assert.equal(new Int32Array(sharedCount)[0], 3);
  } finally { await worker.terminate(); server.close(); }
});

test('bounded parent retains streamed attempts and verifies actual worker exit', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ready"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const evidence: unknown[] = [];
  let attempted!: () => void;
  const observedAttempt = new Promise<void>(resolve => { attempted = resolve; });
  const client = startDiagnosticLoad({ kind: 'clip', url: `http://127.0.0.1:${address.port}`,
    token: 'test-token', slots: 1, corpus: [{ sessionId: '11111111-1111-4111-8111-111111111111',
      seq: '1', key: 'one' }], maxAttempts: 2, sharedCount: new SharedArrayBuffer(4),
    minRequestIntervalMs: 0, requestTimeoutMs: 1000, onEvidence: value => {
      evidence.push(value);
      if ((value as { type?: string }).type === 'attempt') attempted();
    } });
  try {
    await client.ready;
    await Promise.race([observedAttempt, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('no attempt')), 3000))]);
    const summary = await client.stop();
    assert.equal(summary.actualWorkerExit, true);
    assert.deepEqual(summary.incompleteRequestIds, []);
    assert.equal(evidence.filter(value => (value as { type?: string }).type === 'attempt').length,
      client.attempts.length);
  } finally { server.close(); }
});
