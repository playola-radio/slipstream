import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, publishDescriptor, checkAuth, checkHostOrigin } from './http-security.ts';

describe('http-security', () => {
  it('generateToken returns 64 hex chars', () => {
    assert.match(generateToken(), /^[0-9a-f]{64}$/);
  });

  it('publishDescriptor writes an owner-only json under runtime/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slip-sec-'));
    const path = await publishDescriptor(dir, { url: 'http://127.0.0.1:1/', token: 'abc' });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(parsed, { url: 'http://127.0.0.1:1/', token: 'abc' });
    assert.equal((await stat(path)).mode & 0o077, 0);
  });

  it('checkAuth accepts the exact bearer and rejects others', () => {
    assert.equal(checkAuth('Bearer secrettoken', 'secrettoken'), true);
    assert.equal(checkAuth('Bearer wrong', 'secrettoken'), false);
    assert.equal(checkAuth(undefined, 'secrettoken'), false);
    assert.equal(checkAuth('secrettoken', 'secrettoken'), false); // missing Bearer prefix
  });

  it('checkHostOrigin requires exact host and, if present, exact origin', () => {
    const hp = '127.0.0.1:8787';
    assert.equal(checkHostOrigin({ host: hp }, hp), true);
    assert.equal(checkHostOrigin({ host: hp, origin: `http://${hp}` }, hp), true);
    assert.equal(checkHostOrigin({ host: hp, origin: 'http://evil.test' }, hp), false);
    assert.equal(checkHostOrigin({ host: 'evil.test' }, hp), false);
    assert.equal(checkHostOrigin({ host: [hp, hp] as unknown as string }, hp), false);
    assert.equal(checkHostOrigin({}, hp), false);
  });
});
