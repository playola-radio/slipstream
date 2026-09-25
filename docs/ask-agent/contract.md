# Queue contract for the ask/send slice

Status: D1 queue contract ready for implementation; D2 hook-claim identity contract deliberately not frozen until P0. Based on Claude architecture consultation and source-verified corrections in decisions.md.

## Boundary

Use the existing owner-only `<store>/control.sock`, NDJSON framing, 1 MiB line cap, and `v:1` envelopes. `daemon.ts:dispatch` already adds `v:1` to all replies; do not refactor existing replies. The public HTTP reader remains GET-only. Support the shared `start` + explicitly bound `attach` daemon mode. Standalone `serve` has no matching control/binding path and must not pretend to support asking.

No separate broker, database, registration service, HTTP write endpoint, or privileged Swift inbox access. An arbitrary independent local client can use the documented command protocol and read resulting public events. Filesystem ownership of the control socket is the existing local authentication boundary; preserve ownership checks and never expose it over TCP.

## Ask request and acknowledgment

```typescript
interface AskRequest {
  v: 1;
  verb: 'ask';
  session_id: string; // capture session, not harness session
  request_id: string; // caller-generated canonical lowercase UUID
  text: string;
  context: {
    change_seq: string; // canonical positive decimal; never JSON number
    path: string; // exact relative path from this event
    snapshot_sha256: string; // exact lowercase after-content hash
    line_start: number; // inclusive, 1-based integer
    line_end: number;   // inclusive, 1-based integer
  };
}
interface AskAccepted {
  v: 1;
  ok: true;
  session_id: string;
  request_id: string;
  question_id: string;
  seq: string; // queued event seq
  queued_at_ms: number;
  expires_at_ms: number;
  duplicate: boolean;
}
interface AskRejected {
  v: 1;
  ok: false;
  code: 'PROTOCOL' | 'SESSION_NOT_SELECTED' | 'CAPTURE_NOT_READY'
    | 'STORAGE_UNAVAILABLE' | 'INVALID_QUESTION' | 'INVALID_CONTEXT'
    | 'REQUEST_CONFLICT' | 'QUESTION_LIMIT';
  message: string;
}
```

`ok:true` acknowledges a durable queue record for the bound session, never delivery, model receipt, or an answer. The CLI prints acknowledgment/error metadata; it must not print bearer tokens or unnecessary source text.

Protocol framing/version/invalid request_id errors use `PROTOCOL`; text errors use `INVALID_QUESTION`; invalid source identity, range, or unavailable source use `INVALID_CONTEXT`. A broken/unhealthy store uses `STORAGE_UNAVAILABLE` rather than pretending source is empty. `CAPTURE_NOT_READY` retains existing readiness semantics. A mismatched/replaced/inactive capture is `SESSION_NOT_SELECTED`, never an invitation to auto-retarget.

## Source validation and normalization

The daemon, not the app, derives selected source text:
1. Resolve `change_seq` in the named active session's durable log, using a bounded finite read at its committed boundary. Merely comparing seq to durable_seq is insufficient.
2. Require `slipstream.file.changed.v1`, exact path match, an `after.kind=content` snapshot, and exact hash match. The event must belong to this capture session.
3. Read the CAS object with existing safe path/O_NOFOLLOW conventions and an actual bounded read (at most 1 MiB + 1 byte), not merely a pre-read size check. Verify its bytes against its content hash. Reject NUL and invalid UTF-8; preserve BOM, tabs and CRLF content. Do not read the current working file.
4. Empty text has zero lines. Otherwise split on LF, preserving internal empty lines, and drop only the last empty segment when the file ends in LF. Keep CR in segments. This matches `ChangedLines.split`; display-only stripping of CR and tab expansion must not affect the request's line identity.
5. Require integer `1 <= line_start <= line_end <= lineCount`. Select those segments and join with LF, without adding a synthetic final LF. Selected text is derived once and persisted in the queued event.

