#!/usr/bin/env node
/**
 * slipstream identity-probe — a diagnostic MCP stdio server (Stage 3 PR 1).
 *
 * A harness (Claude Code / Codex) spawns this via user-level MCP config. It
 * records, with strict redaction, the identity context it can observe at
 * startup and on each `identity_probe_snapshot` tool call, appending redacted
 * JSONL to a gitignored log. It writes NO product event and captures NO file
 * bytes. See tools/identity-probe/README.md and the Stage 3 PR 1 spec.
 */
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../../src/entrypoint.ts';
import { dispatch, parseMessage, type McpHandlers, type ToolDef } from './mcp.ts';
import { buildObservation, captureInitialize, type InitializeCapture, type Observation } from './observe.ts';
import { appendObservation } from './report.ts';

export const PROBE_TOOL: ToolDef = {
  name: 'identity_probe_snapshot',
  description: 'Diagnostic: record the redacted harness-identity context this MCP subprocess can observe.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const DEFAULT_LOG_PATH = join(homedir(), '.slipstream-identity-probe', 'observations.jsonl');

interface HandlerOpts {
  logPath: string;
  env: Record<string, string | undefined>;
  argv: string[];
  cwd: string;
  home: string;
  now: () => number;
  append: (obs: Observation) => Promise<void>;
  onAppendError?: (err: unknown) => void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createProbeHandlers(opts: HandlerOpts): McpHandlers {
  let initialize: InitializeCapture = { present: false };

  const reportAppendError = opts.onAppendError ?? ((err: unknown) => {
    process.stderr.write(`identity-probe: failed to append observation: ${String(err)}\n`);
  });

  const record = async (phase: 'startup' | 'tool_call', toolParams?: Record<string, unknown>): Promise<Observation> => {
    const obs = buildObservation({
      phase, env: opts.env, argv: opts.argv, cwd: opts.cwd, home: opts.home, nowMs: opts.now(),
      initialize,
      toolCall: phase === 'tool_call'
        ? {
            present: true,
            toolName: typeof toolParams?.name === 'string' ? toolParams.name : undefined,
            meta: isObject(toolParams) ? toolParams['_meta'] : undefined,
            hasArguments: isObject(toolParams) && isObject(toolParams['arguments']) && Object.keys(toolParams['arguments'] as object).length > 0,
          }
        : undefined,
    });
    await opts.append(obs);
    return obs;
  };

  return {
    serverInfo: { name: 'slipstream-identity-probe', version: '0.0.0' },
    protocolVersion: '2025-06-18',
    tools: [PROBE_TOOL],
    onInitialize: (params) => {
      initialize = captureInitialize(params);
      record('startup').catch(reportAppendError);
    },
    callTool: async (_name, params) => {
      let obs: Observation;
      try {
        obs = await record('tool_call', isObject(params) ? params : undefined);
      } catch (err) {
        reportAppendError(err);
        return { text: `identity-probe failed to record snapshot: ${String(err)}`, isError: true };
      }
      return {
        text:
          'identity-probe recorded a snapshot. ' +
          `client=${obs.initialize.clientInfo?.name ?? 'unknown'} ` +
          `session_id_present=${obs.env.CLAUDE_CODE_SESSION_ID?.present ?? false} ` +
          `tool_meta_present=${obs.tool_call?.meta !== undefined}`,
      };
    },
  };
}

export async function runServer(): Promise<void> {
  const logPath = process.env.SLIPSTREAM_IDENTITY_PROBE_LOG ?? DEFAULT_LOG_PATH;
  const handlers = createProbeHandlers({
    logPath,
    env: process.env,
    argv: process.argv,
    cwd: process.cwd(),
    home: homedir(),
    now: () => Date.now(),
    append: (obs) => appendObservation(logPath, obs),
  });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      continue;
    }
    const res = await dispatch(parsed.value, handlers);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await runServer();
}
