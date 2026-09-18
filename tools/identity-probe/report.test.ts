import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendObservation } from './report.ts';
import type { Observation } from './observe.ts';

const SAMPLE_OBSERVATION: Observation = {
  schema: 'identity-probe-observation.v1',
  captured_at_ms: 1,
  phase: 'startup',
  env: {},
  discovered_env_keys: [],
  process: { cwd: '~', argv: [] },
  initialize: { present: false },
};

test('appendObservation tightens an existing log file to owner-only mode', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-probe-report-'));
  try {
    const logPath = join(dir, 'observations.jsonl');
    await writeFile(logPath, '');
    await chmod(logPath, 0o644);

    await appendObservation(logPath, SAMPLE_OBSERVATION);

    const mode = (await stat(logPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendObservation leaves a pre-existing loose log directory unchanged', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-probe-report-'));
  try {
    await chmod(dir, 0o755);
    const logPath = join(dir, 'observations.jsonl');

    await appendObservation(logPath, SAMPLE_OBSERVATION);

    const dirMode = (await stat(dir)).mode & 0o777;
    const logMode = (await stat(logPath)).mode & 0o777;
    assert.equal(dirMode, 0o755);
    assert.equal(logMode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendObservation tightens a newly-created log directory to owner-only mode', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-probe-report-'));
  try {
    const logDir = join(dir, 'logs');
    const logPath = join(logDir, 'observations.jsonl');

    await appendObservation(logPath, SAMPLE_OBSERVATION);

    const dirMode = (await stat(logDir)).mode & 0o777;
    assert.equal(dirMode, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
