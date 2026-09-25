# Architecture decisions and review dispositions

Sources: `../ask-agent-architecture-consult.md`, `../ask-agent-architecture-iteration.md`, and direct inspection of client develop facdb95 / daemon develop 0105465. The Claude consultations drove the transport/lifecycle proposal. This record supersedes conflicting provisional statements in those raw consultations.

## Accepted

- Reuse existing explicit daemon attach binding and owner-only Unix control socket. No agent registry, picker, broker, HTTP write API, or private Swift inbox. Requirements A7–A9.
- One public queued event and a later dispatch-attempt event; no separate expiry event/timer. Requirement A10 needs truthful eligibility and acknowledgment, not a new status subsystem.
- Original source is derived from the recorded after snapshot, not the app's tab-expanded display. Full event/type/path/hash/range verification closes the loose seq-only proposal. Requirement A3.
- One question per callback with bounded input/context/deadlines. A failed hook never interrupts the implementing agent. Requirements A7/A8.
- At-most-once dispatch attempt; durable queue acceptance and attempted dispatch never claim model receipt. No automatic new-ID resend. Requirement A10.
- A narrow main/subagent + Unix-socket probe blocks D2 but not D1. The four earlier question/reply successes remain valid; they are not evidence of child exclusion or external socket access.
- The supplied node metadata settles Add, Append, dismissal and successful/failed submission semantics. No repeated owner approval is needed. Receiving-answer UI remains deferred by the owner's explicit instruction.
- First entry point is selection in the existing stream, which the design explicitly supports. A full viewer is not a prerequisite for that entry point and is not silently added.

## Corrections after source verification

1. **Control response version:** all existing replies already carry `v:1` (`daemon.ts:dispatch`, around line 658). Reject the proposed rewrite of every reply. New verbs reuse the same wrapper.
2. **Recovery:** full daemon restart creates a new capture, but `session.ts:tryStorageRecovery` reopens the SAME capture and calls `seedTaskState` (around line 502). Reject an in-memory-only question index that ignores recovery. Rebuild it from the durable prefix there; do not claim old queues resume across daemon restart.
3. **Premature schemas:** D1 emits queued only. Keep the dispatch-attempt name in the written contract, but ship its concrete schema with D2 when its fields have a real producer. The client can recognize both stable names in its final PR. No unused dispatcher in D1.
4. **Merge order:** D1 → D2 → S1 gives the app a working send path when its visible Ask control lands. P0 is independent and gates D2. Reject shipping the visible composer before any delivery adapter exists. Unknown question types can appear in older clients only if a caller explicitly uses the new CLI; early acceptance runs use disposable stores, and the final Swift PR handles both types as rowless. Do not claim an older binary already understands new events.
5. **Probe privacy/safety:** never probe real ~/.slipstream, even to hash or list its contents. Test an external disposable home directory and a short /tmp control socket if location matters. Log only required identity fields/input key names and controlled fixture evidence, not arbitrary tool payloads or full environment dumps.
6. **Error surface:** the current app's status/error display belongs to session/connection state, not a generic question-error channel. The client implementer must not reuse `.halted` to report a failed question. A minimal accessible failure treatment is a client handoff detail, with approved normal composer states unchanged; no invented answer surface.
7. **Line fidelity:** `ChangedLines.split` removes only a terminal empty LF segment and keeps CR; `displayText` strips CR and the card loader expands tabs. The server contract matches original split semantics. Freeze context identity and preserve a display copy as needed; do not create an extra source cache or trust rendered text.

## Scope/simplicity disposition

Every planned piece maps to A1–A10 in spec.md. Saved-question persistence serves A5/A6; the control transport serves A9; dedup/recovery serves A4/A10; immutable snapshot validation serves A3; the routing probe serves A7/A8. Deliberately omitted: automatic installer, new agent registry, reply transport, response UI, queue sweeper, expiry events, full viewer, generic conversation database, and a separate Swift-core-only PR.

## Review emphasis carried into implementation

The hardest remaining work is root-session identity and socket access (P0), then loss/recovery/concurrent-admission behavior (D1), then stale callbacks and selection anchoring (S1). Fresh implementers use the user's requested normal tiering; reviewers must pay extra attention to these prose-specified boundaries. Product-code review gates and independent live QA still apply when those PRs exist. No product implementation has been declared verified from this planning pass.

## D1 implementation review (2026-09-25)

Claude's source review found `src/event.ts` in the released display-fold.v1 byte
fingerprint. The original source map cannot be followed literally while keeping
that frozen contract. Use the review's additive alternative: `public-events.ts`
wraps the old envelope builder and extends the catalogue for the log, recovery,
schema serving and GC. No released dependency, manifest or fixture is changed.
The queued-event type remains public and the old display fold treats it as rowless.

