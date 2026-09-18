# Stage 3 · PR 1 — Harness Identity Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a minimal real MCP stdio server that records, with strict redaction, the identity-bearing context a Claude Code / Codex subprocess can observe — so Stage 3 SC3 (verified harness identity) can be proven or refuted with real runs before any attachment code is written.

**Architecture:** A self-contained dev tool under `tools/identity-probe/` (mirrors `tools/live-feed/`). Pure, unit-tested layers — redaction (`redact.ts`), observation-record builder (`observe.ts`), MCP JSON-RPC dispatch + framing (`mcp.ts`) — are composed by a thin runnable server (`server.ts`) that a harness spawns via user-level MCP config. The server captures one observation at `initialize` (startup) and one per `identity_probe_snapshot` tool call, appending redacted JSONL to a gitignored log. `FINDINGS.md` + `README.md` carry the scenario matrix and wiring. No production code, no events, no schema, no IPC.

**Tech Stack:** TypeScript on Node 24 LTS, Node built-in modules only (`node:readline`, `node:fs/promises`, `node:os`, `node:path`, `node:test`, `node:assert/strict`). No new dependencies. MCP 2025-06-18 stdio transport (newline-delimited JSON-RPC 2.0).

**Spec:** `docs/superpowers/specs/2026-09-17-stage3-harness-identity-probe-design.md`

## Global Constraints

- **Node built-in modules only.** No new dependency. If you think you need one, STOP and ask. (CLAUDE.md / Stack)
- **TDD:** failing test first, minimal implementation, refactor. Never disable a test; never `--no-verify`. (CLAUDE.md / Process)
- **Honesty boundary:** never record an env value outside the identity allowlist; record other matching env vars by **key name only**; never read or record file contents; home-relativize every absolute path with `~`; an absent field is recorded explicitly (`{present:false}`), never omitted. (Spec § honesty boundary)
- **Frozen public interface untouched:** this PR introduces no `slipstream.*` event type, no schema, no CloudEvents envelope change, no reader route, no IPC socket, no product CLI subcommand, no product error code. The observation record is a local dev artifact named `identity-probe-observation.v1`, never a public event. (CLAUDE.md / hard rule; Stage 3 "decisions not yours to make")
- **No captured data committed:** the runtime observation log is `*.jsonl` (already gitignored). Only hand-curated, redacted `FINDINGS.md` is committed. (CLAUDE.md / Never commit captured data)
- **Synthetic tests are never real-harness evidence.** Unit tests prove parsing/recording; real-harness claims come only from `FINDINGS.md` runs. (Spec § out of scope)
- **Small commits that compile and pass.** No `Co-Authored-By` / co-sign trailers. Branch is `briankeane/stage-3-conductor-attach` off `develop`. (CLAUDE.md)
- Tests run under `npm run test:tools` (glob `tools/**/*.test.ts`); typecheck under `npm run typecheck`.

---

## File Structure

- `tools/identity-probe/redact.ts` — pure redaction + allowlist helpers.
- `tools/identity-probe/redact.test.ts` — redaction tests (incl. adversarial no-leak).
- `tools/identity-probe/observe.ts` — pure observation-record builder + record types.
- `tools/identity-probe/observe.test.ts` — record-shape tests.
- `tools/identity-probe/mcp.ts` — pure MCP JSON-RPC dispatch + newline framing helpers + types.
- `tools/identity-probe/mcp.test.ts` — protocol tests (initialize / initialized / ping / tools/list / tools/call / errors).
- `tools/identity-probe/report.ts` — append one observation as a JSONL line (create dirs, own-only perms).
- `tools/identity-probe/server.ts` — runnable entrypoint: wires mcp + observe + report, registers `identity_probe_snapshot`, reads stdin / writes stdout.
- `tools/identity-probe/server.test.ts` — in-process full-handshake test + one child-process stdio smoke test.
- `tools/identity-probe/FINDINGS.md` — scenario matrix scaffold (committed, hand-redacted).
- `tools/identity-probe/README.md` — user-level MCP wiring for both harnesses + run procedure.
- `package.json` — add `"identity-probe"` run script (modify).

---

### Task 1: Redaction + allowlist

