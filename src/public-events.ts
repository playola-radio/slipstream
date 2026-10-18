/** Additive public events outside the byte-frozen display-fold.v1 dependencies. */
import { EVENT_TYPES, buildEnvelope, sourceFor, SPEC_VERSION, DATA_CONTENT_TYPE, type AnyEvent, type EventInput, type HarnessName } from './event.ts';
import type { QuestionContext } from './questions.ts';

export const PUBLIC_EVENT_TYPES = [...EVENT_TYPES, 'slipstream.question.queued.v1', 'slipstream.question.dispatch_attempted.v1',
  'slipstream.question.answered.v1', 'slipstream.capture.scope.v1', 'slipstream.agent.connection.v1',
  'slipstream.capture.ready.v1', 'slipstream.capture.stopped.v1', 'slipstream.agent.binding.v1',
  'slipstream.agent.unlinked.v1'] as const;
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
/** `slipstream_ignore: 'active'` means a root `.slipstreamignore` was frozen at
 * capture start and is excluding extra paths (git-only; a non-git root ignores
 * the file). Absent means no such file was in effect. */
export type CaptureScopeData =
  | { session_id: string; policy: 'git'; status: 'active'; slipstream_ignore?: 'active' }
  | { session_id: string; policy: 'git'; status: 'unavailable'; slipstream_ignore?: 'active' }
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
/** Whether the chat bound at attach can take questions. `connected` records one
 * completed setup round trip (hook delivery and answer return) at event time. */
export interface AgentConnectionData {
  session_id: string;
  state: 'setup_pending' | 'connected';
  /** The binding this handshake belongs to; absent only on legacy records. */
  binding_generation?: string;
  target: { harness: HarnessName; harness_session_id: string };
}
export interface AgentConnectionEvent {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: 'slipstream.agent.connection.v1';
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  subject?: undefined;
  data: AgentConnectionData;
}
/** How an activation started, written on `session.started`/`session.resumed`.
 * Absent means a chat attach started it; it is never inferred from absence. */
export type CaptureMode = 'watch-only';
export type CaptureStopReason = 'detached' | 'archived' | 'maintenance' | 'root-missing' | 'watcher-failed';
export type UnlinkReason = 'unlinked' | 'detached' | 'archived';
export interface BindingTarget { harness: HarnessName; harness_session_id: string; worktree: string }
/** `capture.ready`: this activation's baseline or reconciliation is complete. */
export interface CaptureReadyData { session_id: string }
/** `capture.stopped`: the final record of an activation that stopped cleanly. */
export interface CaptureStoppedData { session_id: string; reason: CaptureStopReason }
/** `agent.binding`: a chat was durably linked to this capture for question delivery. */
export interface AgentBindingData {
  session_id: string;
  binding_generation: string;
  target: BindingTarget;
  verified_transcript_path: string;
}
/** `agent.unlinked`: binding intent for that generation was revoked. */
export interface AgentUnlinkedData { session_id: string; binding_generation: string; reason: UnlinkReason }
interface LifecycleEnvelope<T extends string, D> {
  specversion: typeof SPEC_VERSION;
  id: string;
  source: string;
  type: T;
  datacontenttype: typeof DATA_CONTENT_TYPE;
  seq: string;
  time: string;
  subject?: undefined;
  data: D;
}
export type CaptureReadyEvent = LifecycleEnvelope<'slipstream.capture.ready.v1', CaptureReadyData>;
export type CaptureStoppedEvent = LifecycleEnvelope<'slipstream.capture.stopped.v1', CaptureStoppedData>;
export type AgentBindingEvent = LifecycleEnvelope<'slipstream.agent.binding.v1', AgentBindingData>;
export type AgentUnlinkedEvent = LifecycleEnvelope<'slipstream.agent.unlinked.v1', AgentUnlinkedData>;
type WithoutSessionId<T> = T extends unknown ? Omit<T, 'session_id'> : never;
export type CaptureScopeInput = { type: 'slipstream.capture.scope.v1'; occurred_at_ms: number; data: WithoutSessionId<CaptureScopeData> };
export type AgentConnectionInput = { type: 'slipstream.agent.connection.v1'; occurred_at_ms: number; data: Omit<AgentConnectionData, 'session_id'> };
export type CaptureReadyInput = { type: 'slipstream.capture.ready.v1'; occurred_at_ms: number; data: Omit<CaptureReadyData, 'session_id'> };
export type CaptureStoppedInput = { type: 'slipstream.capture.stopped.v1'; occurred_at_ms: number; data: Omit<CaptureStoppedData, 'session_id'> };
export type AgentBindingInput = { type: 'slipstream.agent.binding.v1'; occurred_at_ms: number; data: Omit<AgentBindingData, 'session_id'> };
export type AgentUnlinkedInput = { type: 'slipstream.agent.unlinked.v1'; occurred_at_ms: number; data: Omit<AgentUnlinkedData, 'session_id'> };
type LifecycleInput = CaptureScopeInput | AgentConnectionInput | CaptureReadyInput | CaptureStoppedInput | AgentBindingInput | AgentUnlinkedInput;
export type PublicEvent = AnyEvent | QuestionQueuedEvent | QuestionDispatchAttemptedEvent | QuestionAnsweredEvent | CaptureScopeEvent
  | AgentConnectionEvent | CaptureReadyEvent | CaptureStoppedEvent | AgentBindingEvent | AgentUnlinkedEvent;
export type QuestionQueuedInput = { type: 'slipstream.question.queued.v1'; occurred_at_ms: number; data: Omit<QuestionQueuedData, 'session_id'> };
export type QuestionDispatchAttemptedInput = { type: 'slipstream.question.dispatch_attempted.v1'; occurred_at_ms: number; data: { question_id: string; queued_seq: string; attempted_at_ms: number } };
export type QuestionAnsweredInput = { type: 'slipstream.question.answered.v1'; occurred_at_ms: number; data: Omit<QuestionAnsweredData, 'session_id'> };
export type PublicEventInput = EventInput | QuestionQueuedInput | QuestionDispatchAttemptedInput | QuestionAnsweredInput | LifecycleInput;
const LIFECYCLE_TYPES = new Set<string>(['slipstream.capture.scope.v1', 'slipstream.agent.connection.v1', 'slipstream.capture.ready.v1',
  'slipstream.capture.stopped.v1', 'slipstream.agent.binding.v1', 'slipstream.agent.unlinked.v1']);
const isLifecycleInput = (input: PublicEventInput): input is LifecycleInput => LIFECYCLE_TYPES.has(input.type);
export function buildPublicEnvelope(input: PublicEventInput, seq: bigint, sessionId: string): PublicEvent {
  if (isLifecycleInput(input)) return {
    specversion: SPEC_VERSION, id: seq.toString(), source: sourceFor(sessionId), type: input.type,
    datacontenttype: DATA_CONTENT_TYPE, seq: seq.toString(), time: new Date(input.occurred_at_ms).toISOString(),
    data: { ...input.data, session_id: sessionId },
  } as PublicEvent;
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
