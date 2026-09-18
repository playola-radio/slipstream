import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProbeHandlers } from './server.ts';
import { dispatch } from './mcp.ts';
import type { Observation } from './observe.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

test('startup observation is recorded on initialize with client info', async () => {
  const records: Observation[] = [];
  const h = createProbeHandlers({
    logPath: '/unused', env: { CLAUDE_CODE_SESSION_ID: 's-1' }, argv: ['node', 'server.ts'],
    cwd: '/Users/x/w', home: '/Users/x', now: () => 1, append: async (o) => { records.push(o); },
  });
  await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } }, h);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.phase, 'startup');
  assert.deepEqual(records[0]!.env.CLAUDE_CODE_SESSION_ID, { present: true, value: 's-1' });
  assert.equal(records[0]!.initialize.clientInfo?.name, 'claude-code');
});

test('tool call records a tool_call observation carrying _meta and returns text', async () => {
  const records: Observation[] = [];
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 2, append: async (o) => { records.push(o); },
  });
  await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, h);
  const res = await dispatch(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {}, _meta: { threadId: 't-7' } } },
    h,
  );
  const toolRecord = records.find((r) => r.phase === 'tool_call')!;
  assert.equal(toolRecord.tool_call?.toolName, 'identity_probe_snapshot');
  assert.deepEqual(toolRecord.tool_call?.meta, { present: true, value: { threadId: 't-7' } });
  const text = (res?.result as any).content[0].text as string;
  assert.match(text, /identity-probe/);
});

test('tool call with no _meta records explicit absence, not a dropped field', async () => {
  const records: Observation[] = [];
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 7, append: async (o) => { records.push(o); },
  });
  await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {} } },
    h,
  );
  const toolRecord = records.find((r) => r.phase === 'tool_call')!;
  assert.deepEqual(toolRecord.tool_call?.meta, { present: false });
  assert.match(JSON.stringify(toolRecord), /"meta":\{"present":false\}/);
});

test('a rejecting append on startup is reported, not fatal', async () => {
  const appendErrors: unknown[] = [];
  const failure = new Error('EACCES: permission denied');
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 3,
    append: async () => { throw failure; },
    onAppendError: (err) => { appendErrors.push(err); },
  });
  const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, h);
  assert.equal(res?.result && (res.result as any).protocolVersion, '2025-06-18');
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(appendErrors, [failure]);
});

test('hasArguments reports field presence, not content: empty arguments object is still present', async () => {
  const records: Observation[] = [];
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 5, append: async (o) => { records.push(o); },
  });
  await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {} } },
    h,
  );
  const toolRecord = records.find((r) => r.phase === 'tool_call')!;
  assert.equal(toolRecord.tool_call?.hasArguments, true);
});

test('hasArguments is false when the arguments field is absent entirely', async () => {
  const records: Observation[] = [];
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 6, append: async (o) => { records.push(o); },
  });
  await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'identity_probe_snapshot' } },
    h,
  );
  const toolRecord = records.find((r) => r.phase === 'tool_call')!;
  assert.equal(toolRecord.tool_call?.hasArguments, false);
});

test('a rejecting append on tool_call is reported and answered with an error result, not thrown', async () => {
  const appendErrors: unknown[] = [];
  const failure = new Error('EACCES: permission denied');
  const h = createProbeHandlers({
    logPath: '/unused', env: {}, argv: [], cwd: '/Users/x', home: '/Users/x',
    now: () => 4,
    append: async () => { throw failure; },
    onAppendError: (err) => { appendErrors.push(err); },
  });
  const res = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {} } },
    h,
  );
  const result = res?.result as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /identity-probe failed to record snapshot/);
  assert.deepEqual(appendErrors, [failure]);
});

test('the real server binary completes an MCP handshake over stdio', async () => {
  const child = spawn(process.execPath, [join(HERE, 'server.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SLIPSTREAM_IDENTITY_PROBE_LOG: join(process.env.TMPDIR ?? '/tmp', `probe-${process.pid}.jsonl`) },
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  const lines = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const init = lines.find((l) => l.id === 1);
  const list = lines.find((l) => l.id === 2);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(list.result.tools[0].name, 'identity_probe_snapshot');
});
