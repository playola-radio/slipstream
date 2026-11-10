#!/usr/bin/env node
/**
 * The Slipstream MCP forwarder — the whole subprocess a harness spawns.
 *
 * It wires these pieces together and owns nothing else:
 *   - {@link ./mcp-protocol.ts}   — hand-rolled MCP-over-stdio JSON-RPC transport.
 *   - {@link ./harness-context.ts} — fail-closed harness-identity resolver (SC3).
 *   - {@link ./task-forwarder.ts} — begin_task orchestration with honest retry.
 *   - {@link ./answer-forwarder.ts} — answer_question orchestration with honest retry.
 *   - {@link ./control-client.ts} — the unix-socket control channel to the daemon.
 *
 * It exposes two tools, `slipstream_begin_task(title)` and
 * `slipstream_answer_question(question_id, text)`. The forwarder is a control
 * client: it never attaches, never captures, and never touches the store — it resolves the daemon's control socket from `--store` (shared with the CLI)
 * and forwards a verified identity triple. A missing daemon fails fast as
 * DAEMON_UNAVAILABLE rather than hanging, because the tool must return promptly.
 */
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appRuntime } from './app-runtime.ts';
import { isMainModule } from './entrypoint.ts';
import { dispatch, parseMessage, type JsonRpcRequest, type JsonRpcResponse, type McpHandlers, type ToolDef } from './mcp-protocol.ts';
import { createHarnessContext } from './harness-context.ts';
import { forwardBeginTask } from './task-forwarder.ts';
import { forwardAnswer } from './answer-forwarder.ts';
import { sendControlRequest } from './control-client.ts';
import { thisBuild, versionGate } from './daemon-version.ts';
import { controlSocketPath, resolveStoreDir } from './daemon-location.ts';
import type { RequestEnvelope } from './control-protocol.ts';

export const BEGIN_TASK_TOOL: ToolDef = {
  name: 'slipstream_begin_task',
  description:
    'Declare the start of a task so the Slipstream feed groups the file changes you are about ' +
    'to make under it. Call it right before you start working on a distinct piece of work.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short human-readable title for the task.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export const ANSWER_QUESTION_TOOL: ToolDef = {
  name: 'slipstream_answer_question',
  description:
    'Return your answer to a Slipstream question. Call it once per question with the exact ' +
    'question_id from the Slipstream question context and your complete answer as text.',
  inputSchema: {
    type: 'object',
    properties: {
      question_id: { type: 'string', description: 'The exact Slipstream question id you are answering.' },
      text: { type: 'string', description: 'Your complete answer for the user.' },
    },
    required: ['question_id', 'text'],
    additionalProperties: false,
  },
};

type Env = Record<string, string | undefined>;

export interface ForwarderHandlerOpts {
  /** Path to the daemon's control socket. */
  socketPath: string;
  /** The subprocess env, read once at initialize for the Claude identity triple. */
  env: Env;
  /** Replaces this process; the app's shim after an update. Defaults to `process.execve`. */
  execve?: (file: string, args: string[], env: Env) => void | Promise<void>;
  /** The build the app's runtime `<root>/current` now holds, or null if unreadable. */
  readCurrentBuild?: (root: string) => Promise<string | null>;
}

/** The env var a replaced forwarder hands its successor the call it was answering. */
export const REPLAY_ENV = 'SLIPSTREAM_MCP_REPLAY';

interface Replay { initialize: JsonRpcRequest | null; call: JsonRpcRequest }

