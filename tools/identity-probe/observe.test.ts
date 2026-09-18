import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureInitialize, buildObservation } from './observe.ts';

test('captureInitialize pulls protocolVersion, clientInfo, and capability keys only', () => {
  const cap = captureInitialize({
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'claude-code', version: '1.2.3' },
    capabilities: { roots: {}, sampling: {} },
  });
  assert.equal(cap.present, true);
  assert.equal(cap.protocolVersion, '2025-06-18');
  assert.deepEqual(cap.clientInfo, { name: 'claude-code', version: '1.2.3' });
  assert.deepEqual(cap.capabilityKeys, ['roots', 'sampling']);
});

test('captureInitialize on garbage returns present:false without throwing', () => {
  assert.deepEqual(captureInitialize(undefined), { present: false });
  assert.deepEqual(captureInitialize('nope'), { present: false });
});

test('buildObservation assembles a redacted startup record', () => {
  const obs = buildObservation({
    phase: 'startup',
    env: { CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PROJECT_DIR: '/Users/x/w', SECRET: 'nope' },
    argv: ['/opt/node', '/Users/x/tools/identity-probe/server.ts'],
    cwd: '/Users/x/w',
    home: '/Users/x',
    nowMs: 1000,
    initialize: { present: true, protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' }, capabilityKeys: [] },
  });
  assert.equal(obs.schema, 'identity-probe-observation.v1');
  assert.equal(obs.phase, 'startup');
  assert.equal(obs.captured_at_ms, 1000);
  assert.deepEqual(obs.env.CLAUDE_CODE_SESSION_ID, { present: true, value: 'sess-1' });
  assert.deepEqual(obs.env.CLAUDE_PROJECT_DIR, { present: true, value: '~/w' });
  assert.equal(obs.process.cwd, '~/w');
  assert.deepEqual(obs.process.argv, ['/opt/node', '~/tools/identity-probe/server.ts']);
  assert.equal(obs.tool_call, undefined);
  // Adversarial: no non-allowlisted value leaks anywhere in the serialized record.
  assert.equal(JSON.stringify(obs).includes('nope'), false);
});

test('buildObservation includes tool_call capture when phase is tool_call', () => {
  const obs = buildObservation({
    phase: 'tool_call',
    env: {}, argv: [], cwd: '/Users/x', home: '/Users/x', nowMs: 2000,
    initialize: { present: false },
    toolCall: {
      present: true,
      toolName: 'identity_probe_snapshot',
      meta: { present: true, value: { threadId: 't-9' } },
      hasArguments: false,
    },
  });
  assert.equal(obs.phase, 'tool_call');
  assert.deepEqual(obs.tool_call, {
    present: true,
    toolName: 'identity_probe_snapshot',
    meta: { present: true, value: { threadId: 't-9' } },
    hasArguments: false,
  });
});
