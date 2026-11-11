import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN_TASK_TOOL, createForwarderHandlers, createStdinFramer, type StdinFrame } from './mcp-forwarder.ts';
import { dispatch, type JsonRpcRequest, type JsonRpcResponse } from './mcp-protocol.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import { thisBuild } from './daemon-version.ts';
import { thisBuildDaemon } from './test/helpers.ts';

/** A fake daemon that speaks the control protocol over a unix socket: it records
 * each envelope it receives and replies with a scripted response. */
async function fakeDaemon(
  reply: ResponseEnvelope,
): Promise<{ socketPath: string; received: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fwd-'));
  const socketPath = join(dir, 'control.sock');
  const received: Array<Record<string, unknown>> = [];
  const server: Server = createServer(thisBuildDaemon((socket) => {
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
  }));
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

test('an older daemon gets no task, and the tool says which versions differ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fwd-old-'));
  const verbs: string[] = [];
  const server = createServer((socket) => socket.once('data', (chunk) => {
    verbs.push((JSON.parse(chunk.toString()) as { verb: string }).verb);
    socket.end(JSON.stringify({ v: 1, ok: true }) + '\n');
  }));
  await new Promise<void>((resolve) => server.listen(join(dir, 'control.sock'), resolve));
  try {
    const handlers = createForwarderHandlers({ socketPath: join(dir, 'control.sock'), env: {} });
    await dispatch(initialize('codex-mcp-client'), handlers);
    const res = resultOf(await dispatch(callBeginTask({ title: 't' }, { threadId: 'thread-9',
      'x-codex-turn-metadata': { workspaces: { '/repos/w': { role: 'primary' } } } }), handlers));

    assert.equal(res.isError, true);
    assert.match(res.text, /DAEMON_VERSION_MISMATCH/);
    assert.match(res.text, /is an older version/);
    assert.deepEqual(verbs, ['status']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
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

test('lists the task, answer and name tools', async () => {
  const handlers = createForwarderHandlers({ socketPath: '/nonexistent/control.sock', env: {} });
  const res = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, handlers);
  const tools = (res!.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map(t => t.name), ['slipstream_begin_task', 'slipstream_answer_question', 'slipstream_name_workspace']);
});

test('begin_task tells the agent when to name the workspace', () => {
  assert.ok(BEGIN_TASK_TOOL.description.endsWith(' Once you know what this workspace\'s work is about, also call '
    + 'slipstream_name_workspace with a 2-5 word name \u2014 usually on your first task.'));
});

const callName = (args: Record<string, unknown>, meta: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slipstream_name_workspace', arguments: args, _meta: meta },
});

test('the name tool forwards its raw arguments and the caller identity', async () => {
  const daemon = await fakeDaemon({ v: 1, ok: true, changed: true });
  try {
    const handlers = createForwarderHandlers({ socketPath: daemon.socketPath, env: {} });
    await dispatch(initialize('codex-mcp-client'), handlers);
    const res = resultOf(await dispatch(callName({ name: 7, replace_existing: 'yes' }, CODEX_META), handlers));
    assert.deepEqual(res, { text: 'Agent name saved.', isError: false, structured: { changed: true } });
    assert.deepEqual(daemon.received, [{ v: 1, verb: 'name_workspace', name: 7, replace_existing: 'yes',
      harness: 'codex', harness_session_id: 'thread-9', worktree: '/repos/edinburgh-v1' }]);
  } finally {
    await daemon.close();
  }
});

const callAnswer = (args: Record<string, unknown>, meta: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'slipstream_answer_question', arguments: args, _meta: meta },
});
const CODEX_META = { threadId: 'thread-9', 'x-codex-turn-metadata': { workspaces: { '/repos/edinburgh-v1': { role: 'primary' } } } };
const QUESTION = '11111111-1111-4111-8111-111111111111';

test('the answer tool forwards the question id, verbatim text, and caller identity', async () => {
  const ack = { session_id: 'cap-1', question_id: QUESTION, event_id: '8', seq: '8', answered_at_ms: 5, duplicate: false };
  const daemon = await fakeDaemon({ v: 1, ok: true, ...ack });
  try {
    const handlers = createForwarderHandlers({ socketPath: daemon.socketPath, env: {} });
    await dispatch(initialize('codex-mcp-client'), handlers);
    const res = resultOf(await dispatch(callAnswer({ question_id: QUESTION, text: '  exact\n' }, CODEX_META), handlers));
    assert.deepEqual(res, { text: `Answer recorded for question ${QUESTION} (seq 8).`, isError: false, structured: ack });
    assert.deepEqual(daemon.received, [{ v: 1, verb: 'answer_question', question_id: QUESTION, text: '  exact\n',
      harness: 'codex', harness_session_id: 'thread-9', worktree: '/repos/edinburgh-v1' }]);
  } finally {
    await daemon.close();
  }
});

