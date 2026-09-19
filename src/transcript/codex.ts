import type { EvidenceFileScope } from '../event.ts';
import type { NormalizedEvidence } from '../evidence-ingest.ts';
import { scopeFromPaths, type AdapterContext, type Diagnostic, type StepResult } from './types.ts';

/**
 * Pure Codex transcript adapter.
 *
 * A Codex rollout is one JSON object per line. A `session_meta` line binds the
 * session (`payload.id`, `payload.cwd`); the plumbing uses it for discovery, so
 * the core reads identity/cwd from its context, not from the record. A
 * `response_item` line carries a tool call in `payload`:
 * - `function_call` (`shell`, …): a command we do not parse — an unknown-scope
 *   possible writer. Its native id is `call_id`.
 * - `custom_tool_call` `apply_patch`: a structured patch whose envelope names the
 *   files it touches (`*** Add/Update/Delete File:`, `*** Move to:`), resolved
 *   against the invocation cwd. Any other custom tool is unknown-scope.
 * The matching `*_output` line is the tool result, joined to its start as a
 * same-key tool-end span.
 *
 * We deliberately do NOT scan arbitrary shell text for patch markers (a heredoc
 * `apply_patch` stays unknown-scope): recognizing patch effects only from the
 * structured envelope keeps a fabricated scope from a shell we cannot truly read.
 */
interface StartMemo {
  toolName: string;
  scope: EvidenceFileScope;
}

export interface CodexState {
  pending: Map<string, StartMemo>;
}

export function initialCodexState(): CodexState {
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

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/** Extract every file path an apply_patch envelope names, in order. */
export function applyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const m = PATCH_HEADER.exec(line.trimEnd());
    if (m) paths.push(m[1]!.trim());
  }
  return paths;
}

function makeEvidence(
  ctx: AdapterContext,
  recordId: string,
  toolName: string,
  scope: EvidenceFileScope,
  atMs: number,
  basis: 'tool-start' | 'tool-end',
): NormalizedEvidence {
  return {
    evidence_key: {
      harness: ctx.harness,
      harness_session_id: ctx.harnessSessionId,
      record_id: recordId,
    },
    adapter_version: ctx.adapterVersion,
    tool_name: toolName,
    timestamp: { at_ms: atMs, basis },
    file_scope: scope,
  };
}

/** The scope a Codex call declares, or `skip` when it is entirely out of root. */
function scopeForCall(
  payloadType: string,
  name: string,
  payload: Record<string, unknown>,
  ctx: AdapterContext,
): { toolName: string; scope: EvidenceFileScope; diagnostics: Diagnostic[] } | 'skip' {
  if (payloadType === 'custom_tool_call' && name === 'apply_patch') {
    const input = payload.input;
    if (typeof input !== 'string') {
      return {
        toolName: 'apply_patch',
        scope: { kind: 'unknown', reason: 'apply_patch input was not text' },
        diagnostics: [{ kind: 'malformed', detail: 'apply_patch without a text patch' }],
      };
    }
    const paths = applyPatchPaths(input);
    if (paths.length === 0) {
      return {
        toolName: 'apply_patch',
        scope: { kind: 'unknown', reason: 'apply_patch named no files' },
        diagnostics: [{ kind: 'malformed', detail: 'apply_patch envelope named no files' }],
      };
    }
    const scope = scopeFromPaths(paths, ctx);
    if (!scope) return 'skip';
    return { toolName: 'apply_patch', scope, diagnostics: [] };
  }
  // A shell command or any unrecognized custom tool: a possible writer we cannot
  // scope from its structured fields.
  return {
    toolName: name,
    scope: { kind: 'unknown', reason: `unmapped ${payloadType} ${name}` },
    diagnostics: [],
  };
}

function stepCall(
  state: CodexState,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  ctx: AdapterContext,
): StepResult<CodexState> {
  const callId = payload.call_id;
  const name = payload.name;
  const payloadType = payload.type;
  if (typeof callId !== 'string' || typeof name !== 'string' || typeof payloadType !== 'string') {
    return { state, evidence: [], diagnostics: [{ kind: 'malformed', detail: 'tool call without call_id/name' }] };
  }
  const resolved = scopeForCall(payloadType, name, payload, ctx);
  if (resolved === 'skip') return { state, evidence: [], diagnostics: [] };
  const atMs = parseMs(record);
  if (atMs === undefined) {
    return { state, evidence: [], diagnostics: [{ kind: 'malformed', detail: `call ${callId} has no usable timestamp` }] };
  }
  state.pending.set(callId, { toolName: resolved.toolName, scope: resolved.scope });
  return {
    state,
    evidence: [makeEvidence(ctx, callId, resolved.toolName, resolved.scope, atMs, 'tool-start')],
    diagnostics: resolved.diagnostics,
  };
}

function stepOutput(
  state: CodexState,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  ctx: AdapterContext,
): StepResult<CodexState> {
  const callId = payload.call_id;
  if (typeof callId !== 'string') return { state, evidence: [], diagnostics: [] };
  const memo = state.pending.get(callId);
  if (!memo) return { state, evidence: [], diagnostics: [] };
  const atMs = parseMs(record);
  if (atMs === undefined) return { state, evidence: [], diagnostics: [] };
  return {
    state,
    evidence: [makeEvidence(ctx, callId, memo.toolName, memo.scope, atMs, 'tool-end')],
    diagnostics: [],
  };
}

/** Fold one parsed Codex rollout record into the running adapter state. */
export function codexStep(
  state: CodexState,
  record: unknown,
  ctx: AdapterContext,
): StepResult<CodexState> {
  if (!isObject(record)) {
    return { state, evidence: [], diagnostics: [{ kind: 'malformed', detail: 'record is not an object' }] };
  }
  if (record.type !== 'response_item') return { state, evidence: [], diagnostics: [] };
  const payload = record.payload;
  if (!isObject(payload) || typeof payload.type !== 'string') return { state, evidence: [], diagnostics: [] };
  const t = payload.type;
  if (t === 'function_call' || t === 'custom_tool_call') return stepCall(state, record, payload, ctx);
  if (t === 'function_call_output' || t === 'custom_tool_call_output') return stepOutput(state, record, payload, ctx);
  return { state, evidence: [], diagnostics: [] };
}
