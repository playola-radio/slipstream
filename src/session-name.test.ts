import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readNaming, writeNaming } from './session-name.ts';
import { namePath } from './store-reader.ts';
import { StorageError } from './storage.ts';
import { withTempDir } from './test/helpers.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const NOOP = () => {};

async function sessionDir(store: string): Promise<string> {
  const dir = dirname(namePath(store, ID));
  await mkdir(dir, { recursive: true });
  return dir;
}

test('missing file reads as two nulls', async () => {
  await withTempDir(async (store) => {
    await sessionDir(store);
    assert.deepEqual(await readNaming(store, ID), { naming: { agent_name: null, user_name: null } });
  });
});

test('round-trips both fields', async () => {
  await withTempDir(async (store) => {
    await sessionDir(store);
    const naming = { agent_name: 'Workspace rename menu', user_name: 'Sidebar polling' };
    await writeNaming(store, ID, naming, NOOP);
    assert.deepEqual(await readNaming(store, ID), { naming });
  });
});

test('malformed file reads as nulls with a reason', async () => {
  const bodies = [
    'not json',
    '{"version":2,"agent_name":null,"user_name":null}',
    '{"version":1,"agent_name":null}',
    '{"version":1,"agent_name":7,"user_name":null}',
  ];
  await withTempDir(async (store) => {
    await sessionDir(store);
    for (const body of bodies) {
      await writeFile(namePath(store, ID), body);
      const read = await readNaming(store, ID);
      assert.deepEqual(read.naming, { agent_name: null, user_name: null }, body);
      assert.equal(typeof read.malformed, 'string', body);
    }
  });
});

test('assertOwnership throwing leaves no name.json and no temp file', async () => {
  await withTempDir(async (store) => {
    const dir = await sessionDir(store);
    const before = await readdir(dir);
    const lost = new Error('lock lost');
    await assert.rejects(
      writeNaming(store, ID, { agent_name: 'A name', user_name: null }, () => { throw lost; }),
      (err) => err === lost,
    );
    assert.deepEqual(await readdir(dir), before);
  });
});

test('write into a missing session directory throws StorageError', async () => {
  await withTempDir(async (store) => {
    await assert.rejects(
      writeNaming(store, ID, { agent_name: 'A name', user_name: null }, NOOP),
      StorageError,
    );
  });
});

test('file mode is 0600', async () => {
  await withTempDir(async (store) => {
    await sessionDir(store);
    await writeNaming(store, ID, { agent_name: null, user_name: null }, NOOP);
    assert.equal((await stat(namePath(store, ID))).mode & 0o777, 0o600);
  });
});
