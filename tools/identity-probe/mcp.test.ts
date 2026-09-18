import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, dispatch, type McpHandlers } from './mcp.ts';

function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    serverInfo: { name: 'slipstream-identity-probe', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    tools: [{ name: 'identity_probe_snapshot', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    onInitialize: () => {},
    callTool: async () => ({ text: 'ok' }),
    ...over,
  };
}

test('parseMessage classifies malformed JSON as a parse error', () => {
  const res = parseMessage('not json');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32700);
});

test('parseMessage classifies valid JSON with no method as an invalid request', () => {
  const res = parseMessage('{}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects the wrong jsonrpc version and an object-valued id as invalid request', () => {
  const res = parseMessage('{"jsonrpc":"1.0","id":{},"method":"ping"}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects an object-valued id as invalid request', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":{},"method":"ping"}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage accepts a valid request', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(res.ok, true);
  assert.equal((res as { ok: true; value: { method: string } }).value.method, 'ping');
});

test('parseMessage rejects a non-integer numeric id', () => {
  const res = parseMessage('{"jsonrpc":"2.0","method":"ping","id":1.5}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects an id that overflows to Infinity', () => {
  const res = parseMessage('{"jsonrpc":"2.0","method":"ping","id":1e400}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects a null id', () => {
  const res = parseMessage('{"jsonrpc":"2.0","method":"ping","id":null}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage accepts a string id', () => {
  const res = parseMessage('{"jsonrpc":"2.0","method":"ping","id":"abc"}');
  assert.equal(res.ok, true);
});

test('parseMessage accepts an integer id', () => {
  const res = parseMessage('{"jsonrpc":"2.0","method":"ping","id":7}');
  assert.equal(res.ok, true);
});

test('parseMessage rejects a numeric params value', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":42}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects a string params value on initialize', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":"invalid"}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects a null params value', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":null}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage rejects a boolean params value', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":true}');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32600);
});

test('parseMessage accepts an object params value', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}');
  assert.equal(res.ok, true);
});

test('parseMessage accepts a request with no params', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(res.ok, true);
});

test('parseMessage accepts an array params value', () => {
  const res = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}');
  assert.equal(res.ok, true);
});

test('initialize echoes protocol version, advertises tools, and fires onInitialize', async () => {
  let captured: unknown;
  const res = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } } },
    handlers({ onInitialize: (p) => { captured = p; } }),
  );
  assert.equal(res?.id, 1);
  const result = res?.result as any;
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'slipstream-identity-probe', version: '0.0.0' });
  assert.ok(result.capabilities.tools);
  assert.deepEqual(captured, { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } });
});

test('notifications/initialized yields no response', async () => {
  const res = await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers());
  assert.equal(res, null);
});

test('an id-bearing request to notifications/initialized is not silently swallowed', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 7, method: 'notifications/initialized' }, handlers());
  assert.equal(res?.error?.code, -32601);
  assert.equal(res?.id, 7);
});

test('ping returns empty result', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' }, handlers());
  assert.deepEqual(res, { jsonrpc: '2.0', id: 2, result: {} });
});

test('tools/list returns the registered tool', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, handlers());
  const tools = (res?.result as any).tools;
  assert.equal(tools[0].name, 'identity_probe_snapshot');
});

test('tools/call routes to callTool and wraps text content', async () => {
  const res = await dispatch(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {} } },
    handlers({ callTool: async (name) => ({ text: `called ${name}` }) }),
  );
  const result = res?.result as any;
  assert.deepEqual(result.content, [{ type: 'text', text: 'called identity_probe_snapshot' }]);
  assert.equal(result.isError, false);
});

test('unknown method returns -32601', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 5, method: 'nope' }, handlers());
  assert.equal(res?.error?.code, -32601);
});

test('ping with no id is a notification and yields no response', async () => {
  const res = await dispatch({ jsonrpc: '2.0', method: 'ping' }, handlers());
  assert.equal(res, null);
});

test('tools/call with no id yields no response but still invokes callTool', async () => {
  let called: string | undefined;
  const res = await dispatch(
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'identity_probe_snapshot', arguments: {} } },
    handlers({ callTool: async (name) => { called = name; return { text: 'ok' }; } }),
  );
  assert.equal(res, null);
  assert.equal(called, 'identity_probe_snapshot');
});
