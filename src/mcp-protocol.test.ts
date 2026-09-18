import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, dispatch, type McpHandlers } from './mcp-protocol.ts';

function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    serverInfo: { name: 'slipstream-forwarder', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    tools: [{ name: 'slipstream_begin_task', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    onInitialize: () => {},
    callTool: async () => ({ text: 'ok' }),
    ...over,
  };
}

test('parseMessage classifies malformed JSON as a parse error (-32700)', () => {
  const res = parseMessage('not json');
  assert.equal(res.ok, false);
  assert.equal((res as { ok: false; code: number }).code, -32700);
});

test('parseMessage classifies a valid-JSON bad envelope as invalid request (-32600)', () => {
  for (const line of [
    '{}',
    '{"jsonrpc":"1.0","method":"ping"}',
    '{"jsonrpc":"2.0","id":{},"method":"ping"}',
    '{"jsonrpc":"2.0","method":"ping","id":1.5}',
    '{"jsonrpc":"2.0","method":"ping","id":null}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","params":42}',
  ]) {
    const res = parseMessage(line);
    assert.equal(res.ok, false, `expected ${line} to be rejected`);
    assert.equal((res as { ok: false; code: number }).code, -32600);
  }
});

test('parseMessage accepts well-formed requests (string/int id, object/array/absent params)', () => {
  for (const line of [
    '{"jsonrpc":"2.0","id":"abc","method":"ping"}',
    '{"jsonrpc":"2.0","id":7,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"x"}}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}',
    '{"jsonrpc":"2.0","method":"ping"}',
  ]) {
    assert.equal(parseMessage(line).ok, true, `expected ${line} to parse`);
  }
});

test('initialize echoes protocol version, advertises tools, and fires onInitialize', async () => {
  let captured: unknown;
  const res = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } },
    handlers({ onInitialize: (p) => { captured = p; } }),
  );
  const result = res?.result as any;
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'slipstream-forwarder', version: '0.0.0' });
  assert.ok(result.capabilities.tools);
  assert.deepEqual(captured, { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } });
});

test('ping returns an empty result', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' }, handlers());
  assert.deepEqual(res, { jsonrpc: '2.0', id: 2, result: {} });
});

test('tools/list returns the registered tool', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, handlers());
  assert.equal((res?.result as any).tools[0].name, 'slipstream_begin_task');
});

test('a notification (no id) yields no response but still runs the handler', async () => {
  let called = false;
  const res = await dispatch(
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'slipstream_begin_task', arguments: {} } },
    handlers({ callTool: async () => { called = true; return { text: 'ok' }; } }),
  );
  assert.equal(res, null);
  assert.equal(called, true);
});

test('an id-bearing unknown method returns -32601', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 5, method: 'nope' }, handlers());
  assert.equal(res?.error?.code, -32601);
  assert.equal(res?.id, 5);
});

test('tools/call with a missing name returns -32602', async () => {
  const res = await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { arguments: {} } }, handlers());
  assert.equal(res?.error?.code, -32602);
});

test('tools/call for an unknown tool returns -32602', async () => {
  const res = await dispatch(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } },
    handlers(),
  );
  assert.equal(res?.error?.code, -32602);
});

test('tools/call wraps text content and defaults isError false', async () => {
  const res = await dispatch(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'slipstream_begin_task', arguments: {} } },
    handlers({ callTool: async () => ({ text: 'declared' }) }),
  );
  const result = res?.result as any;
  assert.deepEqual(result.content, [{ type: 'text', text: 'declared' }]);
  assert.equal(result.isError, false);
  assert.equal('structuredContent' in result, false);
});

test('tools/call surfaces structured content and an isError flag', async () => {
  const structured = { session_id: 's', task_id: 't', event_id: 'e', seq: '5' };
  const res = await dispatch(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slipstream_begin_task', arguments: { title: 'x' } } },
    handlers({ callTool: async () => ({ text: 'declared', structured }) }),
  );
  const result = res?.result as any;
  assert.deepEqual(result.structuredContent, structured);
  assert.equal(result.isError, false);
});

test('tools/call propagates a domain error as an isError result, not a JSON-RPC error', async () => {
  const res = await dispatch(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'slipstream_begin_task', arguments: {} } },
    handlers({ callTool: async () => ({ text: 'SESSION_NOT_SELECTED: not selected', isError: true }) }),
  );
  const result = res?.result as any;
  assert.equal(result.isError, true);
  assert.equal(res?.error, undefined);
  assert.deepEqual(result.content, [{ type: 'text', text: 'SESSION_NOT_SELECTED: not selected' }]);
});
