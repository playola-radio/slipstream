#!/usr/bin/env node
/**
 * The Slipstream MCP forwarder — the whole subprocess a harness spawns.
 *
 * It wires four locked pieces together and owns nothing else:
 *   - {@link ./mcp-protocol.ts}   — hand-rolled MCP-over-stdio JSON-RPC transport.
 *   - {@link ./harness-context.ts} — fail-closed harness-identity resolver (SC3).
 *   - {@link ./task-forwarder.ts} — begin_task orchestration with honest retry.
 *   - {@link ./control-client.ts} — the unix-socket control channel to the daemon.
 *
 * It exposes exactly ONE tool, `slipstream_begin_task(title)`. The forwarder is a
 * control client: it never attaches, never captures, and never touches the store
 * — it resolves the daemon's control socket from `--store` (shared with the CLI)
 * and forwards a verified identity triple. A missing daemon fails fast as
 * DAEMON_UNAVAILABLE rather than hanging, because the tool must return promptly.
 */
import { createInterface } from 'node:readline';
import { isMainModule } from './entrypoint.ts';
import { dispatch, parseMessage, type McpHandlers, type ToolDef } from './mcp-protocol.ts';
import { createHarnessContext } from './harness-context.ts';
import { forwardBeginTask } from './task-forwarder.ts';
import { sendControlRequest } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { controlSocketPath, resolveStoreDir } from './daemon-location.ts';

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

type Env = Record<string, string | undefined>;
type SendControl = (request: RequestEnvelope) => Promise<ResponseEnvelope>;

export interface ForwarderHandlerOpts {
  /** Path to the daemon's control socket. */
  socketPath: string;
  /** The subprocess env, read once at initialize for the Claude identity triple. */
  env: Env;
  /** Injectable control channel; production sends over the unix socket. */
  send?: SendControl;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function titleOf(params: unknown): string {
  // Pass the raw title through; the daemon is the authority on title validity
  // (an empty/absent title becomes its INVALID_TITLE, not a second local rule).
  if (isObject(params) && isObject(params.arguments) && typeof params.arguments.title === 'string') {
    return params.arguments.title;
  }
  return '';
}

export function createForwarderHandlers(opts: ForwarderHandlerOpts): McpHandlers {
  const ctx = createHarnessContext();
  const send: SendControl =
    opts.send ?? ((request) => sendControlRequest({ socketPath: opts.socketPath, request }));

  return {
    serverInfo: { name: 'slipstream-forwarder', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    tools: [BEGIN_TASK_TOOL],
    onInitialize: (params) => {
      const clientInfo = isObject(params) ? params.clientInfo : undefined;
      ctx.initialize(clientInfo, opts.env);
    },
    callTool: (_name, params) =>
      forwardBeginTask({
        identity: ctx.identityForCall(params),
        title: titleOf(params),
        send,
      }),
  };
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

  const handlers = createForwarderHandlers({ socketPath, env: process.env });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      const message = parsed.code === -32700 ? 'parse error' : 'invalid request';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: parsed.code, message } }) + '\n');
      continue;
    }
    const res = await dispatch(parsed.value, handlers);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await runForwarder();
}
