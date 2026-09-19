import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import {
  computeClipProjection,
  resolveClipSide,
  parseClipSnapshot,
  type ClipSnapshot,
} from './clip-blob-reader.ts';

async function withStore(fn: (ctx: {
  storeDir: string;
  put: (s: string) => Promise<ClipSnapshot>;
}) => Promise<void>): Promise<void> {
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-clipstore-'));
  try {
    const cas = await createCas(join(storeDir, 'blobs'));
    const put = async (s: string): Promise<ClipSnapshot> => {
      const buf = Buffer.from(s, 'utf8');
      const ref = await cas.put(buf);
      return { kind: 'content', sha256: ref.sha256, size: ref.size };
    };
    await fn({ storeDir, put });
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

test('parseClipSnapshot accepts valid shapes and rejects malformed', () => {
  assert.deepEqual(parseClipSnapshot({ kind: 'absent' }), { kind: 'absent' });
  assert.deepEqual(parseClipSnapshot({ kind: 'unavailable', reason: 'oversize' }), {
    kind: 'unavailable', reason: 'oversize',
  });
  const hex = 'a'.repeat(64);
  assert.deepEqual(parseClipSnapshot({ kind: 'content', sha256: hex, size: 3 }), {
    kind: 'content', sha256: hex, size: 3,
  });
  assert.equal(parseClipSnapshot(null), null);
  assert.equal(parseClipSnapshot({ kind: 'content', sha256: 'nothex', size: 3 }), null);
  assert.equal(parseClipSnapshot({ kind: 'unavailable' }), null);
});

test('resolveClipSide reads raw bytes for a present blob', async () => {
  await withStore(async ({ storeDir, put }) => {
    const snap = await put('hello\n');
    const side = await resolveClipSide(storeDir, snap, 1024);
    assert.equal(side.kind, 'bytes');
    if (side.kind === 'bytes') assert.equal(Buffer.from(side.bytes).toString('utf8'), 'hello\n');
  });
});

test('resolveClipSide reports a GC\'d blob as missing, never faked', async () => {
  await withStore(async ({ storeDir }) => {
    const snap: ClipSnapshot = { kind: 'content', sha256: 'b'.repeat(64), size: 3 };
    const side = await resolveClipSide(storeDir, snap, 1024);
    assert.equal(side.kind, 'missing');
  });
});

test('resolveClipSide reports oversize without reading', async () => {
  await withStore(async ({ storeDir, put }) => {
    const snap = await put('0123456789');
    const side = await resolveClipSide(storeDir, snap, 4);
    assert.equal(side.kind, 'oversize');
  });
});

test('computeClipProjection produces a fallback edit clip from on-disk blobs', async () => {
  await withStore(async ({ storeDir, put }) => {
    const before = await put('a\nb\nc\n');
    const after = await put('a\nB\nc\n');
    const p = await computeClipProjection({ storeDir, before, after, opts: { changeSeq: '7' } });
    assert.equal(p.status, 'fallback');
    assert.equal(p.change_seq, '7');
    assert.ok(p.clips.length >= 1);
  });
});

test('computeClipProjection returns unavailable when the after blob is gone', async () => {
  await withStore(async ({ storeDir, put }) => {
    const before = await put('a\n');
    const after: ClipSnapshot = { kind: 'content', sha256: 'c'.repeat(64), size: 2 };
    const p = await computeClipProjection({ storeDir, before, after, opts: { changeSeq: '9' } });
    assert.equal(p.status, 'unavailable');
    assert.equal(p.fallback_reason, 'after-missing');
  });
});
