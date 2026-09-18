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

export interface McpHandlers {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  tools: ToolDef[];
  onInitialize(params: unknown): void;
  callTool(name: string, params: unknown): Promise<{ text: string; isError?: boolean }>;
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
    if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return false;
  }
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

/** Dispatch one JSON-RPC request. Returns null for notifications (no `id`). */
export async function dispatch(req: JsonRpcRequest, h: McpHandlers): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined || req.id === null;
  const id = (req.id ?? null) as string | number | null;

  switch (req.method) {
    case 'initialize':
      h.onInitialize(req.params);
      return ok(id, {
        protocolVersion: h.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: h.serverInfo,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
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
      return ok(id, { content: [{ type: 'text', text: out.text }], isError: out.isError ?? false });
    }
    default:
      if (isNotification) return null; // unknown notifications are ignored
      return err(id, -32601, `method not found: ${req.method}`);
  }
}
