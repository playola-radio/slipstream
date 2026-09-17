import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions, readTombstone, isValidSessionId, isValidHex,
  schemaBytes, onDiskHighWater, blobPath, sessionLogPath,
} from './store-reader.ts';

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
});
