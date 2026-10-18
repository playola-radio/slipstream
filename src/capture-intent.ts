import type { HarnessName } from './event.ts';
import type { CaptureMode } from './public-events.ts';

/**
 * The daemon's capture and binding intent, in the shape of the durable intent
 * record (docs/autocapture/contracts.md §8), persisted by `intent-store.ts`.
 * Every function here is a synchronous mutation, so a caller holding no await
 * between its checks and the call gets the mutual exclusion the contract's
 * mutex asks for; the caller then persists before it acknowledges.
 */

/** Capture slots (spec D10). A slot is any `running` intent, whatever its state. */
export const MAX_CAPTURES = 16;
/** Linked chats store-wide. */
export const MAX_BINDINGS = 10;

export type NotRecordingReason =
  | 'daemon-unavailable' | 'root-overlap' | 'root-missing' | 'baseline-failed' | 'storage-unavailable'
  | 'watcher-failed' | 'resume-failed' | 'resource-limit' | 'stop-unconfirmed' | 'capture-limit-reached';

export interface CaptureFailure {
  reason: NotRecordingReason;
  message: string;
  at_ms: number;
  next_attempt_at_ms: number | null;
}

export interface CaptureIntent {
  session_id: string;
  root: string;
  root_identity: { dev: string; ino: string } | null;
  intent: 'running' | 'waiting' | 'withdrawn';
  withdrawn_reason: 'detached' | 'archived' | null;
  capture_mode: CaptureMode;
  last_failure: CaptureFailure | null;
}

export interface BindingIntent {
  session_id: string;
  harness: HarnessName;
  harness_session_id: string;
  canonical_worktree: string;
  verified_transcript_path: string;
  binding_generation: string;
  intent: 'linked' | 'revoked';
  unavailable: null | { reason: string; message: string };
}

export interface IntentRecord {
  version: 1;
  next_binding_generation: string;
  captures: CaptureIntent[];
  bindings: BindingIntent[];
}

export function emptyIntent(): IntentRecord {
  return { version: 1, next_binding_generation: '1', captures: [], bindings: [] };
}

export function runningCount(record: IntentRecord): number {
  return record.captures.filter((c) => c.intent === 'running').length;
}

export function linkedCount(record: IntentRecord): number {
  return record.bindings.filter((b) => b.intent === 'linked').length;
}

export function findCapture(record: IntentRecord, sessionId: string): CaptureIntent | undefined {
  return record.captures.find((c) => c.session_id === sessionId);
}

/** Admit a capture: `running` while a slot is free, otherwise `waiting`. A prior
 * entry for the same session (a re-attach after detach) is replaced and moves to
 * the end, which is admission order for waiting entries. */
export function admitCapture(
  record: IntentRecord,
  entry: Pick<CaptureIntent, 'session_id' | 'root' | 'root_identity'>,
): CaptureIntent {
  record.captures = record.captures.filter((c) => c.session_id !== entry.session_id);
  const admitted: CaptureIntent = {
    ...entry,
    intent: runningCount(record) < MAX_CAPTURES ? 'running' : 'waiting',
    withdrawn_reason: null,
    capture_mode: 'watch-only',
    last_failure: null,
  };
  record.captures.push(admitted);
  return admitted;
}

/** Withdraw a capture. Withdrawing a `running` entry promotes the first `waiting`
 * entry to `running` in the same mutation; that entry is returned. */
export function withdrawCapture(
  record: IntentRecord,
  sessionId: string,
  reason: 'detached' | 'archived',
): CaptureIntent | undefined {
  const entry = findCapture(record, sessionId);
  if (!entry || entry.intent === 'withdrawn') return undefined;
  const freedSlot = entry.intent === 'running';
  entry.intent = 'withdrawn';
  entry.withdrawn_reason = reason;
  if (!freedSlot) return undefined;
  const next = record.captures.find((c) => c.intent === 'waiting');
  if (next) next.intent = 'running';
  return next;
}

export function findLinked(record: IntentRecord, harness: string, harnessSessionId: string): BindingIntent | undefined {
  return record.bindings.find((b) => b.intent === 'linked' && b.harness === harness && b.harness_session_id === harnessSessionId);
}

export function linkedFor(record: IntentRecord, sessionId: string): BindingIntent | undefined {
  return record.bindings.find((b) => b.intent === 'linked' && b.session_id === sessionId);
}

/** Link a chat under a freshly allocated, never-reused generation. */
export function linkBinding(
  record: IntentRecord,
  entry: Omit<BindingIntent, 'binding_generation' | 'intent' | 'unavailable'>,
): BindingIntent {
  const generation = record.next_binding_generation;
  record.next_binding_generation = (BigInt(generation) + 1n).toString();
  const linked: BindingIntent = { ...entry, binding_generation: generation, intent: 'linked', unavailable: null };
  record.bindings.push(linked);
  return linked;
}

export function revokeBinding(record: IntentRecord, sessionId: string): BindingIntent | undefined {
  const linked = linkedFor(record, sessionId);
  if (linked) linked.intent = 'revoked';
  return linked;
}

/** Forget a deleted session's capture and binding entries. */
export function forgetSession(record: IntentRecord, sessionId: string): void {
  record.captures = record.captures.filter((c) => c.session_id !== sessionId);
  record.bindings = record.bindings.filter((b) => b.session_id !== sessionId);
}
