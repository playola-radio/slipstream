import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions, readTombstone, isValidSessionId, isValidHex,
  schemaBytes, onDiskHighWater, blobPath, sessionLogPath, readRuntimeDescriptor,
} from './store-reader.ts';
import { LogCorruptError } from './log-reader.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-store-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  return dir;
}

describe('store-reader', () => {
  describe('isValidSessionId', () => {
    it('accepts a v4 uuid and rejects traversal', () => {
      assert.equal(isValidSessionId(UUID), true);
      assert.equal(isValidSessionId('../etc'), false);
      assert.equal(isValidSessionId('foo/bar'), false);
    });
  });

  describe('isValidHex', () => {
    it('accepts lowercase 64-hex and rejects uppercase or wrong length', () => {
      assert.equal(isValidHex('a'.repeat(64)), true);
      assert.equal(isValidHex('A'.repeat(64)), false);
      assert.equal(isValidHex('a'.repeat(63)), false);
    });
  });

  describe('onDiskHighWater', () => {
    it('returns the seq of the last complete line and ignores a torn trailing line', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":"1"}\n{"seq":"2"}\n{"seq":"3"', 'utf8');
      assert.equal(await onDiskHighWater(log), 2n);
    });
    it('returns 0n for an empty or missing log', async () => {
      const dir = await store();
      assert.equal(await onDiskHighWater(sessionLogPath(dir, UUID)), 0n);
    });
    it('returns the true high-water for a clean seq-only log', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":"1"}\n{"seq":"2"}\n', 'utf8');
      assert.equal(await onDiskHighWater(log), 2n);
    });
    it('returns 0n for a genuinely empty (zero-byte) log', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '', 'utf8');
      assert.equal(await onDiskHighWater(log), 0n);
    });
    it('throws on an extra trailing newline (blank final line)', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":"1"}\n\n', 'utf8');
      await assert.rejects(() => onDiskHighWater(log), LogCorruptError);
    });
    it('throws on a bare-newline-only log', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '\n', 'utf8');
      await assert.rejects(() => onDiskHighWater(log), LogCorruptError);
    });
    it('throws on a final {} record with no seq', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":"1"}\n{}\n', 'utf8');
      await assert.rejects(() => onDiskHighWater(log), LogCorruptError);
    });
    it('throws on a numeric (non-string) seq', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":9007199254740993}\n', 'utf8');
      await assert.rejects(() => onDiskHighWater(log), LogCorruptError);
    });
  });

  describe('listSessions', () => {
    it('lists session ids with on-disk high-water and removed=false', async () => {
      const dir = await store();
      await writeFile(sessionLogPath(dir, UUID), '{"seq":"1"}\n{"seq":"2"}\n', 'utf8');
      const sessions = await listSessions(dir);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.id, UUID);
      assert.equal(sessions[0]!.durableSeq, 2n);
      assert.equal(sessions[0]!.removed, false);
    });
    it('marks a tombstoned session removed', async () => {
      const dir = await store();
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      const sessions = await listSessions(dir);
      assert.equal(sessions[0]!.removed, true);
    });

    it('reports durableSeq 0 for a removed session with a corrupt residual log', async () => {
      // A delete interrupted between tombstone and cleanup can leave a corrupt log
      // under a durable tombstone; reading its high-water must not break listing.
      const dir = await store();
      await writeFile(sessionLogPath(dir, UUID), 'not json at all\n', 'utf8');
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      assert.deepEqual(await listSessions(dir), [{ id: UUID, durableSeq: 0n, removed: true }]);
    });
  });

  describe('readTombstone', () => {
    it('returns null when absent and the parsed marker when present', async () => {
      const dir = await store();
      assert.equal(await readTombstone(dir, UUID), null);
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      assert.deepEqual(await readTombstone(dir, UUID), { version: 1 });
    });
  });

  describe('schemaBytes', () => {
    it('returns bytes for a known type and null for an unknown type', async () => {
      const known = await schemaBytes('slipstream.file.changed.v1');
      assert.ok(known && known.length > 0);
      assert.equal(await schemaBytes('nope.v1'), null);
      assert.equal(await schemaBytes('../secret'), null);
    });
  });

  describe('blobPath', () => {
    it('builds the sharded CAS path under the store', () => {
      const hex = 'ab' + '0'.repeat(62);
      assert.equal(blobPath('/s', hex), join('/s', 'blobs', 'sha256', 'ab', hex));
    });
  });

  describe('readRuntimeDescriptor', () => {
    it('returns null when the runtime dir is missing', async () => {
      const dir = await store();
      assert.equal(await readRuntimeDescriptor(dir), null);
    });

    it('returns null when runtime/ has only non-.json files', async () => {
      const dir = await store();
      await mkdir(join(dir, 'runtime'), { recursive: true });
      await writeFile(join(dir, 'runtime', 'notes.txt'), 'not json', 'utf8');
      assert.equal(await readRuntimeDescriptor(dir), null);
    });

    it('returns the parsed descriptor for a single file', async () => {
      const dir = await store();
      await mkdir(join(dir, 'runtime'), { recursive: true });
      await writeFile(
        join(dir, 'runtime', 'a.json'),
        JSON.stringify({ url: 'http://127.0.0.1:1234', token: 'tok-a' }),
        { mode: 0o600 },
      );
      assert.deepEqual(await readRuntimeDescriptor(dir), { url: 'http://127.0.0.1:1234', token: 'tok-a' });
    });

    it('picks the newest descriptor by mtime when two exist', async () => {
      const dir = await store();
      await mkdir(join(dir, 'runtime'), { recursive: true });
      const older = join(dir, 'runtime', 'a.json');
      const newer = join(dir, 'runtime', 'b.json');
      await writeFile(older, JSON.stringify({ url: 'http://localhost:1234', token: 'tok-old' }), { mode: 0o600 });
      await writeFile(newer, JSON.stringify({ url: 'http://[::1]:1234', token: 'tok-new' }), { mode: 0o600 });
      const past = new Date(Date.now() - 60_000);
      const now = new Date();
      await utimes(older, past, past);
      await utimes(newer, now, now);
      assert.deepEqual(await readRuntimeDescriptor(dir), { url: 'http://[::1]:1234', token: 'tok-new' });
    });
  });
});

