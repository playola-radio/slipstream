import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInterleaving, buildSyntheticPhases, codeHashes, parseProfileArgs, selectClipTraces,
  publishExclusive, validateOutputSize } from './fd5-collector-profile.ts';

const phase = (bucket: number, count = 1) => ({ count,
  buckets: Array.from({ length: 65 }, (_, index) => index === bucket ? count : 0) });

test('profile command requires an explicit execution switch and pinned tool hash', () => {
  assert.deepEqual(parseProfileArgs(['--source', '/tmp/in', '--out', '/tmp/out',
    '--tool-sha256', 'a'.repeat(64), '--head', 'b'.repeat(40), '--execute']),
  { source: '/tmp/in', out: '/tmp/out', toolSha256: 'a'.repeat(64), head: 'b'.repeat(40) });
  for (const args of [
    ['--source', '/tmp/in', '--out', '/tmp/out', '--tool-sha256', 'a'.repeat(64), '--head', 'b'.repeat(40)],
    ['--source', '/tmp/in', '--out', '/tmp/out', '--tool-sha256', 'wrong', '--head', 'b'.repeat(40), '--execute'],
    ['--source', '/tmp/in', '--out', '/tmp/out', '--tool-sha256', 'a'.repeat(64), '--head', 'wrong', '--execute'],
    ['--source', '/tmp/in', '--out', '/tmp/out', '--tool-sha256', 'a'.repeat(64), '--head', 'b'.repeat(40), '--execute', '--extra'],
  ]) assert.throws(() => parseProfileArgs(args));
});

test('profile provenance includes the collector and trace event source', async () => {
  const hashes = await codeHashes();
  for (const name of ['toolSha256', 'collectorSha256', 'traceSourceSha256'] as const)
    assert.match(hashes[name], /^[a-f0-9]{64}$/);
});

test('synthetic duration preserves collector buckets including zero and clamped bucket 64', () => {
  const units = [{ unitId: 7, routeKey: '/synthetic/7' }];
  const phases = buildSyntheticPhases({ 'clip:worker-startup': phase(0),
    'clip:cas-read': phase(64) }, units, 3);
  assert.equal(phases.length, 2);
  assert.equal(phases[0]?.durationNs, 0n);
  assert.equal(phases[1]?.durationNs, 1n << 63n);
  assert.equal(phases[1]?.unitId, 7);
  assert.equal(phases[1]?.processId, 3);
  assert.throws(() => buildSyntheticPhases({ 'clip:cas-read': { count: 2,
    buckets: phase(5).buckets } }, units, 3), /bucket sum/);
});

test('clip trace selection rejects duplicate, absent and unexpected trace records', () => {
  const clip = (cell: string) => ({ type: 'trace', cell, events: [], phases: {}, faults: [] });
  const valid = [clip('overhead-clip-2-on'), clip('overhead-clip-3-on'),
    clip('overhead-interface-2-on'), clip('overhead-interface-3-on')];
  assert.equal(selectClipTraces(valid).length, 2);
  assert.throws(() => selectClipTraces([valid[0]!, valid[0]!, valid[2]!, valid[3]!]), /duplicate/);
  assert.throws(() => selectClipTraces(valid.slice(0, 3)), /four trace records/);
  assert.throws(() => selectClipTraces([...valid, clip('other')]), /four trace records/);
  assert.throws(() => selectClipTraces([...valid.slice(0, 3), clip('other')]), /unexpected trace cells/);
});

test('request grouping places synthetic route phases with the recorded request', () => {
  const routeKey = '/v1/sessions/example/changes/2/clips';
  const events = [
    { kind: 'admission' as const, unitId: 7, routeKey, workload: 'clip' as const,
      disposition: 'running' as const, atNs: 1n },
    { kind: 'parser-request' as const, unitId: 7, atNs: 2n },
  ];
  const synthetic = buildSyntheticPhases({ 'clip:serialization': phase(5) },
    [{ unitId: 7, routeKey }], 3);
  assert.deepEqual(buildInterleaving({ events, synthetic }, 'request-grouped').map(event => event.kind),
    ['admission', 'parser-request', 'phase']);
  assert.deepEqual(buildInterleaving({ events, synthetic }, 'phase-grouped').map(event => event.kind),
    ['admission', 'parser-request', 'phase']);
  assert.throws(() => buildInterleaving({ events: events.slice(1), synthetic }, 'request-grouped'),
    /lacks recorded route/);
});

test('result size is capped before writing', () => {
  assert.equal(validateOutputSize(Buffer.from('{}')), 2);
  assert.throws(() => validateOutputSize(Buffer.alloc(1_048_577)), /1 MiB/);
});

test('private child entry requires a parent token before reading evidence', () => {
  const script = fileURLToPath(new URL('./fd5-collector-profile.ts', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--child', '/does-not-exist', 'a'.repeat(64),
    'b'.repeat(40), 'token'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /private profile child requires parent token/);
});

test('exclusive result publishing does not overwrite an existing artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fd5-collector-publish-'));
  const path = join(dir, 'result.json');
  try {
    await publishExclusive(path, Buffer.from('first'));
    await assert.rejects(publishExclusive(path, Buffer.from('second')), /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), 'first');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
