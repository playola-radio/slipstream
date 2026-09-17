import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageError, writeAll } from './storage.ts';

describe('storage', () => {
  describe('writeAll', () => {
    it('loops until the whole buffer is written when writes are short', async () => {
      const chunks: Buffer[] = [];
      const handle = {
        write: async (buf: Buffer, offset: number, length: number) => {
          const bytesWritten = Math.min(3, length);
          chunks.push(Buffer.from(buf.subarray(offset, offset + bytesWritten)));
          return { bytesWritten, buffer: buf };
        },
      };
      await writeAll(handle as never, Buffer.from('abcdefghij'));
      assert.equal(Buffer.concat(chunks).toString(), 'abcdefghij');
      assert.ok(chunks.length >= 4); // 10 bytes at <=3 per call
    });

    it('throws rather than spin when a write makes no progress', async () => {
      const handle = { write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }) };
      await assert.rejects(writeAll(handle as never, Buffer.from('x')), /no progress/);
    });
  });

  describe('StorageError', () => {
    it('carries the underlying errno code and operation', () => {
      const err = new StorageError('write-blob', Object.assign(new Error('nope'), { code: 'ENOSPC' }));
      assert.equal(err.code, 'ENOSPC');
      assert.equal(err.operation, 'write-blob');
      assert.match(err.message, /ENOSPC/);
    });
  });
});