**Files:**
- Create: `tools/identity-probe/redact.ts`
- Test: `tools/identity-probe/redact.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `ALLOWLISTED_ENV_KEYS: readonly string[]` — env keys recorded by value.
  - `DISCOVERY_PREFIXES: readonly string[]` — prefixes for name-only discovery.
  - `homeRelativize(value: string, home: string): string`
  - `type EnvField = { present: true; value: string } | { present: false }`
  - `collectAllowlistedEnv(env: Record<string,string|undefined>, home: string): Record<string, EnvField>`
  - `discoverEnvKeys(env: Record<string,string|undefined>): string[]` (sorted, names only, matching a prefix, excluding allowlisted keys)

- [ ] **Step 1: Write the failing tests**

```ts
// tools/identity-probe/redact.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWLISTED_ENV_KEYS,
  homeRelativize,
  collectAllowlistedEnv,
  discoverEnvKeys,
} from './redact.ts';

test('homeRelativize replaces the home prefix with ~ and leaves other paths', () => {
  assert.equal(homeRelativize('/Users/x/conductor/w', '/Users/x'), '~/conductor/w');
  assert.equal(homeRelativize('/Users/x', '/Users/x'), '~');
  assert.equal(homeRelativize('/opt/tool', '/Users/x'), '/opt/tool');
});

test('collectAllowlistedEnv records allowlisted values, home-relativizing paths', () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'sess-123',
    CLAUDE_PROJECT_DIR: '/Users/x/conductor/w',
    AWS_SECRET_ACCESS_KEY: 'super-secret',
  };
  const out = collectAllowlistedEnv(env, '/Users/x');
  assert.deepEqual(out.CLAUDE_CODE_SESSION_ID, { present: true, value: 'sess-123' });
  assert.deepEqual(out.CLAUDE_PROJECT_DIR, { present: true, value: '~/conductor/w' });
  // A non-allowlisted key gets no entry at all in the allowlisted map.
  assert.equal('AWS_SECRET_ACCESS_KEY' in out, false);
});

test('collectAllowlistedEnv marks absent allowlisted keys explicitly', () => {
  const out = collectAllowlistedEnv({}, '/Users/x');
  for (const k of ALLOWLISTED_ENV_KEYS) assert.deepEqual(out[k], { present: false });
});

