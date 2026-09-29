import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { describeDiagnosticMode, parseDiagnosticArgs, validateDiagnosticConfig } from './fd5-diag.ts';

const proposal = JSON.parse(await readFile(new URL('./fd5-diagnostic-config.json', import.meta.url), 'utf8')) as unknown;

test('bounded diagnostic CLI requires one named mode and an explicit execution switch', () => {
  assert.deepEqual(parseDiagnosticArgs(['--config', 'proposed.json', '--mode', 'smoke', '--describe']),
    { configPath: 'proposed.json', mode: 'smoke', describe: true });
  assert.deepEqual(parseDiagnosticArgs(['--config', 'approved.json', '--mode', 'w-pressure',
    '--out', '/tmp/new.jsonl', '--execute']),
  { configPath: 'approved.json', mode: 'w-pressure', outputPath: '/tmp/new.jsonl', describe: false });
  for (const argv of [
    ['--config', 'x', '--mode', 'smoke'],
    ['--config', 'x', '--mode', 'full', '--describe'],
    ['--config', 'x', '--mode', 'smoke', '--execute'],
    ['--config', 'x', '--mode', 'smoke', '--describe', '--execute'],
    ['--config', 'x', '--mode', 'smoke', '--describe', '--unknown'],
  ]) assert.throws(() => parseDiagnosticArgs(argv));
});

test('configuration pins bounded counts, separate modes and approval fields', () => {
  const config = validateDiagnosticConfig(proposal);
  assert.deepEqual(describeDiagnosticMode(config, 'smoke'), { arms: 2, writes: 28, maxRequests: 128 });
  assert.deepEqual(describeDiagnosticMode(config, 'overhead'), { arms: 8, writes: 1600, maxRequests: 40000 });
  assert.deepEqual(describeDiagnosticMode(config, 'unqueued'), { cells: 7, measured: 350,
    warmups: 2, cacheControlsMaximum: 60, conditionalSwiftMaximum: 150, maxRequests: 562 });
  assert.deepEqual(describeDiagnosticMode(config, 'queue'), { cells: 6, writes: 1200, maxRequests: 30000,
    maxCellSecondsIncludingDrain: 30 });
  assert.deepEqual(describeDiagnosticMode(config, 'w-pressure'), { groups: 40, maxRequests: 200,
    maxSecondsPerCap: 15 });
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), repetitions: 3 }), /unknown/);
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), overhead: {
    ...(proposal as { overhead: object }).overhead, maxArmSeconds: 300,
  } }), /maxArmSeconds/);
  assert.throws(() => validateDiagnosticConfig({ ...(proposal as object), unqueued: {
    ...(proposal as { unqueued: object }).unqueued, maxRequestsIncludingConditional: 563,
  } }), /maxRequestsIncludingConditional/);
});
