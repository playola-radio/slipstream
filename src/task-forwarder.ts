/**
 * begin_task orchestration for the MCP forwarder.
 *
 * The forwarder is a control client that emits exactly one mutation — begin_task —
 * and must never lie to the agent about whether it committed. Two rules from the
 * locked design (Codex consult) drive this file:
 *
 *  1. Post-send ambiguity is real. The control client throws {@link
 *     OutcomeUnknownError} when a request reached the wire but its outcome is
 *     unknowable. Because `session.beginTask` idempotency is durable and anchored
 *     on `request_id` (the daemon rebuilds `committedTasks` from the log), we can
 *     safely auto-resend the BYTE-IDENTICAL payload EXACTLY once — a same-UUID
 *     resend resolves idempotently, never double-committing. Only a begin_task
 *     with a nonempty request_id qualifies (see {@link shouldAutoResend}); a
 *     generic ambiguous request is never blindly retried.
 *
 *  2. When the resend cannot definitively resolve the first send, we must not
 *     imply "nothing committed." A structurally-rejected resend (INVALID_TITLE /
 *     IDENTITY_UNRESOLVED) proves nothing durable happened, so it replaces the
 *     unknown honestly. A SESSION_NOT_SELECTED resend is reported as
 *     selection-unavailable with the prior commit status explicitly UNKNOWN
 *     (the daemon may have committed before it lost the session). Anything else
 *     still ambiguous — a second OutcomeUnknown, or a transient daemon/storage
 *     error — collapses to OUTCOME_UNKNOWN, which tells the agent NOT to
 *     re-declare (a fresh declaration would be a new task, never a retry).
 */
import { randomUUID } from 'node:crypto';
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { isResolved, type IdentityResult } from './harness-context.ts';
import type { ToolResult } from './mcp-protocol.ts';

export interface ForwardBeginTaskDeps {
  identity: IdentityResult;
  title: string;
  /** Injectable idempotency key; production mints a fresh UUID per call. */
  requestId?: string;
  /** Send one control request. Resolves a response envelope (including a
   * synthesized DAEMON_UNAVAILABLE) or throws {@link OutcomeUnknownError}. */
  send: (request: RequestEnvelope) => Promise<ResponseEnvelope>;
}

/** Only a begin_task carrying a nonempty request_id is safe to auto-resend: the
 * request_id is the durable idempotency key that makes an identical resend commit
 * at most once. Any other verb, or a missing key, must never be blindly retried. */
export function shouldAutoResend(envelope: RequestEnvelope): boolean {
  return envelope.verb === 'begin_task' && typeof envelope.request_id === 'string' && envelope.request_id.length > 0;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** A control ack proves a durable commit only if it carries all four task-commit
 * identifiers. The control-client envelope validator accepts any `ok:true` shape,
 * so an ack missing (or mistyping) these fields is NOT a confirmed commit — it is
 * post-send ambiguity, handled exactly like an {@link OutcomeUnknownError}. */
function isCommittedAck(res: ResponseEnvelope): res is ResponseEnvelope & { ok: true } {
  return (
    res.ok === true &&
    nonEmptyString(res.session_id) &&
    nonEmptyString(res.task_id) &&
    nonEmptyString(res.event_id) &&
    nonEmptyString(res.seq)
  );
}

function successResult(res: ResponseEnvelope & { ok: true }): ToolResult {
  const structured = {
    session_id: res.session_id,
    task_id: res.task_id,
    event_id: res.event_id,
    seq: res.seq,
  } as Record<string, unknown>;
  return {
    text: `Task declared. session=${String(res.session_id)} task=${String(res.task_id)} seq=${String(res.seq)}`,
    isError: false,
    structured,
  };
}

function errorResult(code: string, text: string, requestId?: string): ToolResult {
  const structured: Record<string, unknown> = { code };
  if (requestId !== undefined) structured.request_id = requestId;
  return { text, isError: true, structured };
}

function outcomeUnknown(requestId: string): ToolResult {
  return errorResult(
    'OUTCOME_UNKNOWN',
    `OUTCOME_UNKNOWN: the declaration reached the daemon but its outcome could not be confirmed for request_id ${requestId}; do not re-declare — a fresh declaration would create a second task.`,
    requestId,
  );
}

/** Map the RESEND response while resolving an earlier OutcomeUnknown. */
function mapResendResponse(res: ResponseEnvelope, requestId: string): ToolResult {
  if (res.ok) return isCommittedAck(res) ? successResult(res) : outcomeUnknown(requestId);
  switch (res.code) {
    case 'INVALID_TITLE':
    case 'IDENTITY_UNRESOLVED':
      // Structurally rejected — a durable commit was impossible either time, so
      // this cleanly replaces the unknown.
      return errorResult(res.code, `${res.code}: ${res.message}`, requestId);
    case 'SESSION_NOT_SELECTED':
      // The daemon may have committed on the first send before it lost selection;
      // report selection-unavailable WITHOUT claiming "not committed".
      return errorResult(
        'SESSION_NOT_SELECTED',
        `SESSION_NOT_SELECTED: selection unavailable; prior commit status unknown for request_id ${requestId}`,
        requestId,
      );
    default:
      // DAEMON_UNAVAILABLE / CAPTURE_NOT_READY / STORAGE_UNAVAILABLE / PROTOCOL:
      // transient or ambiguous, and does not prove the first send failed to
      // commit. Reporting the transient code would imply "safe to retry" — a lie.
      return outcomeUnknown(requestId);
  }
}

export async function forwardBeginTask(deps: ForwardBeginTaskDeps): Promise<ToolResult> {
  if (!isResolved(deps.identity)) {
    // Fail closed before any round trip: we cannot ship a verified triple.
    return errorResult('IDENTITY_UNRESOLVED', `IDENTITY_UNRESOLVED: ${deps.identity.unresolved}`);
  }

  const requestId = deps.requestId ?? randomUUID();
  // The optional session_id guard is intentionally omitted: the forwarder never
  // attaches and so does not know the capture UUID, and carrying one forward from
  // a prior task would wrongly reject a legitimate later task. Selection rests on
  // the identity triple, which the daemon compares atomically.
  const envelope: RequestEnvelope = {
    v: 1,
    verb: 'begin_task',
    title: deps.title,
    request_id: requestId,
    harness: deps.identity.harness,
    harness_session_id: deps.identity.harness_session_id,
    worktree: deps.identity.worktree,
  };

  try {
    const res = await deps.send(envelope);
    if (res.ok) {
      // A well-formed commit ack is the only definitive success. A malformed
      // `ok:true` proves nothing durable, so it falls through to the one resend
      // exactly like a post-send OutcomeUnknown.
      if (isCommittedAck(res)) return successResult(res);
    } else {
      return errorResult(res.code, `${res.code}: ${res.message}`, requestId);
    }
  } catch (err) {
    if (!(err instanceof OutcomeUnknownError)) throw err;
    // fall through to the single byte-identical resend
  }

  if (!shouldAutoResend(envelope)) return outcomeUnknown(requestId);

  try {
    return mapResendResponse(await deps.send(envelope), requestId);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) return outcomeUnknown(requestId);
    throw err;
  }
}
