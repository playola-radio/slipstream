/** Additive public events outside the byte-frozen display-fold.v1 dependencies. */
import { EVENT_TYPES, buildEnvelope, sourceFor, SPEC_VERSION, DATA_CONTENT_TYPE, type AnyEvent, type EventInput, type HarnessName } from './event.ts';
import type { QuestionContext } from './questions.ts';

export const PUBLIC_EVENT_TYPES = [...EVENT_TYPES, 'slipstream.question.queued.v1'] as const;
export interface QuestionQueuedData {
  session_id: string;
  question_id: string;
  request_id: string;
  target: { harness: HarnessName; harness_session_id: string; worktree: string };
  text: string;
  context: QuestionContext & { selected_text: string };
  queued_at_ms: number;
  expires_at_ms: number;
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
export type PublicEvent = AnyEvent | QuestionQueuedEvent;
export type QuestionQueuedInput = { type: 'slipstream.question.queued.v1'; occurred_at_ms: number; data: Omit<QuestionQueuedData, 'session_id'> };
export type PublicEventInput = EventInput | QuestionQueuedInput;
export function buildPublicEnvelope(input: PublicEventInput, seq: bigint, sessionId: string): PublicEvent {
  if (input.type !== 'slipstream.question.queued.v1') return buildEnvelope(input, seq, sessionId);
  return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId),
    type: input.type, datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(),
    time: new Date(input.occurred_at_ms).toISOString(), subject: `question/${input.data.question_id}`,
    data: { ...input.data, session_id: sessionId },
  };
}
