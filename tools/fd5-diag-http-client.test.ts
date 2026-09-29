import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { startDiagnosticHttpClient } from './fd5-diag-http-client.ts';
import type { CorpusPage } from './fd5-bench.ts';

test('isolated on-demand client serves one interface and concurrent clip requests then actually exits', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url?.includes('interfaces') ? '{"status":"ready","files":[]}' : '{"status":"skipped","fallback_reason":"overloaded"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const client = startDiagnosticHttpClient();
  const url = `http://127.0.0.1:${address.port}`;
  const page = { expected: { routeKey: '/v1/sessions/id/interfaces?before_seq=1&after_seq=2', key: 'one' } } as CorpusPage;
  try {
    await client.ready;
    const interfaceResult = await client.interface(url, 'test-token', page, 1000, new AbortController().signal);
    assert.equal(interfaceResult.httpStatus, 200);
    const change = { sessionId: '11111111-1111-4111-8111-111111111111', seq: '2', key: 'same' };
    const clips = await Promise.all(Array.from({ length: 5 }, () =>
      client.clip(url, 'test-token', change, 1000, new AbortController().signal)));
    assert(clips.every(clip => clip.status === 'skipped' && clip.reason === 'overloaded'));
    await client.stop();
  } finally { await client.stop(); server.close(); }
});
