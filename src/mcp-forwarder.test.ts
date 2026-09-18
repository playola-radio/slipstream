import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForwarderHandlers } from './mcp-forwarder.ts';
import { dispatch, type JsonRpcRequest, type JsonRpcResponse } from './mcp-protocol.ts';
import type { ResponseEnvelope } from './control-protocol.ts';

/** A fake daemon that speaks the control protocol over a unix socket: it records
 * each envelope it receives and replies with a scripted response. */
async function fakeDaemon(
  reply: ResponseEnvelope,
): Promise<{ socketPath: string; received: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fwd-'));
  const socketPath = join(dir, 'control.sock');
  const received: Array<Record<string, unknown>> = [];
  const server: Server = createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        received.push(JSON.parse(line));
        socket.write(JSON.stringify(reply) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const initialize = (clientName: string): JsonRpcRequest => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1' } },
});
const callBeginTask = (args: Record<string, unknown>, meta?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'slipstream_begin_task', arguments: args, ...(meta ? { _meta: meta } : {}) },
});

function resultOf(res: JsonRpcResponse | null): { text: string; isError: boolean; structured?: unknown } {
  assert.ok(res && res.result, 'expected a JSON-RPC result');
  const r = res.result as { content: Array<{ text: string }>; isError: boolean; structuredContent?: unknown };
  return { text: r.content[0]!.text, isError: r.isError, structured: r.structuredContent };
}

const OK: ResponseEnvelope = { v: 1, ok: true, session_id: 'cap-1', task_id: 'task-1', event_id: '7', seq: '7' };

test('Claude: initialize env triple flows through to the daemon and the ok result maps back', async () => {
  const daemon = await fakeDaemon(OK);
  const worktree = await mkdtemp(join(tmpdir(), 'slip-fwd-wt-'));
  try {
    const handlers = createForwarderHandlers({
      socketPath: daemon.socketPath,
      env: { CLAUDE_CODE_SESSION_ID: 'sid-1', CLAUDE_PROJECT_DIR: worktree },
    });
    await dispatch(initialize('claude-code'), handlers);
    const res = resultOf(await dispatch(callBeginTask({ title: 'my task' }), handlers));

    assert.equal(res.isError, false);
    assert.deepEqual(res.structured, { session_id: 'cap-1', task_id: 'task-1', event_id: '7', seq: '7' });
    assert.equal(daemon.received.length, 1);
    const env = daemon.received[0]!;
    assert.equal(env.verb, 'begin_task');
    assert.equal(env.title, 'my task');
    assert.equal(env.harness, 'claude-code');
    assert.equal(env.harness_session_id, 'sid-1');
    assert.equal(env.worktree, await realpath(worktree));
    assert.equal(typeof env.request_id, 'string');
    assert.equal('session_id' in env, false); // the forwarder never attaches
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await daemon.close();
  }
});

test('Codex: per-call _meta identity flows through to the daemon', async () => {
  const daemon = await fakeDaemon(OK);
  try {
    const handlers = createForwarderHandlers({ socketPath: daemon.socketPath, env: {} });
    await dispatch(initialize('codex-mcp-client'), handlers);
    const meta = {
      threadId: 'thread-9',
      'x-codex-turn-metadata': { workspaces: { '/repos/edinburgh-v1': { role: 'primary' } } },
    };
    const res = resultOf(await dispatch(callBeginTask({ title: 'codex task' }, meta), handlers));

    assert.equal(res.isError, false);
    const env = daemon.received[0]!;
    assert.equal(env.harness, 'codex');
    assert.equal(env.harness_session_id, 'thread-9');
    assert.equal(env.worktree, '/repos/edinburgh-v1');
  } finally {
    await daemon.close();
  }
});

test('an unrecognized client fails closed as IDENTITY_UNRESOLVED without contacting the daemon', async () => {
  const daemon = await fakeDaemon(OK);
  try {
    const handlers = createForwarderHandlers({ socketPath: daemon.socketPath, env: {} });
    await dispatch(initialize('some-other-client'), handlers);
    const res = resultOf(await dispatch(callBeginTask({ title: 't' }), handlers));

    assert.equal(res.isError, true);
    assert.match(res.text, /IDENTITY_UNRESOLVED/);
    assert.equal(daemon.received.length, 0);
  } finally {
    await daemon.close();
  }
});

test('a down daemon fails fast as DAEMON_UNAVAILABLE rather than hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fwd-down-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-fwd-wt-'));
  try {
    const handlers = createForwarderHandlers({
      socketPath: join(dir, 'control.sock'), // nothing is listening here
      env: { CLAUDE_CODE_SESSION_ID: 'sid-1', CLAUDE_PROJECT_DIR: worktree },
    });
    await dispatch(initialize('claude-code'), handlers);
    const started = Date.now();
    const res = resultOf(await dispatch(callBeginTask({ title: 't' }), handlers));
    const elapsed = Date.now() - started;

    assert.equal(res.isError, true);
    assert.match(res.text, /DAEMON_UNAVAILABLE/);
    assert.ok(elapsed < 1500, `expected a fast fail, took ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});
