/**
 * Hand-rolled MCP-over-stdio JSON-RPC dispatch for the Slipstream forwarder.
 *
 * This is an adapted sibling of `tools/identity-probe/mcp.ts` (the proven probe
 * transport), NOT a shared import — the two servers publish different tool-result
 * shapes and evolve independently. The design (Codex consult, locked) is a
 * hand-rolled transport rather than the MCP SDK: the surface is a few JSON-RPC
 * methods and a single tool, so a dependency-free implementation is simpler to
 * audit and keeps Node built-ins the only runtime requirement.
 *
 * The one addition over the probe: a tool result may carry `structured` content,
 * surfaced as MCP `structuredContent` alongside the text block — the forwarder's
 * `slipstream_begin_task` returns a structured `{session_id, task_id, event_id,
 * seq}`, and a domain failure returns `isError: true` (a tool-level error the
 * agent can read), never a JSON-RPC error (reserved for transport/protocol faults).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool invocation returns to the transport. `text` is the human/agent-
 * readable summary; `structured` becomes MCP `structuredContent`; `isError` marks
 * a tool-level (domain) failure the agent must read rather than a JSON-RPC fault. */
export interface ToolResult {
  text: string;
  isError?: boolean;
  structured?: Record<string, unknown>;
}

export interface McpHandlers {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  tools: ToolDef[];
  onInitialize(params: unknown): void;
  callTool(name: string, params: unknown): Promise<ToolResult>;
}

export type ParseResult =
  | { ok: true; value: JsonRpcRequest }
  | { ok: false; code: -32700 | -32600 };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isValidRequest(value: unknown): value is JsonRpcRequest {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== '2.0') return false;
  if (typeof value.method !== 'string') return false;
  if ('id' in value) {
    const id = value.id;
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
    if (!validId) return false;
  }
  if ('params' in value && !isObject(value.params)) return false;
  return true;
}

export function parseMessage(line: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: -32700 };
  }
  if (!isValidRequest(value)) return { ok: false, code: -32600 };
  return { ok: true, value };
}

const err = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0', id, error: { code, message },
});
const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });

/** Dispatch one JSON-RPC request. Returns null for notifications (no `id`); JSON-RPC forbids responding to them. */
export async function dispatch(req: JsonRpcRequest, h: McpHandlers): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined || req.id === null;
  const id = (req.id ?? null) as string | number | null;

  const response = await (async (): Promise<JsonRpcResponse | null> => {
    switch (req.method) {
      case 'initialize':
        h.onInitialize(req.params);
        return ok(id, {
          protocolVersion: h.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: h.serverInfo,
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: h.tools });
      case 'tools/call': {
        if (!isObject(req.params) || typeof req.params.name !== 'string') {
          return err(id, -32602, 'invalid tools/call params');
        }
        const name = req.params.name;
        const found = h.tools.some((t) => t.name === name);
        if (!found) return err(id, -32602, `unknown tool: ${name}`);
        const out = await h.callTool(name, req.params);
        const result: Record<string, unknown> = {
          content: [{ type: 'text', text: out.text }],
          isError: out.isError ?? false,
        };
        if (out.structured !== undefined) result.structuredContent = out.structured;
        return ok(id, result);
      }
      default:
        return err(id, -32601, `method not found: ${req.method}`);
    }
  })();

  return isNotification ? null : response;
}