test('an unreachable daemon records nothing and reports DAEMON_UNAVAILABLE', async () => {
  const handlers = createForwarderHandlers({ socketPath: join(tmpdir(), 'slip-missing', 'control.sock'), env: {} });
  await dispatch(initialize('codex-mcp-client'), handlers);
  const res = resultOf(await dispatch(callAnswer({ question_id: QUESTION, text: 'x' }, CODEX_META), handlers));
  assert.equal(res.isError, true);
  assert.deepEqual(res.structured, { code: 'DAEMON_UNAVAILABLE' });
  assert.match(res.text, /^DAEMON_UNAVAILABLE: /);
});

// ---- stdin framing (bounded) -----------------------------------------------

const linesOf = (frames: StdinFrame[]): string[] =>
  frames.flatMap((f) => ('line' in f ? [f.line] : []));

test('framer yields multiple newline-delimited messages from one chunk, skipping blanks', () => {
  const framer = createStdinFramer(1024);
  const frames = framer.push(Buffer.from('{"a":1}\n\n{"b":2}\n', 'utf8'));
  assert.deepEqual(linesOf(frames), ['{"a":1}', '{"b":2}']);
});

test('framer reassembles a message split across chunks', () => {
  const framer = createStdinFramer(1024);
  assert.deepEqual(linesOf(framer.push(Buffer.from('{"a":', 'utf8'))), []);
  assert.deepEqual(linesOf(framer.push(Buffer.from('1}\n', 'utf8'))), ['{"a":1}']);
});