Admission and immutable source validation live in `CaptureSession.askQuestion`.
The daemon copies the current attach binding and registers the operation in its
existing in-flight drain set without awaiting. Source reads consume one of the
16 reservations; duplicate keys coalesce before I/O. Detach/shutdown drains an
admitted operation before another capture can be selected. Session health and
both session/store ownership are checked again after source reads, and ownership
again after append before acknowledgment. Thus an admitted request cannot be
retargeted across an asynchronous read. This replaces the brief's proposed
pre-admission daemon source read; it also bounds concurrent source scans.

A missing/hash-corrupt recorded blob or unreadable log is `STORAGE_UNAVAILABLE`;
a client source mismatch, unavailable snapshot, binary/oversized source or bad
range is `INVALID_CONTEXT`. A persisted question includes its selected source;
its `snapshot_sha256` is identity metadata, not a second CAS-reference format.
The originating file-change event continues to retain its blob through GC.

The contract permits canonical lowercase request UUIDs; it does not require a
UUID version. Capture IDs follow the existing v4 contract; request IDs accept
standard versions 1–8 and the RFC variant. Generated question IDs remain v4.
No hook/claim infrastructure, dispatcher schema, reply transport, or answer UI
is added. Architecture review evidence is retained in the local worktree context.

## D1 final review dispositions (2026-09-25)

The correctness review passed; challenge and excess audit ran independently and
concurrently on the committed diff. Their findings were resolved together:

- **Uncertain storage outcome (A4/A10):** `STORAGE_UNAVAILABLE` may follow a
  committed append. The CLI preserves its structured error, reports uncertainty,
  exits 3, and requires the same request/capture/body. The contract documents this
  for future clients. Source size inconsistent with recorded metadata is storage
  corruption; a legitimately recorded oversized snapshot is invalid context.
- **Unicode/input bounds (A3/A4):** reject lone surrogates in question text/path;
  retain valid surrogate pairs. CLI reads only bounded regular files, parses JSON,
  and leaves semantic admission to the daemon.
- **Source scan (A3):** retain the existing asynchronous finite log cursor and
  16-reservation bound. An additional offset index has no measured justification
  in D1; its memory/recovery machinery would expand the agreed implementation.
- **Shutdown and clock (A10):** retain the explicit contract: admitted operations
  drain, lost replies are unknown, old captures are never retargeted, and expiry
  is derived from `now < expires_at_ms`. Abort-on-shutdown and monotonic expiry
  would change those specified semantics. D2 must preserve the eligibility rule.
- **Error precedence (A4/A9):** normalize before session readiness checks; delete
  the daemon's duplicate capture-ID validation. The existing detached/ownership
  gates still apply before admission. Unexpected infrastructure errors retain the
  existing daemon error mapper rather than adding a second generic taxonomy.
- **F1 isolation:** the live module owns and removes its entire disposable daemon,
  files and store, including when the runner receives `--env`. Remove shared
  context/store plumbing, optional expected identity fields, unused imports and
  the dead JSON branch of the attach-output parser.
- **Acknowledgment validation (A4/A10):** retain strict durable identity and
  timestamp checks: a generic successful envelope does not prove queue acceptance.
  Reuse the existing v4 ID validator for generated question IDs and the shared TTL
  constant. The audit's request-ID concern does not apply to question IDs.
- **Post-append checks (A10):** remove the redundant daemon check and dead event
  type guard (use an append overload); retain session surrender and supplied store
  ownership checks, because the session also has callers without that callback.
- **Source integrity (A3):** retain exact envelope id/source and recorded-size
  checks. They verify the live immutable reference and distinguish inconsistent
  storage metadata from an invalid user selection; startup recovery is not a
  substitute for validation at admission.
- **Redundant validation/copying:** remove duplicate range/size checks from the
  source-selection helper, impossible path-shape rejections before exact source
  matching, and the session's second target copy. Retain the frozen accepted
  result for A4/A10: a direct first caller must not mutate cached retry identity.
- **Tests:** consolidate malformed-ack cases, remove duplicate guidance and
  out-of-layer validation assertions, and rename the readiness-loss test. Retain
  capacity/concurrency tests at the session boundary that owns reservations;
  daemon tests separately cover socket loss, detach, shutdown and restart. The
  additional 17-socket fixture would repeat the same capacity algorithm.

All schema fields map to the named queued-event contract; neither review found
schema/database excess. Delivery, claim indexing, receipts and answer UI remain
outside this branch.
