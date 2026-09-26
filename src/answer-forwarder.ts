/**
 * answer_question orchestration for the MCP forwarder.
 *
 * The daemon keeps one immutable answer per question and replays an identical
 * text as a duplicate, so a lost or malformed reply after the request was sent is
 * resolved by exactly one identical resend. On that resend only a structural
 * rejection proves nothing was recorded; anything else (a replaced capture, a
 * storage fault, a second lost reply) may follow a first send that committed, so
 * it collapses to OUTCOME_UNKNOWN instead of implying the answer was not recorded.
 */
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { isResolved, type IdentityResult } from './harness-context.ts';
import type { ToolResult } from './mcp-protocol.ts';

export interface ForwardAnswerDeps {
  identity: IdentityResult;
  questionId: string;
  text: string;
  /** Send one control request. Resolves a response envelope (including a
   * synthesized DAEMON_UNAVAILABLE) or throws {@link OutcomeUnknownError}. */
  send: (request: RequestEnvelope) => Promise<ResponseEnvelope>;
}

const DEFINITIVE_ON_RESEND = new Set(['INVALID_ANSWER', 'IDENTITY_UNRESOLVED', 'ANSWER_CONFLICT']);

function recordedAck(res: ResponseEnvelope, questionId: string): Record<string, unknown> | null {
  if (!res.ok || res.question_id !== questionId || typeof res.seq !== 'string' || res.seq.length === 0
    || res.event_id !== res.seq) return null;
  const { v: _v, ok: _ok, ...ack } = res;
  return ack;
}

function failure(code: string, message: string): ToolResult {
  return { text: `${code}: ${message}`, isError: true, structured: { code } };
}

const outcomeUnknown = (): ToolResult => failure('OUTCOME_UNKNOWN',
  'the answer was sent but whether it was recorded could not be confirmed; resending the identical text is safe, different text is not');

export async function forwardAnswer(deps: ForwardAnswerDeps): Promise<ToolResult> {
  if (!isResolved(deps.identity)) return failure('IDENTITY_UNRESOLVED', deps.identity.unresolved);
  const envelope: RequestEnvelope = {
    v: 1,
    verb: 'answer_question',
    question_id: deps.questionId,
    text: deps.text,
    harness: deps.identity.harness,
    harness_session_id: deps.identity.harness_session_id,
    worktree: deps.identity.worktree,
  };
  for (const resend of [false, true]) {
    let res: ResponseEnvelope;
    try { res = await deps.send(envelope); } catch (err) {
      if (err instanceof OutcomeUnknownError) continue;
      throw err;
    }
    const ack = recordedAck(res, deps.questionId);
    if (ack) {
      return { text: `Answer recorded for question ${deps.questionId} (seq ${String(ack.seq)}).`, isError: false, structured: ack };
    }
    if (!res.ok && (!resend || DEFINITIVE_ON_RESEND.has(res.code))) return failure(res.code, res.message);
    if (resend) break;
  }
  return outcomeUnknown();
}
