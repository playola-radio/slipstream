import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureProbeRoots, installProbes, readProbeCounters, resetProbeCounters } from './probes.ts';

test('bytes written through a file handle are counted from the handle call\'s own data argument', async () => {
  const realpathNative = fs.realpath.native;
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFileCustom = (childProcess.execFile as unknown as Record<PropertyKey, unknown>)[custom];
  await installProbes();
  assert.equal(fs.realpath.native, realpathNative);
  assert.equal((childProcess.execFile as unknown as Record<PropertyKey, unknown>)[custom], execFileCustom);
  const store = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'probes-test-')));
  try {
    configureProbeRoots({ worktrees: join(store, 'none-w'), store, transcripts: join(store, 'none-t') });
    resetProbeCounters();
    const handle = await fsp.open(join(store, 'owner.json'), 'w');
    await handle.writeFile('hello');
    await handle.close();
    assert.equal(readProbeCounters().bytesWritten.store, 5);
  } finally {
    await fsp.rm(store, { recursive: true, force: true });
  }
});
