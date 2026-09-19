import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import type { ClipSnapshot } from './clip-blob-reader.ts';
import type { ClipWorkerRequest, ClipWorkerResponse } from './clip-projection-worker.ts';

// Proves the projection genuinely computes on a separate thread against on-disk
// blobs — the isolation the cold-cache protection relies on.
test('worker computes a projection off-thread from on-disk blobs', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-clipwrk-'));
  const worker = new Worker(new URL('./clip-projection-worker.ts', import.meta.url));
  try {
    const cas = await createCas(join(storeDir, 'blobs'));
    const beforeRef = await cas.put(Buffer.from('a\nb\nc\n', 'utf8'));
    const afterRef = await cas.put(Buffer.from('a\nB\nc\n', 'utf8'));
    const before: ClipSnapshot = { kind: 'content', sha256: beforeRef.sha256, size: beforeRef.size };
    const after: ClipSnapshot = { kind: 'content', sha256: afterRef.sha256, size: afterRef.size };

    assert.notEqual(worker.threadId, 0); // a real, distinct thread

    const result = await new Promise<ClipWorkerResponse>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      const req: ClipWorkerRequest = { id: 1, job: { storeDir, before, after, opts: { changeSeq: '3' } } };
      worker.postMessage(req);
    });

    assert.equal(result.id, 1);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.result.status, 'fallback');
      assert.equal(result.result.change_seq, '3');
      assert.ok(result.result.clips.length >= 1);
    }
  } finally {
    await worker.terminate();
    await rm(storeDir, { recursive: true, force: true });
  }
});