test('framer drops an over-cap line as overflow and stays bounded, then recovers', () => {
  const framer = createStdinFramer(8);
  // A single unterminated line far past the cap arrives in pieces: exactly one
  // overflow is reported and the buffer never accumulates it.
  let overflows = 0;
  for (let i = 0; i < 1000; i++) {
    for (const f of framer.push(Buffer.from('x'.repeat(64), 'utf8'))) {
      if ('overflow' in f) overflows++;
    }
  }
  assert.equal(overflows, 1);
  // The newline ends the discarded giant line; a following small message parses.
  const frames = framer.push(Buffer.from('\n{"ok":1}\n', 'utf8'));
  assert.deepEqual(linesOf(frames), ['{"ok":1}']);
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

/** A daemon too old to report its build, so every gated call is a mismatch. */
async function olderDaemon(): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fwd-old-'));
  const server = createServer((socket) => socket.once('data', () => socket.end(JSON.stringify({ v: 1, ok: true }) + '\n')));
  const socketPath = join(dir, 'control.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, close: async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  } };
}

const UNREAD = '{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n{"jsonrpc":"2.0",';

function appForwarder(socketPath: string, currentBuild: string | null, env: Record<string, string> = { SLIPSTREAM_APP_RUNTIME: '/rt' }) {
  const execs: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const handlers = createForwarderHandlers({
    socketPath, env,
    execve: (file, args, env) => { execs.push({ file, args, env }); },
    readCurrentBuild: async (root) => (root === '/rt' ? currentBuild : null),
    unreadInput: () => Buffer.from(UNREAD),
  });
  return { handlers, execs };
}

test('forwarderReplacesItselfOnNewerBuild', async () => {
  const daemon = await olderDaemon();
  try {
    const { handlers, execs } = appForwarder(daemon.socketPath, 'a-newer-build');
    await dispatch(initialize('codex-mcp-client'), handlers);
    await dispatch(callBeginTask({ title: 't' }, CODEX_META), handlers);

    assert.equal(execs.length, 1);
    const [exec] = execs;
    assert.equal(exec!.file, '/rt/bin/slipstream-mcp');
    assert.deepEqual(exec!.args, ['/rt/bin/slipstream-mcp', ...process.argv.slice(2)]);
    assert.equal(exec!.env.SLIPSTREAM_APP_RUNTIME, '/rt');
    const replay = JSON.parse(Buffer.from(exec!.env.SLIPSTREAM_MCP_REPLAY!, 'base64').toString('utf8'));
    assert.deepEqual({
      initialize: replay.initialize,
      call: replay.call,
      input: replay.input,
    }, {
      initialize: { jsonrpc: '2.0', method: 'initialize', params: initialize('codex-mcp-client').params },
      call: callBeginTask({ title: 't' }, CODEX_META),
      input: Buffer.from(UNREAD).toString('base64'),
    });
    assert.match(replay.requestId, /^[0-9a-f-]{36}$/);
  } finally {
    await daemon.close();
  }
});

test('a name call on a newer build takes the same replace path', async () => {
  const daemon = await olderDaemon();
  try {
    const { handlers, execs } = appForwarder(daemon.socketPath, 'a-newer-build');
    await dispatch(initialize('codex-mcp-client'), handlers);
    await dispatch(callName({ name: 'Workspace rename menu' }, CODEX_META), handlers);

    assert.equal(execs.length, 1);
    const replay = JSON.parse(Buffer.from(execs[0]!.env.SLIPSTREAM_MCP_REPLAY!, 'base64').toString('utf8'));
    assert.deepEqual(replay.call, callName({ name: 'Workspace rename menu' }, CODEX_META));
    assert.equal('requestId' in replay, false);
  } finally {
    await daemon.close();
  }
});

test('forwarderDoesNotReplaceOnSameBuild', async () => {
  const daemon = await olderDaemon();
  try {
    const { handlers, execs } = appForwarder(daemon.socketPath, (await thisBuild()).build);
    await dispatch(initialize('codex-mcp-client'), handlers);
    const res = resultOf(await dispatch(callBeginTask({ title: 't' }, CODEX_META), handlers));

    assert.equal(execs.length, 0);
    assert.equal(res.isError, true);
    assert.match(res.text, /DAEMON_VERSION_MISMATCH/);
  } finally {
    await daemon.close();
  }
});

test('forwarder snapshots unread input only after flushing output', async () => {
  const daemon = await olderDaemon();
  try {
    const order: string[] = [];
    const handlers = createForwarderHandlers({
      socketPath: daemon.socketPath,
      env: { SLIPSTREAM_APP_RUNTIME: '/rt' },
      readCurrentBuild: async () => 'a-newer-build',
      flushOutput: async () => { order.push('flush'); },
      unreadInput: () => { order.push('input'); return Buffer.alloc(0); },
      execve: () => { order.push('exec'); },
    });
    await dispatch(initialize('codex-mcp-client'), handlers);
    await dispatch(callBeginTask({ title: 't' }, CODEX_META), handlers);

    assert.deepEqual(order, ['flush', 'input', 'exec']);
  } finally {
    await daemon.close();
  }
});

test('outside the Slipstream app a mismatch never replaces the forwarder', async () => {
  const daemon = await olderDaemon();
  try {
    const { handlers, execs } = appForwarder(daemon.socketPath, 'a-newer-build', {});
    await dispatch(initialize('codex-mcp-client'), handlers);
    const res = resultOf(await dispatch(callBeginTask({ title: 't' }, CODEX_META), handlers));

    assert.equal(execs.length, 0);
    assert.match(res.text, /DAEMON_VERSION_MISMATCH/);
  } finally {
    await daemon.close();
  }
});

test('replayAnswersPendingCallOnce', async () => {
  const daemon = await fakeDaemon(OK);
  try {
    const replay = Buffer.from(JSON.stringify({
      initialize: { jsonrpc: '2.0', method: 'initialize', params: initialize('codex-mcp-client').params },
      call: { ...callBeginTask({ title: 'replayed' }, CODEX_META), id: 'call-41' },
      requestId: 'replayed-request-id',
      input: '',
    })).toString('base64');
    const forwarder = fileURLToPath(new URL('./mcp-forwarder.ts', import.meta.url));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [forwarder, '--store', dirname(daemon.socketPath)],
        { env: { PATH: process.env.PATH, SLIPSTREAM_MCP_REPLAY: replay }, timeout: 10_000 },
        (err, out) => (err ? reject(err) : resolve(out)));
      child.stdin!.end();
    });

    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l) as JsonRpcResponse);
    assert.equal(lines.length, 1, stdout);
    assert.equal(lines[0]!.id, 'call-41');
    assert.equal(resultOf(lines[0]!).isError, false);
    assert.equal(daemon.received[0]!.title, 'replayed');
    assert.equal(daemon.received[0]!.harness, 'codex');
    assert.equal(daemon.received[0]!.request_id, 'replayed-request-id');
  } finally {
    await daemon.close();
  }
});

function runForwarderProcess(store: string, env: Record<string, string | undefined>,
  feed: (stdin: NodeJS.WritableStream) => void): Promise<string> {
  const forwarder = fileURLToPath(new URL('./mcp-forwarder.ts', import.meta.url));
  return new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [forwarder, '--store', store],
      { env: { PATH: process.env.PATH, ...env }, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    feed(child.stdin!);
  });
}

