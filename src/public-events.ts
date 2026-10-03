/** Additive public events outside the byte-frozen display-fold.v1 dependencies. */
import { EVENT_TYPES, buildEnvelope, sourceFor, SPEC_VERSION, DATA_CONTENT_TYPE, type AnyEvent, type EventInput, type HarnessName } from './event.ts';
import type { QuestionContext } from './questions.ts';
import type { CaptureIgnores } from './capture-ignores.ts';

/** Keep the released display fold's original event types byte-for-byte intact. */
type WithCaptureIgnores<T> = T extends { type: 'slipstream.session.started.v1' }
  ? T & { data: { capture_ignores?: CaptureIgnores } } : T;

export const PUBLIC_EVENT_TYPES = [...EVENT_TYPES, 'slipstream.question.queued.v1', 'slipstream.question.dispatch_attempted.v1',
  'slipstream.question.answered.v1'] as const;
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
export type PublicEvent = WithCaptureIgnores<AnyEvent> | QuestionQueuedEvent | QuestionDispatchAttemptedEvent | QuestionAnsweredEvent;
export type QuestionQueuedInput = { type: 'slipstream.question.queued.v1'; occurred_at_ms: number; data: Omit<QuestionQueuedData, 'session_id'> };
export type QuestionDispatchAttemptedInput = { type: 'slipstream.question.dispatch_attempted.v1'; occurred_at_ms: number; data: { question_id: string; queued_seq: string; attempted_at_ms: number } };
export type QuestionAnsweredInput = { type: 'slipstream.question.answered.v1'; occurred_at_ms: number; data: Omit<QuestionAnsweredData, 'session_id'> };
export type PublicEventInput = WithCaptureIgnores<EventInput> | QuestionQueuedInput | QuestionDispatchAttemptedInput | QuestionAnsweredInput;
export function buildPublicEnvelope(input: PublicEventInput, seq: bigint, sessionId: string): PublicEvent {
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
