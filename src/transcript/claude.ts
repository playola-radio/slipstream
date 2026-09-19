import type { EvidenceFileScope } from '../event.ts';
import type { NormalizedEvidence } from '../evidence-ingest.ts';
import { scopeFromPaths, type AdapterContext, type Diagnostic, type StepResult } from './types.ts';

/**
 * Pure Claude Code transcript adapter.
 *
 * A Claude transcript is one JSON object per line. An `assistant` record carries
 * `message.content[]` blocks; each `tool_use` block is one logical invocation
 * whose native id is `tool_use.id` (`toolu_…`) — that id, namespaced by the
 * harness session, is the evidence `record_id`. The tool RESULT arrives later as
 * a `user` record with a `tool_result` block referencing `tool_use_id`; it
 * carries no tool name or scope, so we remember the start's tool/scope and emit
 * the end record under the SAME key/tool/scope (a time span for the invocation),
 * never a provisional record we would later have to "correct".
 *
 * Tool taxonomy (A2 adapter knowledge): known write tools expose paths; known
 * read-only tools emit nothing; everything else — Bash, unrecognized names —
 * emits an explicit unknown scope (a possible writer we cannot map), because
 * silently dropping an unknown effect would be dishonest.
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READONLY_TOOLS = new Set([
  'Read',
  'NotebookRead',
  'Grep',
  'Glob',
  'LS',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Task',
  'BashOutput',
  'KillShell',
]);

interface StartMemo {
  sessionId: string;
  toolName: string;
  scope: EvidenceFileScope;
}

export interface ClaudeState {
  /** tool_use id → the start's tool/scope, so its later result can be joined. */
  pending: Map<string, StartMemo>;
}

export function initialClaudeState(): ClaudeState {
  return { pending: new Map() };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseMs(record: Record<string, unknown>): number | undefined {
  const ts = record.timestamp;
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The write path a known write tool declared, or undefined if it is missing. */
function writePath(toolName: string, input: Record<string, unknown>): string | undefined {
  const field = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const value = input[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function scopeForTool(
  toolName: string,
  input: unknown,
  ctx: AdapterContext,
): { scope: EvidenceFileScope; diagnostics: Diagnostic[] } | 'skip' {
  if (READONLY_TOOLS.has(toolName)) return 'skip';
  if (WRITE_TOOLS.has(toolName)) {
    const path = isObject(input) ? writePath(toolName, input) : undefined;
    if (path === undefined) {
      return {
        scope: { kind: 'unknown', reason: `${toolName} record declared no file path` },
        diagnostics: [{ kind: 'malformed', detail: `${toolName} without a file path` }],
      };
    }
    const scope = scopeFromPaths([path], ctx);
    // A write outside the capture root is out of scope for this session.
    if (!scope) return 'skip';
    return { scope, diagnostics: [] };
  }
  // Bash or an unrecognized tool: a possible writer we cannot scope.
  return {
    scope: { kind: 'unknown', reason: `unmapped tool ${toolName}` },
    diagnostics: [],
  };
}

function makeEvidence(
  ctx: AdapterContext,
  harnessSessionId: string,
  recordId: string,
  toolName: string,
  scope: EvidenceFileScope,
  atMs: number,
  basis: 'tool-start' | 'tool-end',
): NormalizedEvidence {
  return {
    evidence_key: {
      harness: ctx.harness,
      harness_session_id: harnessSessionId,
      record_id: recordId,
    },
    adapter_version: ctx.adapterVersion,
    tool_name: toolName,
    timestamp: { at_ms: atMs, basis },
    file_scope: scope,
  };
}

function stepAssistant(
  state: ClaudeState,
  record: Record<string, unknown>,
  ctx: AdapterContext,
): StepResult<ClaudeState> {
  const evidence: NormalizedEvidence[] = [];
  const diagnostics: Diagnostic[] = [];
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) {
    // Every Claude assistant record carries a `message.content` array of blocks.
    // Anything else — a string, a null/absent message, a missing content — is a
    // malformed envelope, not a clean read: disclose it so coverage degrades and
    // stays distinct from a successfully-read record with no tool evidence. (User
    // records, whose content is legitimately a string, are handled separately.)
    diagnostics.push({ kind: 'malformed', detail: 'assistant record has no content block array' });
    return { state, evidence, diagnostics };
  }
  const atMs = parseMs(record);
  // The harness session is the record's own `sessionId` (the native session), so
  // a copied/renamed transcript keeps one identity instead of splitting into
  // filename-derived candidates; the bound file name is only a fallback.
  const rawSession = record.sessionId;
  const sessionId =
    typeof rawSession === 'string' && rawSession.length > 0 ? rawSession : ctx.harnessSessionId;
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use') continue;
    const id = block.id;
    const toolName = block.name;
    // A missing/empty invocation id is not a stable identity we can key: report it
    // unsupported (never a fabricated or empty key that would collide).
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.push({ kind: 'unsupported', detail: 'tool_use without a stable id' });
      continue;
    }
    if (typeof toolName !== 'string' || toolName.length === 0) {
      diagnostics.push({ kind: 'malformed', detail: `tool_use ${id} without a tool name` });
      continue;
    }
    const resolved = scopeForTool(toolName, block.input, ctx);
    if (resolved === 'skip') continue;
    diagnostics.push(...resolved.diagnostics);
    if (atMs === undefined) {
      diagnostics.push({ kind: 'malformed', detail: `tool_use ${id} has no usable timestamp` });
      continue;
    }
    state.pending.set(id, { sessionId, toolName, scope: resolved.scope });
    evidence.push(makeEvidence(ctx, sessionId, id, toolName, resolved.scope, atMs, 'tool-start'));
  }
  return { state, evidence, diagnostics };
}

function stepUser(
  state: ClaudeState,
  record: Record<string, unknown>,
  ctx: AdapterContext,
): StepResult<ClaudeState> {
  const evidence: NormalizedEvidence[] = [];
  const diagnostics: Diagnostic[] = [];
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) return { state, evidence, diagnostics };
  const atMs = parseMs(record);
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (typeof id !== 'string') continue;
    const memo = state.pending.get(id);
    // An orphan result (start never seen) carries no tool/scope to emit honestly;
    // the start, if it is ever read, records the invocation on its own.
    if (!memo) continue;
    if (atMs === undefined) continue;
    evidence.push(makeEvidence(ctx, memo.sessionId, id, memo.toolName, memo.scope, atMs, 'tool-end'));
  }
  return { state, evidence, diagnostics };
}

/** Fold one parsed Claude transcript record into the running adapter state. */
export function claudeStep(
  state: ClaudeState,
  record: unknown,
  ctx: AdapterContext,
): StepResult<ClaudeState> {
  if (!isObject(record)) {
    return { state, evidence: [], diagnostics: [{ kind: 'malformed', detail: 'record is not an object' }] };
  }
  if (record.type === 'assistant') return stepAssistant(state, record, ctx);
  if (record.type === 'user') return stepUser(state, record, ctx);
  return { state, evidence: [], diagnostics: [] };
}
