import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { defaultDaemonStore, controlSocketPath, resolveStoreDir } from './daemon-location.ts';

test('controlSocketPath places the socket under the store dir', () => {
  assert.equal(controlSocketPath('/home/x/.slipstream'), '/home/x/.slipstream/control.sock');
});

test('defaultDaemonStore is ~/.slipstream for a given home', () => {
  assert.equal(defaultDaemonStore('/home/x'), '/home/x/.slipstream');
});

test('resolveStoreDir defaults to the home store when no --store is given', () => {
  assert.equal(resolveStoreDir([], '/home/x'), join('/home/x', '.slipstream'));
});

test('resolveStoreDir honors an explicit --store, resolved to an absolute path', () => {
  const cwd = process.cwd();
  assert.equal(resolveStoreDir(['--store', '/abs/store'], '/home/x'), '/abs/store');
  assert.equal(resolveStoreDir(['--store', 'rel/store'], '/home/x'), join(cwd, 'rel/store'));
});

test('resolveStoreDir throws when --store has no value', () => {
  assert.throws(() => resolveStoreDir(['--store'], '/home/x'), /--store requires/);
  assert.throws(() => resolveStoreDir(['--store', '--other'], '/home/x'), /--store requires/);
});
