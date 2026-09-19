import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

test('unsupported and missing content remain readable when the parser cannot initialize', async () => {
  await withStore(async ({ storeDir, put }) => {
    const before = await put('old\n');
    const after = await put('new\n');
    const missing: ClipSnapshot = { kind: 'content', sha256: 'f'.repeat(64), size: 4 };
    // A fresh process makes the missing parser dependency deterministic, rather
    // than testing startup speed or depending on a previous module import.
    const script = `
      import { registerHooks } from 'node:module';
      import { computeClipProjection } from ${JSON.stringify(new URL('./clip-blob-reader.ts', import.meta.url).href)};
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.endsWith('clip-function-parser.ts')) throw new Error('parser unavailable');
        return next(specifier, context);
      }});
      const results = [];
      for (const job of JSON.parse(process.argv[1])) results.push(await computeClipProjection(job));
      console.log(JSON.stringify(results));
    `;
    const jobs = [
      { storeDir, before, after, opts: { changeSeq: '1', language: 'unsupported' } },
      { storeDir, before: missing, after: missing, opts: { changeSeq: '2', language: 'typescript' } },
    ];
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', script, JSON.stringify(jobs)], { timeout: 15_000 });
    const [unsupported, unavailable] = JSON.parse(stdout);
    assert.equal(unsupported.status, 'fallback');
    assert.equal(unsupported.fallback_reason, 'unsupported-language');
    assert.ok(unsupported.clips.length > 0);
    assert.equal(unavailable.status, 'unavailable');
    assert.ok(unavailable.fallback_reason);
  });
});

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