test('forwarderHandsPipelinedInputToItsSuccessor', async () => {
  const daemon = await olderDaemon();
  const rt = await mkdtemp(join(tmpdir(), 'slip-fwd-rt-'));
  try {
    await mkdir(join(rt, 'builds', 'b1', 'app', 'dist'), { recursive: true });
    await writeFile(join(rt, 'builds', 'b1', 'app', 'dist', 'build-id'), 'a-newer-build\n');
    await symlink(join(rt, 'builds', 'b1'), join(rt, 'current'));
    await mkdir(join(rt, 'bin'));
    const shim = join(rt, 'bin', 'slipstream-mcp');
    await writeFile(shim, `#!/bin/sh\nprintf '%s' "$SLIPSTREAM_MCP_REPLAY" > '${rt}/replay'\n`
      + `exec '${process.execPath}' -e 'process.stdin.pipe(require("fs").createWriteStream(process.argv[1]))' '${rt}/stdin'\n`);
    await chmod(shim, 0o755);
    const pipelined = `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n{"jsonrpc":"2.0","id":4,`;

    const stdout = await runForwarderProcess(dirname(daemon.socketPath), { SLIPSTREAM_APP_RUNTIME: rt }, (stdin) => {
      stdin.end([initialize('codex-mcp-client'), callBeginTask({ title: 't' }, CODEX_META)]
        .map((m) => JSON.stringify(m) + '\n').join('') + pipelined);
    });

    assert.deepEqual(stdout.trim().split('\n').map((l) => (JSON.parse(l) as JsonRpcResponse).id), [1]);
    const replay = JSON.parse(Buffer.from(await readFile(join(rt, 'replay'), 'utf8'), 'base64').toString('utf8'));
    assert.equal(replay.call.id, 2);
    assert.equal(Buffer.from(replay.input, 'base64').toString('utf8') + await readFile(join(rt, 'stdin'), 'utf8'), pipelined);
  } finally {
    await daemon.close();
    await rm(rt, { recursive: true, force: true });
  }
});

test('replayHandlesHandedInputBeforeStdin', async () => {
  const daemon = await fakeDaemon(OK);
  try {
    const replay = Buffer.from(JSON.stringify({
      initialize: { jsonrpc: '2.0', method: 'initialize', params: initialize('codex-mcp-client').params },
      call: { ...callBeginTask({ title: 'replayed' }, CODEX_META), id: 'call-41' },
      input: Buffer.from('{"jsonrpc":"2.0","id":8,"method":"tools/list"}\n{"jsonrpc":"2.0","id":9,"meth').toString('base64'),
    })).toString('base64');

    const stdout = await runForwarderProcess(dirname(daemon.socketPath), { SLIPSTREAM_MCP_REPLAY: replay },
      (stdin) => stdin.end('od":"tools/list"}\n'));

    assert.deepEqual(stdout.trim().split('\n').map((l) => (JSON.parse(l) as JsonRpcResponse).id), ['call-41', 8, 9]);
  } finally {
    await daemon.close();
  }
});

test('a second replacement keeps input inherited from its predecessor', async () => {
  const daemon = await olderDaemon();
  const rt = await mkdtemp(join(tmpdir(), 'slip-fwd-rt-'));
  try {
    await mkdir(join(rt, 'builds', 'b1', 'app', 'dist'), { recursive: true });
    await writeFile(join(rt, 'builds', 'b1', 'app', 'dist', 'build-id'), 'a-newer-build\n');
    await symlink(join(rt, 'builds', 'b1'), join(rt, 'current'));
    await mkdir(join(rt, 'bin'));
    await writeFile(join(rt, 'bin', 'slipstream-mcp'), `#!/bin/sh\nprintf '%s' "$SLIPSTREAM_MCP_REPLAY" > '${rt}/replay'\n`);
    await chmod(join(rt, 'bin', 'slipstream-mcp'), 0o755);
    const inherited = `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })}\n{"jsonrpc":"2.0","id":9,`;
    const replay = Buffer.from(JSON.stringify({
      initialize: { jsonrpc: '2.0', method: 'initialize', params: initialize('codex-mcp-client').params },
      call: callBeginTask({ title: 'replayed' }, CODEX_META),
      requestId: 'replayed-request-id',
      input: Buffer.from(inherited).toString('base64'),
    })).toString('base64');

    await runForwarderProcess(dirname(daemon.socketPath), {
      SLIPSTREAM_APP_RUNTIME: rt,
      SLIPSTREAM_MCP_REPLAY: replay,
    }, (stdin) => stdin.end());

    const secondReplay = JSON.parse(Buffer.from(await readFile(join(rt, 'replay'), 'utf8'), 'base64').toString('utf8'));
    assert.equal(Buffer.from(secondReplay.input, 'base64').toString('utf8'), inherited);
  } finally {
    await daemon.close();
    await rm(rt, { recursive: true, force: true });
  }
});