async function currentBuild(root: string): Promise<string | null> {
  try {
    return (await readFile(join(await realpath(join(root, 'current')), 'app', 'dist', 'build-id'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function execveAfterFlush(file: string, args: string[], env: Env): Promise<void> {
  if (process.stdout.writableLength > 0) await once(process.stdout, 'drain');
  process.execve!(file, args, env);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function stringArg(params: unknown, key: string): string {
  // Pass the raw value through; the daemon is the authority on validity (an
  // empty/absent title or answer becomes its INVALID_TITLE / INVALID_ANSWER,
  // not a second local rule).
  const value = isObject(params) && isObject(params.arguments) ? params.arguments[key] : undefined;
  return typeof value === 'string' ? value : '';
}

export function createForwarderHandlers(opts: ForwarderHandlerOpts): McpHandlers {
  const ctx = createHarnessContext();
  const execve = opts.execve ?? execveAfterFlush;
  const readCurrentBuild = opts.readCurrentBuild ?? currentBuild;
  let initialized: JsonRpcRequest | null = null;

  /** After an app update the daemon runs the new build and this process is the
   * stale side: hand the call to the new shim instead of answering a mismatch. */
  const replaceIfStale = async (call: JsonRpcRequest) => {
    const runtime = appRuntime(opts.env);
    if (!runtime) return;
    const current = await readCurrentBuild(runtime.root);
    if (current === null || current === (await thisBuild()).build) return;
    const replay: Replay = { initialize: initialized, call };
    try {
      await execve(runtime.mcp, [runtime.mcp, ...process.argv.slice(2)],
        { ...opts.env, [REPLAY_ENV]: Buffer.from(JSON.stringify(replay)).toString('base64') });
    } catch (err) {
      process.stderr.write(`slipstream-forwarder: could not switch to ${runtime.mcp}: ${(err as Error).message}\n`);
    }
  };

  return {
    serverInfo: { name: 'slipstream-forwarder', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    tools: [BEGIN_TASK_TOOL, ANSWER_QUESTION_TOOL],
    onInitialize: (params) => {
      initialized = { jsonrpc: '2.0', method: 'initialize', params };
      const clientInfo = isObject(params) ? params.clientInfo : undefined;
      ctx.initialize(clientInfo, opts.env);
    },
    callTool: (name, params, id) => {
      const identity = ctx.identityForCall(params);
      const raw = (request: RequestEnvelope) => sendControlRequest({ socketPath: opts.socketPath, request });
      const send = async (request: RequestEnvelope) => {
        const response = await versionGate(raw, dirname(opts.socketPath), await thisBuild())(request);
        if (!response.ok && response.code === 'DAEMON_VERSION_MISMATCH') {
          await replaceIfStale({ jsonrpc: '2.0', id, method: 'tools/call', params });
        }
        return response;
      };
      return name === ANSWER_QUESTION_TOOL.name
        ? forwardAnswer({ identity, questionId: stringArg(params, 'question_id'), text: stringArg(params, 'text'), send })
        : forwardBeginTask({ identity, title: stringArg(params, 'title'), send });
    },
  };
}

/** The largest single JSON-RPC line the forwarder will buffer from stdin. A well-
 * formed request is a few hundred bytes; this cap is generous for a title yet far
 * short of exhausting memory on an unterminated line. */
export const MAX_STDIN_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/** One decoded stdin event: a complete line to parse, or an over-cap line that was
 * dropped (so the caller can answer a parse error instead of buffering forever). */
export type StdinFrame = { line: string } | { overflow: true };

/**
 * Split raw stdin bytes into newline-delimited lines with a hard byte cap. A line
 * (terminated or not) that exceeds `maxBytes` is dropped and reported as
 * `{ overflow: true }`; the bytes up to its terminating newline are then discarded
 * rather than accumulated, so a peer streaming an endless unterminated line can
 * never grow the buffer without bound. Blank lines are skipped.
 */
export function createStdinFramer(maxBytes: number = MAX_STDIN_LINE_BYTES) {
  let buf: Buffer = Buffer.alloc(0);
  let discarding = false; // dropping the tail of an over-cap line until its newline
  return {
    push(chunk: Buffer): StdinFrame[] {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const out: StdinFrame[] = [];
      for (;;) {
        const nl = buf.indexOf(NEWLINE);
        if (nl === -1) break;
        const lineBuf = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (discarding) { discarding = false; continue; }
        if (lineBuf.length > maxBytes) { out.push({ overflow: true }); continue; }
        const line = lineBuf.toString('utf8');
        if (line.trim().length === 0) continue;
        out.push({ line });
      }
      if (buf.length > maxBytes) {
        if (!discarding) out.push({ overflow: true });
        buf = Buffer.alloc(0);
        discarding = true;
      }
      return out;
    },
  };
}

/** A replaced forwarder's successor answers the call its predecessor was holding,
 * under the original id; the saved initialize only primes the identity. */
async function answerReplay(text: string, handlers: McpHandlers, write: (res: JsonRpcResponse) => void): Promise<void> {
  let saved: Replay;
  try {
    saved = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as Replay;
  } catch (err) {
    process.stderr.write(`slipstream-forwarder: ${REPLAY_ENV} is unreadable: ${(err as Error).message}\n`);
    return;
  }
  if (saved.initialize) await dispatch(saved.initialize, handlers);
  const res = await dispatch(saved.call, handlers);
  if (res) write(res);
}

export async function runForwarder(): Promise<void> {
  let socketPath: string;
  try {
    socketPath = controlSocketPath(resolveStoreDir(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`slipstream-forwarder: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  const replay = process.env[REPLAY_ENV];
  delete process.env[REPLAY_ENV];
  const handlers = createForwarderHandlers({ socketPath, env: process.env });
  const write = (res: JsonRpcResponse) => process.stdout.write(JSON.stringify(res) + '\n');
  const writeError = (code: number, message: string) => write({ jsonrpc: '2.0', id: null, error: { code, message } });

  if (replay !== undefined) await answerReplay(replay, handlers, write);

  const framer = createStdinFramer();
  for await (const chunk of process.stdin) {
    for (const frame of framer.push(chunk as Buffer)) {
      if ('overflow' in frame) {
        writeError(-32700, 'message exceeds byte cap');
        continue;
      }
      const parsed = parseMessage(frame.line);
      if (!parsed.ok) {
        writeError(parsed.code, parsed.code === -32700 ? 'parse error' : 'invalid request');
        continue;
      }
      const res = await dispatch(parsed.value, handlers);
      if (res) write(res);
    }
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await runForwarder();
}