Caps: text 1–8192 UTF-8 bytes after ECMAScript `String.trim()` normalization; path 1–4096 UTF-8 bytes; source blob at most 1 MiB; selected range at most 200 lines and selected text at most 16384 UTF-8 bytes. UTF-8 byte limits avoid Swift grapheme/JS UTF-16 disagreement. Tests include CRLF, BOM, tabs, astral characters, blank lines, and trailing LF. Source verification is bounded and asynchronous; do not block capture or scan unrelated logs/transcripts.

## Target and durable event

Target is copied from the daemon's current explicit attach binding: `{harness, harness_session_id, worktree}`. The app supplies capture session_id; it never supplies or guesses authorship. Re-check current selection/ownership after asynchronous canonicalization/source reads and before admission/append. Once admitted, detach/shutdown drains the admitted operation through the existing lifetime mechanism.

D1 emits only `slipstream.question.queued.v1`. Use the normal CloudEvents envelope, `source=urn:slipstream:session:<capture-id>`, `id=seq`, and `subject=question/<question_id>`.

```typescript
interface QuestionQueuedData {
  session_id: string;
  question_id: string;
  request_id: string;
  target: { harness: 'claude-code' | 'codex'; harness_session_id: string; worktree: string };
  text: string; // normalized question
  context: AskRequest['context'] & { selected_text: string };
  queued_at_ms: number;
  expires_at_ms: number;
}
```

Use the existing single append/durability boundary; never append straight to events.jsonl. The event is not a filesystem change or attribution evidence. Preserve task grouping, capture, folds, GC and reader invariants.

## Retry, recovery, queue bounds

- One idempotency key is `(capture session_id, request_id)`. Canonical body is the fixed-order fields of normalized text + context. Same key/same body replays the original result with `duplicate:true`, including original timestamps; different body returns `REQUEST_CONFLICT`. Register/coalesce in-flight duplicates synchronously before the first await that could create competing work.
- TTL is 1,800,000 ms from the server's queued timestamp, using an injected clock. At most 16 unexpired, not-attempted questions are eligible. Count/reserve concurrent admissions so 17 simultaneous callers cannot exceed the limit. A duplicate does not consume a slot. Failed admission releases its reservation.
- Preserve the original result for a duplicate even after expiry; never extend TTL. There is no new expiry event, sweeper or timer. Expiry is a derived eligibility check (`now < expires_at_ms`); a late claim gets no question.
- Rebuild the question index from the valid durable prefix during the existing **in-process storage recovery** in `session.ts:tryStorageRecovery`, just as `seedTaskState` rebuilds task declarations. Reconstruct original IDs/timestamps/body fingerprints. A torn tail must not be treated as committed. Recovery occurs within a capture even though daemon restart creates a new capture; omitting this distinction can duplicate durable questions.
- A full daemon restart/detach/new attach makes the old queue ineligible. Never resume or migrate it to the new capture. A retry addressed to the old session returns `SESSION_NOT_SELECTED`; retain uncertainty about whether the old log contains a commit. The public reader can inspect the old log by request_id, but this slice adds no dedicated lookup endpoint or UI.
- Pre-transmission transport failure means unavailable. Any timeout/drop/malformed reply after transmission is outcome unknown. The client preserves the same request ID and draft for retry; it never silently creates a fresh request to resolve uncertainty.

## D2 boundary — not ready until the routing proof

Name reserved for the later public event: `slipstream.question.dispatch_attempted.v1`. It is written before a claim reply; it proves an attempt, not receipt or model emission. D2 supplies its schema when its claim contract is finalized. No speculative dispatcher or unused dispatch schema in D1.

D2 offers at most one oldest eligible question per hook call, records an attempt before replying, and never automatically offers that question again after commit. Concurrent claims must have one winner. Failure after attempt commit is explicitly unconfirmed. Persisted attempt records rebuild the eligibility index during in-process recovery. Hook failures are silent exit 0, with a 300 ms connect / 1000 ms total budget and bounded additional context.

The claim identity fields and main-agent discriminator are an explicit P0 dependency. Session-ID-only or cwd-only routing is prohibited, and declaring subagents “unsupported” cannot excuse delivering to one. Do not publish a claim API with an undefined evidence object or enable a harness until its discriminator/socket access are proven. Product hooks inject the question/context only; answer artifacts belong to QA, not a production reply channel.