for (const raw of ['{}', '{"version":2}', '[]', 'true', 'not JSON']) {
  it(`does not hide history for malformed tombstone ${raw}`, async () => {
    const dir = await store();
    await writeFile(sessionLogPath(dir, UUID), '{"seq":"1"}\n');
    await writeFile(join(dir, 'sessions', UUID, 'removed.json'), raw);
    assert.equal(await readTombstone(dir, UUID), null);
    assert.deepEqual(await listSessions(dir), [{ id: UUID, durableSeq: 1n, removed: false }]);
  });
}

for (const raw of ['{}', 'null', '[]', 'true', 'broken',
  '{"url":3,"token":"secret"}', '{"url":"http://localhost","token":4}',
  ...['https://localhost', 'http://example.com', 'http://localhost.evil.test',
    'http://127.0.0.1/path', 'http://user:pass@localhost', 'http://localhost?x=1',
    'http://localhost#x'].map(url => JSON.stringify({ url, token: 'secret' }))]) {
  it(`skips unusable runtime descriptor ${raw}`, async () => {
    const dir = await store();
    await mkdir(join(dir, 'runtime'));
    const good = { url: 'http://127.0.0.1:1234', token: 'good' };
    const path = join(dir, 'runtime', 'good.json');
    await writeFile(path, JSON.stringify(good), { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
    await writeFile(join(dir, 'runtime', 'bad.json'), raw, { mode: 0o600 });
    assert.deepEqual(await readRuntimeDescriptor(dir), good);
  });
}

it('rejects accessible descriptors, directories and symlinks', async () => {
  const dir = await store();
  await mkdir(join(dir, 'runtime'));
  const path = join(dir, 'runtime', 'a.json');
  await writeFile(path, JSON.stringify({ url: 'http://localhost', token: 'secret' }));
  await chmod(path, 0o640);
  await mkdir(join(dir, 'runtime', 'directory.json'));
  const target = join(dir, 'private');
  await writeFile(target, JSON.stringify({ url: 'http://localhost', token: 'secret' }), { mode: 0o600 });
  await symlink(target, join(dir, 'runtime', 'link.json'));
  await symlink(join(dir, 'missing'), join(dir, 'runtime', 'stale.json'));
  assert.equal(await readRuntimeDescriptor(dir), null);
});

it('finds a large log high-water without a whole-file read', async () => {
  const { mock } = await import('node:test');
  const fs = (await import('node:fs/promises')).default;
  const dir = await store();
  const log = sessionLogPath(dir, UUID);
  await writeFile(log, Array.from({ length: 4000 }, (_, i) =>
    JSON.stringify({ seq: String(i + 1), padding: 'x'.repeat(100) }) + '\n').join('') + 'torn'.repeat(20000));
  const { syncBuiltinESMExports } = await import('node:module');
  const spy = mock.method(fs, 'readFile');
  syncBuiltinESMExports();
  try {
    assert.equal(await onDiskHighWater(log), 4000n);
    assert.equal(spy.mock.callCount(), 0, 'high-water must not buffer the whole log');
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});
