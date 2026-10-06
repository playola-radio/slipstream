/** Additive public events outside the byte-frozen display-fold.v1 dependencies. */
import { EVENT_TYPES, buildEnvelope, sourceFor, SPEC_VERSION, DATA_CONTENT_TYPE, type AnyEvent, type EventInput, type HarnessName } from './event.ts';
import type { QuestionContext } from './questions.ts';

export const PUBLIC_EVENT_TYPES = [...EVENT_TYPES, 'slipstream.question.queued.v1', 'slipstream.question.dispatch_attempted.v1',
  'slipstream.question.answered.v1', 'slipstream.capture.scope.v1'] as const;
export interface QuestionQueuedData {
  session_id: string;
  question_id: string;
  request_id: string;
  target: { harness: HarnessName; harness_session_id: string; worktree: string };
  text: string;
  context: QuestionContext & { selected_text: string };
  queued_at_ms: number;
  expires_at_ms: number;
  reply_to_question_id?: string;
}
export interface QuestionQueuedEvent {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: 'slipstream.question.queued.v1';
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  subject: string;
  data: QuestionQueuedData;
}
export interface QuestionDispatchAttemptedEvent {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: 'slipstream.question.dispatch_attempted.v1';
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  subject: string;
  data: { session_id: string; question_id: string; queued_seq: string; attempted_at_ms: number };
}
export interface QuestionAnsweredData {
  session_id: string;
  question_id: string;
  attempt_seq: string;
  text: string;
  answered_at_ms: number;
}
export interface QuestionAnsweredEvent {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: 'slipstream.question.answered.v1';
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  subject: string;
  data: QuestionAnsweredData;
}
/** Which paths capture follows, and whether that filter is currently working.
 * `git`: paths git would not merge (ignored and untracked) are out of scope.
 * `filesystem`: the root is not a git work tree, so every path is in scope. */
export type CaptureScopeData =
  | { session_id: string; policy: 'git'; status: 'active' }
  | { session_id: string; policy: 'git'; status: 'unavailable' }
  | { session_id: string; policy: 'filesystem'; status: 'active' };
export interface CaptureScopeEvent {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: 'slipstream.capture.scope.v1';
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  /** Never set; declared so every public event shares the envelope shape. */
  subject?: undefined;
  data: CaptureScopeData;
}
type WithoutSessionId<T> = T extends unknown ? Omit<T, 'session_id'> : never;
export type CaptureScopeInput = { type: 'slipstream.capture.scope.v1'; occurred_at_ms: number; data: WithoutSessionId<CaptureScopeData> };
export type PublicEvent = AnyEvent | QuestionQueuedEvent | QuestionDispatchAttemptedEvent | QuestionAnsweredEvent | CaptureScopeEvent;
export type QuestionQueuedInput = { type: 'slipstream.question.queued.v1'; occurred_at_ms: number; data: Omit<QuestionQueuedData, 'session_id'> };
export type QuestionDispatchAttemptedInput = { type: 'slipstream.question.dispatch_attempted.v1'; occurred_at_ms: number; data: { question_id: string; queued_seq: string; attempted_at_ms: number } };
export type QuestionAnsweredInput = { type: 'slipstream.question.answered.v1'; occurred_at_ms: number; data: Omit<QuestionAnsweredData, 'session_id'> };
export type PublicEventInput = EventInput | QuestionQueuedInput | QuestionDispatchAttemptedInput | QuestionAnsweredInput | CaptureScopeInput;
export function buildPublicEnvelope(input: PublicEventInput, seq: bigint, sessionId: string): PublicEvent {
  if (input.type === 'slipstream.capture.scope.v1') return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId), type: input.type,
    datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(), time: new Date(input.occurred_at_ms).toISOString(),
    data: { ...input.data, session_id: sessionId } as CaptureScopeData,
  };
  if (input.type !== 'slipstream.question.queued.v1' && input.type !== 'slipstream.question.dispatch_attempted.v1'
    && input.type !== 'slipstream.question.answered.v1') return buildEnvelope(input, seq, sessionId);
  if (input.type === 'slipstream.question.dispatch_attempted.v1') return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId), type: input.type,
    datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(), time: new Date(input.occurred_at_ms).toISOString(),
    subject: `question/${input.data.question_id}`, data: { ...input.data, session_id: sessionId },
  };
  if (input.type === 'slipstream.question.answered.v1') return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId), type: input.type,
    datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(), time: new Date(input.occurred_at_ms).toISOString(),
    subject: `question/${input.data.question_id}`, data: { ...input.data, session_id: sessionId },
  };
  return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId),
    type: input.type, datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(),
    time: new Date(input.occurred_at_ms).toISOString(), subject: `question/${input.data.question_id}`,
    data: { ...input.data, session_id: sessionId },
  };
}