test('discoverEnvKeys returns sorted matching names only, never values, never allowlisted', () => {
  const env = {
    CLAUDE_CONFIG_DIR: '/Users/x/.claude',   // matches CLAUDE prefix, not allowlisted
    CODEX_HOME: '/Users/x/.codex',            // matches CODEX prefix, not allowlisted
    CONDUCTOR_WORKSPACE: 'ws',                // matches CONDUCTOR prefix, not allowlisted
    AWS_SECRET_ACCESS_KEY: 'super-secret',    // no discovery prefix -> excluded
    CLAUDE_CODE_SESSION_ID: 'sess-123',       // allowlisted -> excluded from discovery
  };
  const keys = discoverEnvKeys(env);
  assert.deepEqual(keys, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CONDUCTOR_WORKSPACE']);
  assert.equal(keys.includes('AWS_SECRET_ACCESS_KEY'), false);
  assert.equal(keys.includes('CLAUDE_CODE_SESSION_ID'), false);
  // Adversarial: no value string ever appears in the discovery output.
  assert.equal(JSON.stringify(keys).includes('super-secret'), false);
  assert.equal(JSON.stringify(keys).includes('sess-123'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/identity-probe/redact.test.ts`
Expected: FAIL (module not found / exports undefined).

- [ ] **Step 3: Write minimal implementation**

```ts
// tools/identity-probe/redact.ts

/** Env keys whose VALUES are identity evidence and safe to record. */
export const ALLOWLISTED_ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'SLIPSTREAM_HOME',
] as const;

/** Prefixes for name-only discovery of unanticipated identity carriers. */
export const DISCOVERY_PREFIXES = ['CLAUDE', 'CODEX', 'MCP', 'SLIPSTREAM', 'CONDUCTOR'] as const;

export type EnvField = { present: true; value: string } | { present: false };

/** Rewrite an absolute path under `home` to start with `~`. Non-matching paths pass through. */
export function homeRelativize(value: string, home: string): string {
  if (value === home) return '~';
  if (home.length > 0 && value.startsWith(home + '/')) return '~' + value.slice(home.length);
  return value;
}

/** Values are home-relativized for the path-bearing keys; identifiers pass through unchanged. */
const PATH_VALUED_KEYS = new Set(['CLAUDE_PROJECT_DIR', 'SLIPSTREAM_HOME']);

export function collectAllowlistedEnv(
  env: Record<string, string | undefined>,
  home: string,
): Record<string, EnvField> {
  const out: Record<string, EnvField> = {};
  for (const key of ALLOWLISTED_ENV_KEYS) {
    const raw = env[key];
    if (raw === undefined) { out[key] = { present: false }; continue; }
    out[key] = { present: true, value: PATH_VALUED_KEYS.has(key) ? homeRelativize(raw, home) : raw };
  }
  return out;
}

const ALLOWLISTED_SET = new Set<string>(ALLOWLISTED_ENV_KEYS);

export function discoverEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => !ALLOWLISTED_SET.has(k))
    .filter((k) => DISCOVERY_PREFIXES.some((p) => k.startsWith(p)))
    .sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/identity-probe/redact.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/identity-probe/redact.ts tools/identity-probe/redact.test.ts
git commit -m "chore: add identity-probe redaction and env allowlist"
```

---

### Task 2: Observation record builder

**Files:**
- Create: `tools/identity-probe/observe.ts`
- Test: `tools/identity-probe/observe.test.ts`

**Interfaces:**
- Consumes (Task 1): `collectAllowlistedEnv`, `discoverEnvKeys`, `homeRelativize`, `EnvField`.
- Produces:
  - `interface InitializeCapture { present: boolean; protocolVersion?: string; clientInfo?: { name?: string; version?: string }; capabilityKeys?: string[] }`
  - `interface ToolCallCapture { present: boolean; toolName?: string; meta?: unknown; hasArguments?: boolean }`
  - `interface Observation { schema: 'identity-probe-observation.v1'; captured_at_ms: number; phase: 'startup' | 'tool_call'; env: Record<string, EnvField>; discovered_env_keys: string[]; process: { cwd: string; argv: string[] }; initialize: InitializeCapture; tool_call?: ToolCallCapture }`
  - `function captureInitialize(params: unknown): InitializeCapture`
  - `function buildObservation(input: ObservationInput): Observation` where
    `interface ObservationInput { phase: 'startup' | 'tool_call'; env: Record<string,string|undefined>; argv: string[]; cwd: string; home: string; nowMs: number; initialize: InitializeCapture; toolCall?: ToolCallCapture }`

- [ ] **Step 1: Write the failing tests**

```ts
// tools/identity-probe/observe.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureInitialize, buildObservation } from './observe.ts';

test('captureInitialize pulls protocolVersion, clientInfo, and capability keys only', () => {
  const cap = captureInitialize({
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'claude-code', version: '1.2.3' },
    capabilities: { roots: {}, sampling: {} },
  });
  assert.equal(cap.present, true);
  assert.equal(cap.protocolVersion, '2025-06-18');
  assert.deepEqual(cap.clientInfo, { name: 'claude-code', version: '1.2.3' });
  assert.deepEqual(cap.capabilityKeys, ['roots', 'sampling']);
});

test('captureInitialize on garbage returns present:false without throwing', () => {
  assert.deepEqual(captureInitialize(undefined), { present: false });
  assert.deepEqual(captureInitialize('nope'), { present: false });
});

test('buildObservation assembles a redacted startup record', () => {
  const obs = buildObservation({
    phase: 'startup',
    env: { CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_PROJECT_DIR: '/Users/x/w', SECRET: 'nope' },
    argv: ['/opt/node', '/Users/x/tools/identity-probe/server.ts'],
    cwd: '/Users/x/w',
    home: '/Users/x',
    nowMs: 1000,
    initialize: { present: true, protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' }, capabilityKeys: [] },
  });
  assert.equal(obs.schema, 'identity-probe-observation.v1');
  assert.equal(obs.phase, 'startup');
  assert.equal(obs.captured_at_ms, 1000);
  assert.deepEqual(obs.env.CLAUDE_CODE_SESSION_ID, { present: true, value: 'sess-1' });
  assert.deepEqual(obs.env.CLAUDE_PROJECT_DIR, { present: true, value: '~/w' });
  assert.equal(obs.process.cwd, '~/w');
  assert.deepEqual(obs.process.argv, ['/opt/node', '~/tools/identity-probe/server.ts']);
  assert.equal(obs.tool_call, undefined);
  // Adversarial: no non-allowlisted value leaks anywhere in the serialized record.
  assert.equal(JSON.stringify(obs).includes('nope'), false);
});

test('buildObservation includes tool_call capture when phase is tool_call', () => {
  const obs = buildObservation({
    phase: 'tool_call',
    env: {}, argv: [], cwd: '/Users/x', home: '/Users/x', nowMs: 2000,
    initialize: { present: false },
    toolCall: { present: true, toolName: 'identity_probe_snapshot', meta: { threadId: 't-9' }, hasArguments: false },
  });
  assert.equal(obs.phase, 'tool_call');
  assert.deepEqual(obs.tool_call, { present: true, toolName: 'identity_probe_snapshot', meta: { threadId: 't-9' }, hasArguments: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/identity-probe/observe.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// tools/identity-probe/observe.ts
import { collectAllowlistedEnv, discoverEnvKeys, homeRelativize, type EnvField } from './redact.ts';

export interface InitializeCapture {
  present: boolean;
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilityKeys?: string[];
}

export interface ToolCallCapture {
  present: boolean;
  toolName?: string;
  meta?: unknown;
  hasArguments?: boolean;
}

export interface Observation {
  schema: 'identity-probe-observation.v1';
  captured_at_ms: number;
  phase: 'startup' | 'tool_call';
  env: Record<string, EnvField>;
  discovered_env_keys: string[];
  process: { cwd: string; argv: string[] };
  initialize: InitializeCapture;
  tool_call?: ToolCallCapture;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Extract only the identity-bearing shape of an MCP initialize params object. */
export function captureInitialize(params: unknown): InitializeCapture {
  if (!isObject(params)) return { present: false };
  const cap: InitializeCapture = { present: true };
  if (typeof params.protocolVersion === 'string') cap.protocolVersion = params.protocolVersion;
  if (isObject(params.clientInfo)) {
    const ci = params.clientInfo;
    cap.clientInfo = {
      name: typeof ci.name === 'string' ? ci.name : undefined,
      version: typeof ci.version === 'string' ? ci.version : undefined,
    };
  }
  if (isObject(params.capabilities)) cap.capabilityKeys = Object.keys(params.capabilities).sort();
  return cap;
}

export interface ObservationInput {
  phase: 'startup' | 'tool_call';
  env: Record<string, string | undefined>;
  argv: string[];
  cwd: string;
  home: string;
  nowMs: number;
  initialize: InitializeCapture;
  toolCall?: ToolCallCapture;
}

export function buildObservation(input: ObservationInput): Observation {
  const obs: Observation = {
    schema: 'identity-probe-observation.v1',
    captured_at_ms: input.nowMs,
    phase: input.phase,
    env: collectAllowlistedEnv(input.env, input.home),
    discovered_env_keys: discoverEnvKeys(input.env),
    process: {
      cwd: homeRelativize(input.cwd, input.home),
      argv: input.argv.map((a) => homeRelativize(a, input.home)),
    },
    initialize: input.initialize,
  };
  if (input.phase === 'tool_call' && input.toolCall) obs.tool_call = input.toolCall;
  return obs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/identity-probe/observe.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/identity-probe/observe.ts tools/identity-probe/observe.test.ts
git commit -m "chore: add identity-probe observation record builder"
```

---

### Task 3: MCP stdio protocol core

**Files:**
- Create: `tools/identity-probe/mcp.ts`
- Test: `tools/identity-probe/mcp.test.ts`

**Interfaces:**
- Consumes: nothing (leaf; protocol only).
- Produces:
  - `interface JsonRpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: unknown }`
  - `interface JsonRpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }`
  - `interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }`
  - `interface McpHandlers { serverInfo: { name: string; version: string }; protocolVersion: string; tools: ToolDef[]; onInitialize(params: unknown): void; callTool(name: string, params: unknown): Promise<{ text: string; isError?: boolean }> }`
  - `function parseMessage(line: string): { ok: true; value: JsonRpcRequest } | { ok: false }`
  - `async function dispatch(req: JsonRpcRequest, h: McpHandlers): Promise<JsonRpcResponse | null>` (returns `null` for notifications)

- [ ] **Step 1: Write the failing tests**

```ts
// tools/identity-probe/mcp.test.ts
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

test('parseMessage rejects non-JSON', () => {
  assert.equal(parseMessage('not json').ok, false);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/identity-probe/mcp.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// tools/identity-probe/mcp.ts

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

export function parseMessage(line: string): { ok: true; value: JsonRpcRequest } | { ok: false } {
  try {
    const value = JSON.parse(line) as JsonRpcRequest;
    if (typeof value?.method !== 'string') return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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
      const found = h.tools.some((t) => t.name === req.params!['name']);
      if (!found) return err(id, -32602, `unknown tool: ${String(req.params.name)}`);
      const out = await h.callTool(req.params.name, req.params);
      return ok(id, { content: [{ type: 'text', text: out.text }], isError: out.isError ?? false });
    }
    default:
      if (isNotification) return null; // unknown notifications are ignored
      return err(id, -32601, `method not found: ${req.method}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/identity-probe/mcp.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/identity-probe/mcp.ts tools/identity-probe/mcp.test.ts
git commit -m "chore: add identity-probe MCP JSON-RPC dispatch core"
```

---

### Task 4: Probe server — report appender, tool wiring, stdio loop

**Files:**
- Create: `tools/identity-probe/report.ts`
- Create: `tools/identity-probe/server.ts`
- Test: `tools/identity-probe/server.test.ts`

**Interfaces:**
- Consumes: `dispatch`, `parseMessage`, `McpHandlers`, `ToolDef` (Task 3); `captureInitialize`, `buildObservation`, `Observation`, `InitializeCapture` (Task 2).
- Produces:
  - `report.ts`: `async function appendObservation(logPath: string, obs: Observation): Promise<void>` (creates parent dir mode 0o700, appends `JSON.stringify(obs) + '\n'`, file mode 0o600).
  - `server.ts`:
    - `function createProbeHandlers(opts: { logPath: string; env: Record<string,string|undefined>; argv: string[]; cwd: string; home: string; now: () => number; append: (obs: Observation) => Promise<void> }): McpHandlers` — captures initialize into closure state, records a `startup` observation on initialize, records a `tool_call` observation per call, returns a redacted text summary.
    - `async function runServer(): Promise<void>` — wires `process` + real `appendObservation` and pumps stdin→dispatch→stdout. Guarded by `isMainModule`.
    - `const PROBE_TOOL: ToolDef` and `const DEFAULT_LOG_PATH: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// tools/identity-probe/server.test.ts
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
  assert.deepEqual(toolRecord.tool_call?.meta, { threadId: 't-7' });
  const text = (res?.result as any).content[0].text as string;
  assert.match(text, /identity-probe/);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/identity-probe/server.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write minimal implementations**

```ts
// tools/identity-probe/report.ts
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Observation } from './observe.ts';

/** Append one observation as a JSONL line. Owner-only perms; the log is gitignored (*.jsonl). */
export async function appendObservation(logPath: string, obs: Observation): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await appendFile(logPath, JSON.stringify(obs) + '\n', { mode: 0o600 });
}
```

```ts
// tools/identity-probe/server.ts
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
import { fileURLToPath } from 'node:url';
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
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createProbeHandlers(opts: HandlerOpts): McpHandlers {
  let initialize: InitializeCapture = { present: false };

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
    onInitialize: (params) => { initialize = captureInitialize(params); void record('startup'); },
    callTool: async (_name, params) => {
      const obs = await record('tool_call', isObject(params) ? params : undefined);
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

if (process.argv[1] && isMainModule(import.meta.url, fileURLToPath(import.meta.url) === process.argv[1] ? process.argv[1] : process.argv[1])) {
  await runServer();
}
```

Note on the entrypoint guard: match the existing `src/cli.ts` pattern —
`if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) { await runServer(); }`. Use that exact form (the ternary above is a drafting artifact; replace it with the plain guard).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/identity-probe/server.test.ts`
Expected: PASS (3 tests). If the child-process test is flaky on timing, increase the two `setTimeout` waits; do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add tools/identity-probe/report.ts tools/identity-probe/server.ts tools/identity-probe/server.test.ts
git commit -m "chore: add identity-probe MCP server, tool, and report appender"
```

---

### Task 5: Findings scaffold, README, run script, full verification

**Files:**
- Create: `tools/identity-probe/FINDINGS.md`
- Create: `tools/identity-probe/README.md`
- Modify: `package.json` (add `"identity-probe"` script)

**Interfaces:**
- Consumes: the runnable `tools/identity-probe/server.ts` (Task 4).
- Produces: no code interface; documentation + a run script.

- [ ] **Step 1: Add the run script to `package.json`**

In `"scripts"`, after `"live-feed"`, add:

```json
    "identity-probe": "node tools/identity-probe/server.ts"
```

- [ ] **Step 2: Write `tools/identity-probe/README.md`**

Content must cover, in prose an engineer with zero context can follow:
- What the probe is and the honesty guarantee (no secrets, no file bytes, paths home-relativized, `*.jsonl` log is gitignored; only `FINDINGS.md` is committed and it is hand-redacted).
- **Claude Code wiring** (user-level, Conductor stays launcher): add to `~/.claude/mcp.json` (or the user MCP config) a server entry:
  ```json
  { "mcpServers": { "slipstream-identity-probe": { "command": "node", "args": ["<abs-path>/tools/identity-probe/server.ts"] } } }
  ```
  Then, in a Conductor-launched Claude session, call the `identity_probe_snapshot` tool and inspect `~/.slipstream-identity-probe/observations.jsonl` (or `$SLIPSTREAM_IDENTITY_PROBE_LOG`).
- **Codex wiring** (user-level): the equivalent `~/.codex/config.toml` `[mcp_servers.slipstream-identity-probe]` entry with `command`/`args`, per Codex MCP config docs; then call the tool in a Codex session.
- How to read the log and how to fill `FINDINGS.md`.
- Explicit statement: **Slipstream does not launch the harness**; the operator wires the probe and drives real sessions.

- [ ] **Step 3: Write `tools/identity-probe/FINDINGS.md`**

A committed scaffold with: a header stating "unfilled rows are UNMEASURED, not confirmed"; a place to record Conductor version + observed `clientInfo.version` per harness; and this scenario matrix (one row per run, columns: harness, scenario, `initialize.clientInfo`, startup `CLAUDE_CODE_SESSION_ID`/`CODEX_*` present?, tool-call `_meta` present + value shape, does startup id == tool-call id?, canonical worktree correlatable?, notes):

  1. Fresh launch (both harnesses)
  2. Explicit resume
  3. Implicit resume / continue
  4. `/clear` (Claude) / session change
  5. MCP reconnect (same session)
  6. Two harness sessions in the **same** worktree (are they distinguishable?)
  7. Three Conductor worktrees (exact identity + root per each)
  8. Skill inheritance from user-level config into a session Slipstream did not launch (both harnesses)

  End with a "Verdict for SC3" section (blank) to be written from the evidence: does either/both harness expose verified, fresh identity correlatable to a canonical worktree *before* a declaration? If not, state SC3 is blocked as written.

- [ ] **Step 4: Run the full tool test tier and typecheck**

Run: `npm run test:tools`
Expected: PASS (all `tools/**/*.test.ts`, including the existing live-feed tests and the four new probe test files).

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Confirm no captured data is staged**

Run: `git status --porcelain` and confirm no `*.jsonl` and no `.slipstream*` paths are staged. The observation log must never be committed.

- [ ] **Step 6: Commit**

```bash
git add tools/identity-probe/FINDINGS.md tools/identity-probe/README.md package.json
git commit -m "chore: document identity-probe wiring and findings scaffold"
```

---

## Self-Review

**1. Spec coverage:**
- Minimal real MCP stdio server → Tasks 3 (dispatch) + 4 (stdio loop, child-process smoke test). ✓
- Single `identity_probe_snapshot` diagnostic tool → Task 4. ✓
- Redaction + allowlist honesty boundary → Task 1; enforced by adversarial no-leak tests in Tasks 1 & 2. ✓
- Observation record shape (`identity-probe-observation.v1`, explicit absence, home-relative paths) → Task 2. ✓
- Findings scaffold + both-harness wiring, Conductor stays launcher → Task 5. ✓
- CI-tier unit tests via synthetic client, never treated as real-harness evidence → Tasks 1–4 tests + FINDINGS.md disclaimer. ✓
- No production event/schema/IPC/CLI/error-code; log gitignored → Global Constraints + Task 5 Step 5. ✓

**2. Placeholder scan:** every code step contains real code; the one drafting artifact (the entrypoint-guard ternary) is called out explicitly with the exact replacement. No "TBD"/"handle edge cases".

**3. Type consistency:** `Observation`, `InitializeCapture`, `ToolCallCapture`, `EnvField`, `McpHandlers`, `ToolDef`, `JsonRpcRequest/Response` are defined once (Tasks 1–3) and consumed with matching names/signatures in Task 4. `buildObservation` / `captureInitialize` / `dispatch` / `parseMessage` / `appendObservation` / `createProbeHandlers` signatures match their call sites.

## After this PR (not part of it)

Filling `FINDINGS.md` requires operator-run real Conductor sessions for both harnesses. That evidence — not this code — is what closes or blocks SC3, and it feeds the PR 3 attach design. The `subject` ruling (D2=A) and shared-daemon topology (D3=accepted) bind PR 2 / PR 3, not this one.
