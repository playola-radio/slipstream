# Workspace auto-capture: event and control contracts (P1, design only)

Status: contract for P2 to P4. P2, P3 and P5 are built; P4 (delete and gc
beside running captures) is built on `briankeane/autocapture-p4-maintenance`. The spec this
implements is `docs/superpowers/specs/2026-10-05-workspace-auto-capture-design.md`
(revised 2026-10-17); where this file and the spec disagree, the spec wins and
this file is the bug. Codex reviewed a first draft (Architect consult, recorded
at the end); this version carries those resolutions.

The event schema is the public interface. Every state a client needs (capture
lifecycle, NOT recording, binding state) is reachable from documented on-disk
records: the session logs, the intent record (8), and the session ownership
heartbeat (7). The reader serves a projection of exactly those records. Private
control status is a convenience for the CLI, never the only place a state lives.

Honesty rules that apply to every item below:

- `session_id` is capture scope (which worktree is watched), never authorship.
- A linked chat is a question-delivery relationship. It never credits file
  changes to the chat. UI language says "possibly agent", never "attributed".
- `connected` means one setup round trip succeeded at event time. It does not
  mean the chat is alive now.
- A start without a stop is not proof that capture is live. Liveness needs a
  fresh ownership heartbeat (7).
- Unavailable is explicit, with a reason. No state is inferred from silence.

## 1. New public event: `slipstream.capture.ready.v1`

Appended once per activation, after the watcher is installed, the baseline (on
start) or reconciliation (on resume) is complete, and the durability barrier has
passed. It is what makes `recording` reproducible from the log: today a resume
appends `session.resumed`, a gap, the scope, and zero or more changes, and nothing
marks reconciliation complete.

```jsonc
"data": { "session_id": "<uuid>" }
```

Whether the activation started or resumed, and when it became ready, are already
in the log: the activation's opening `session.started`/`session.resumed` event and
the envelope's `time`.

An activation with `session.started`/`session.resumed` but no `capture.ready` is
`baselining` (if its owner is live) or `not_recording{reason: "baseline-failed" |
"resume-failed"}` (if not). Events before `capture.ready` in that activation are
still real observations; they are just not yet a complete picture.

## 2. New public event: `slipstream.capture.stopped.v1`

Appended as the last record of an activation that stopped cleanly.

```jsonc
"data": {
  "session_id": "<uuid>",
  "reason": "detached" | "archived" | "maintenance" | "root-missing" | "watcher-failed"
}
```

| `reason` | Written when |
|---|---|
| `detached` | An explicit `detach <target>` stopped the capture. |
| `archived` | The Conductor archive path withdrew capture intent and stopped the capture. |
| `maintenance` | GC quiescence stopped the capture (D9). Intent is kept; a later `session.resumed` plus `capture.gap{restart}` follows on the same session. |
| `root-missing` | The watched root was deleted **or replaced** (device or inode of the canonical root changed). A recreated directory at the same path never inherits the capture. |
| `watcher-failed` | The watcher subscription closed or could not be kept (rule below). |

**Watcher terminal rule.** A watcher error while the subscription stays installed
is not terminal: it appends the existing `capture.gap{watcher-error}` and capture
continues (today's path). A subscription that closes, or that cannot be
reinstalled, appends exactly one `capture.gap{watcher-error}` followed by
`capture.stopped{watcher-failed}`, and the activation ends. There is no retry
inside an activation. Recovery may later resume the session with backoff, which
is a new activation (`session.resumed`, `capture.gap{restart}`).

Ordering on a clean stop: stop observation, drain accepted work, append the stop
event, flush (fsync), close the log. The stop event is the final record of that
activation; any later record on the same session belongs to a new activation that
starts with `session.resumed`.

**Never manufactured.** After store-lock loss, session-lock loss, or an
unwritable store, no stop event is written. Recovery discloses the hole with the
existing `capture.gap{restart}` on resume. A reader must treat "no stop event and
no live heartbeat" as **not confirmed live**, never as "still recording".

The reason set is closed for `v1`. A new reason is a new event version.

## 3. Initial capture mode on start and resume

`slipstream.session.started.v1` and `slipstream.session.resumed.v1` gain one
additive optional field:

```jsonc
"data": { …existing fields…, "capture_mode": "watch-only" }
```

- Written on every activation started by `attach --watch-only` or by recovery of a
  watch-only intent. `capture_mode` describes how that activation **started**; a
  later in-place binding never rewrites it and never appends a second start.
- Absent means an activation started by chat attach (today's path). Readers must
  not infer `watch-only` from absence.
- A watch-only capture refuses `begin_task` and `ask` (`AGENT_NOT_CONNECTED`, with
  a reason naming watch-only) until a binding reaches `connected`.

Binding state is never read from `capture_mode`; it comes from 4.

## 4. Binding events and `agent.connection.v1` per capture

Two new public events carry binding intent. `slipstream.agent.connection.v1`
keeps reporting handshake results only.

### `slipstream.agent.binding.v1`

Appended when a chat is durably linked to a capture (slot reserved, identity
verified, binding intent persisted).

```jsonc
"data": {
  "session_id": "<uuid>",
  "binding_generation": "3",
  "target": { "harness": "claude-code" | "codex", "harness_session_id": "…", "worktree": "/canonical/root" },
  "verified_transcript_path": "/…/transcript.jsonl"
}
```

### `slipstream.agent.unlinked.v1`

Appended when binding intent is revoked.

```jsonc
"data": { "session_id": "<uuid>", "binding_generation": "3", "reason": "unlinked" | "detached" | "archived" }
```

`unlinked` comes from `unlink --session` (capture keeps running). Detach and
archive withdraw capture intent and binding intent together, so they append
`agent.unlinked {reason: "detached" | "archived"}` immediately before
`capture.stopped`. Maintenance and crash recovery never unlink.

### Generations

`binding_generation` is a per-store counter, a decimal string. It is monotonic,
never reused (not even after unlink or delete), and durably incremented in the
intent record (8) **before** any event or hook publication carries it. Every
newly written `agent.binding`, `agent.unlinked`, and `agent.connection` event
carries it; the field is optional only so that legacy `agent.connection` events
stay readable. A connection event whose generation is not the binding's current
generation is history only.

### Ordering per capture

1. Binding intent persisted (8), generation `g` allocated.
2. `agent.binding.v1 {binding_generation: g}`
3. `agent.connection.v1 {state: "setup_pending", binding_generation: g, target}`,
   before the binding is published to hooks and forwarders.
4. `agent.connection.v1 {state: "connected", binding_generation: g, target}`,
   appended before the setup check's acknowledgement returns, only after a live
   round trip at generation `g` in the current activation.

On resume (crash, LaunchAgent restart, GC), linked bindings are restored from
intent: `session.resumed`, `capture.gap{restart}`, then a fresh
`agent.connection.v1 {state: "setup_pending", binding_generation: g}` with no new
`agent.binding.v1` (same generation, new activation). `connected` is re-earned
only by a fresh round trip in the new activation; it is never inferred from an
old `connected` event.

### Initial failure versus later invalidation

- **Initial** verification or configuration failure on chat attach creates no
  binding: no intent, no event, and the in-memory slot reservation is released.
  The attach fails with the readable reason; the capture keeps recording.
- **Later** revalidation failure of a durable binding (transcript missing or
  unreadable, identity changed, runtime unsupported) keeps its intent and slot and
  makes it `unavailable` with that reason (6). It is recorded in the intent
  record, not as one event per retry.
- Missing or unloaded hook configuration is not a failure: the binding stays
  `setup_pending` with reason `config-missing` (repair or reload).

### One capture per chat identity

A chat identity `(harness, harness_session_id)` may hold at most one linked
binding store-wide. Hooks and forwarders route by that identity, so it must
resolve to exactly one capture. Linking a chat that already holds a binding on a
different capture is refused with `BINDING_EXISTS` naming the other capture.

## 5. Control verbs (every mutating verb names its target on the wire)

The CLI may resolve a target from the current directory; the request sent to the
daemon always carries it. `--store` selects the daemon, never the chat.

| CLI | Wire request | Result |
|---|---|---|
| `slipstream attach --watch-only <root> [--wait]` | `{verb:"attach", mode:"watch-only", worktree}` | Admission ack before any baseline work: `{session_id, state, created}`. The `session_id` is allocated and persisted at admission. Same root while queued/baselining joins the same capture (no duplicate). Ancestor/descendant roots refused (`ROOT_OVERLAP`). With 16 running capture intents already (spec D10), the intent is written as `waiting` under a fresh `session_id` and the reply is `CAPTURE_LIMIT_REACHED`; nothing is captured until a slot frees. |
| `slipstream attach` (from a chat) | `{verb:"attach", harness, harness_session_id, worktree, root_transcript}` | If the workspace's capture is `recording`: binds in place (same `session_id`, no new baseline, no resume event, no gap). If it is `queued`/`baselining`: returns the admission state immediately without binding; the CLI polls `status <session_id>` and resubmits the same attach once `recording`, which is idempotent. If no capture exists: admits a watch-only capture first, then the same path. If the workspace is `waiting` for a slot, or admission finds the limit full: `CAPTURE_LIMIT_REACHED`, no binding intent written. |
| `slipstream status [<target>]` | `{verb:"status"}` or `{verb:"status", target}` | No target: list every capture with lifecycle and binding state. With target: that one capture. |
| `slipstream detach <target>` | `{verb:"detach", target}` | Withdraws capture and binding intent durably, then stops the capture (`agent.unlinked{detached}` if bound, then `capture.stopped{detached}`). |
| `slipstream unlink --session <id>` | `{verb:"unlink", session_id}` | Revokes binding intent; invalidates outstanding setup checks; clears task selection and claim eligibility; capture keeps running. |
| setup-check answer (hook) | `{verb:"answer_setup_check", session_id, binding_generation, check_id}` | Appends `connected` only if the binding is still linked at that generation in this activation. |
| `begin_task`, `ask` (forwarder) | `{verb, session_id, binding_generation, …}` | Refused unless the binding is `connected` at that generation in this activation. |
| hook claim, `answer_question` | `{verb, session_id, binding_generation, question_id, …}` | Same fence. |

**Fencing.** Every mutating verb carries `session_id` plus, for chat-facing verbs,
`binding_generation`. The daemon checks activation and generation on entry and
**again after every await** before it appends or acknowledges. A stale generation
gets a structured refusal, never a write.

**Targets.** `<target>` is a session id or a root path. The session id is
authoritative. A path resolves to the capture whose stored canonical root equals
its `realpath`, never by prefix. If `realpath` fails (root deleted or replaced),
the path is compared literally against stored canonical roots, so a missing root
can still be detached or inspected.

**`--wait`.** The client polls `status <target>` with short requests (each well
under the 15 s control timeout) until `recording` or `not_recording`/`stopped`. If
the caller's own timeout expires first, it prints **"still pending, outcome
unknown"** and exits non-zero with a distinct code; it never reports "nothing
happened". Re-running the same command with the same target cannot create a
second capture.

**Idempotence.** The same chat attaching again to the same capture: success, no
new events except a re-armed setup check if `setup_pending`. `detach` of a stopped
target: success with `already_stopped: true`. `unlink` of a session with no
binding: success with `already_unlinked: true`.

### Error codes

New codes join `ControlErrorCode`:

- `BINDING_EXISTS`: a different chat attaches to a capture that already has a
  binding, or a chat that is already linked to another capture attaches here. The
  existing binding is kept. The wording below is **contract-owned** (the spec does
  not fix it); names are filled in:
  `BINDING_EXISTS: <harness> chat <harness_session_id> is already linked to the capture of <root> (session <session_id>). That link was kept. To link this chat here instead, run: slipstream unlink --session <session_id>, then run slipstream attach again from this chat.`
- `BINDING_LIMIT_REACHED`: an eleventh durable binding intent. Exact text from the
  spec:

  > `BINDING_LIMIT_REACHED: 10/10 chats linked. This workspace is still recording without a linked chat. Unlink another chat to connect this one.`

  The capture is unaffected and keeps recording.
- `CAPTURE_LIMIT_REACHED`: 16 capture intents already hold slots (spec D10).
  Exact text from the spec:

  > `CAPTURE_LIMIT_REACHED: 16/16 capture slots in use. This workspace is NOT recording. It starts automatically when another workspace is archived or detached.`

  The waiting intent is durable; the CLI exits non-zero (setup scripts report it
  per D1). A slot is any capture intent that is `running`, whatever its lifecycle
  state, including `not_recording` with a retry pending.
- `ROOT_OVERLAP`: the requested root is an ancestor or descendant (by path
  components) of a waiting, queued, baselining, or recording capture's root, or
  of a running `not_recording` capture with a scheduled retry. Sibling git
  worktrees sharing repository metadata are not overlaps.
- `TARGET_NOT_FOUND`: a targeted verb names no known capture.
- `STALE_BINDING`: a chat-facing verb carries a generation or activation that is
  no longer current.

`SESSION_ACTIVE` stops being returned for "another workspace is being recorded"
or "same workspace, another chat"; those become allowed or `BINDING_EXISTS`. It
keeps its meaning for delete/GC against a live target.

Maintenance (D9, P4):

- `delete_session` runs while other captures record. It returns `SESSION_ACTIVE`
  when the target's intent is `running` or `waiting`, or the target is still
  starting or stopping. An attach whose lookup found the session before it was
  deleted gets `CAPTURE_NOT_READY` and never writes into it; a retry starts a new
  session.
- `gc` stops every recording capture with `capture.stopped{maintenance}`, keeping
  capture and binding intent, sweeps, then resumes each one it stopped whose
  intent is still `running`: same session id, `session.resumed`,
  `capture.gap{restart}`, and its linked chat back to `setup_pending` with a new
  check. Waiting intents are untouched. While gc runs, `attach` and `unlink`
  return `CAPTURE_NOT_READY`; `detach` still withdraws, and a withdrawn capture is
  not resumed. `{removed}` means the sweep completed; resume is queued before the
  reply and does not wait for recording.
- gc returns `STORAGE_UNAVAILABLE` and sweeps nothing when any capture's stop
  could not be recorded, any session ownership lock is still being refreshed by
  another process, or the store lock is lost. Captures still resume, unless the
  store lock was lost: the daemon then shuts down instead, and whichever daemon
  next holds the lock recovers them (P3). Every store writer holds the store lock:
  the daemon, offline intent writers, and standalone `watch`/`serve`.

## 6. Public states

Public capture state:

| State | Means | Coverage |
|---|---|---|
| `queued` | Admitted, waiting for the one baseline slot. | **None.** Queued is not coverage. |
| `baselining` | Live owner; activation started, no `capture.ready` yet. | Partial; events may appear; not yet complete. |
| `recording` | Live owner; `capture.ready` written in the current activation. | Observed states with explicit gaps. |
| `stopped` | `capture.stopped` written, or a withdrawn capture that never activated (fold rule 2); carries its reason. | None since the stop. |
| `not_recording` | Capture intent exists but capture is not confirmed happening. Carries a readable reason. Exists even when the first append never succeeded. | None. |

`not_recording` reasons (closed set for v1, each with a human message):
`daemon-unavailable`, `root-overlap`, `root-missing`, `baseline-failed`,
`storage-unavailable`, `watcher-failed`, `resume-failed`, `resource-limit`,
`stop-unconfirmed` (intent withdrawn, an activation may have begun, and no
durable `capture.stopped`),
`capture-limit-reached` (intent `waiting` for one of the 16 slots). Retry is
separate from the reason: a row may also carry `retry: {next_attempt_at_ms}` when
recovery has scheduled another attempt.

Public binding state: `setup_pending` (optional reason `config-missing`),
`connected`, `unavailable` (reason: `transcript-missing`,
`transcript-unreadable`, `identity-changed`, `runtime-unsupported`), `unlinked`.

### How each state is computed

Capture state is a fold of intent (8), the session log, and the ownership
heartbeat (7), in this precedence:

1. Intent `withdrawn` and the last activation ends in `capture.stopped`:
   `stopped`.
2. Intent `withdrawn` and no durable `capture.stopped`:
   - The daemon knows no activation ever began (the capture was still `queued`
     when it was withdrawn, or its session log does not exist): `stopped` with
     the withdrawal reason (`detached` or `archived`). Nothing ran, so there is no
     `capture.stopped` to write and none is claimed (Brian, 2026-10-18).
   - Otherwise: `not_recording{stop-unconfirmed}`. This covers any capture that
     activated but has no durable `capture.stopped`, and the offline CLI, which
     cannot tell whether an activation began. Never `recording`.
3. Intent `waiting`: `not_recording{capture-limit-reached}`. Waiting intents never
   have an activation.
4. Intent `running` whose last activation ends in `capture.stopped`: `stopped`
   with that event's reason. `maintenance` additionally carries the running
   intent, so it resumes later; `watcher-failed` does too when recovery is
   scheduled. Neither stop is hidden by a fresh heartbeat or `last_failure`.
5. Intent `running` with a recorded `last_failure`: `not_recording` with that
   reason, whether or not its heartbeat is fresh. A storage failure therefore
   never reads as `recording`; when the store cannot accept another event, the
   reader uses the durable intent record's `last_failure`.
6. Intent `running`, heartbeat not live: `not_recording{daemon-unavailable}`.
7. Intent `running`, heartbeat live, no activation yet: `queued`.
8. Heartbeat live, current activation has `capture.ready`: `recording`; without
   it: `baselining`.

Binding state is a fold of binding intent plus binding events; revoked intent
wins over a missing `agent.unlinked` event. `unavailable` comes only from intent.
`setup_pending` and `connected` come from the latest `agent.connection` at the
current generation in the current activation; a `connected` from an earlier
activation reads as `setup_pending`.

### Crash points

| Crash between | What a reader sees | What recovery does |
|---|---|---|
| admission intent written, first append | `not_recording{daemon-unavailable}` then `queued` once a daemon is live | Starts the capture under the persisted `session_id`. |
| `session.started`/`resumed`, `capture.ready` | `not_recording{baseline-failed\|resume-failed}` while no owner; `baselining` once resumed | Resumes; `capture.gap{restart}` discloses the hole. |
| withdrawal written, `capture.stopped` (the capture had activated) | `not_recording{stop-unconfirmed}` | Does not resume a withdrawn capture. Does **not** backfill `capture.stopped` as if it happened at the original time. |
| withdrawal written, first append (never activated) | `stopped` with the withdrawal reason (fold rule 2) | Starts nothing; there is no stop to write. |
| binding intent written, `agent.binding` | binding `setup_pending` from intent (no event yet) | Appends `agent.binding` and `setup_pending` at the stored generation on resume, then publishes. |
| revoke written, `agent.unlinked` | binding `unlinked` (intent wins) | Does not restore the binding; does not backfill `agent.unlinked`. The next activation's `capture.gap{restart}` discloses the hole. |

## 7. Liveness: the session ownership heartbeat

Each live capture holds `<store>/sessions/<id>/owner.lock`, and its owner refreshes
the lock's mtime every 2 s (`src/lock.ts`, staleness horizon 12 s). This becomes
part of the public contract: a session's owner is **live** when its `owner.lock`
exists and its mtime is within 12 s of the reader's clock. Projections report the
heartbeat time they used as `as_of_ms`. An offline client applies the same rule;
it cannot do better than "live as of the last heartbeat".

## 8. Durable intent record (P3 persists it)

One documented, owner-only JSON file per store: `<store>/control/intent.json`. It
is control intent, not evidence that capture happened. It is written by
write-temp, fsync file, rename, fsync directory, and the write completes **before**
any acknowledgement it backs.

```jsonc
{
  "version": 1,
  "next_binding_generation": "4",
  "captures": [{
    "session_id": "<uuid>",                    // allocated at admission, never null; stable across history, never the path
    "root": "/canonical/root",
    "root_identity": { "dev": "16777230", "ino": "123456" } | null,  // decimal strings; null if the root could not be read at admission
    "intent": "running" | "waiting" | "withdrawn",   // waiting = beyond the 16-capture limit
    "withdrawn_reason": "detached" | "archived" | null,
    "capture_mode": "watch-only",
    "last_failure": null | { "reason": "…", "message": "…", "at_ms": 0, "next_attempt_at_ms": 0 | null }
  }],
  "bindings": [{
    "session_id": "<uuid>",
    "harness": "claude-code" | "codex",
    "harness_session_id": "…",
    "canonical_worktree": "/canonical/root",
    "verified_transcript_path": "/…",
    "binding_generation": "3",
    "intent": "linked" | "revoked",
    "unavailable": null | { "reason": "…", "message": "…" }
  }]
}
```

Rules:

- Slot count = bindings with `intent: "linked"` plus in-flight reservations held
  in memory under the same mutex as the file write. At most 10. Restored bindings
  keep their slot; nothing is evicted for inactivity.
- Capture slots = capture entries with `intent: "running"` plus in-flight
  admissions, under the same mutex. At most 16 (spec D10). `waiting` entries keep
  their array order, which is admission order: when a `running` entry is withdrawn,
  the first `waiting` entry becomes `running` in the same write and is queued.
  Archiving or detaching a `waiting` entry withdraws it without a slot change.
  Restart and maintenance never change which entries are `running`.
- `(harness, harness_session_id)` is unique among linked bindings (4).
- Connection state is **not** persisted. Recovery restores every linked binding
  as `setup_pending`; only a fresh round trip makes it `connected`.
- A recreated root at a retained path gets a new `session_id`; the
  old entry's identity mismatch keeps them apart.
- Withdrawal (detach, archive, unlink) is written durably even when the daemon is
  down (the CLI writes the file under the store lock if no daemon holds it). A
  successful archive acknowledgement fences stale recovery work: recovery re-reads
  intent after acquiring each capture's lock and abandons a withdrawn target.
- `withdrawn` entries are retained for history (D4) until the session is deleted;
  deletion removes both the capture and binding entries.

## 9. Reader projection

`GET /v1/captures` (new, additive):

```jsonc
{
  "as_of_ms": 1792252567000,
  "binding_slots": { "used": 7, "limit": 10 },
  "captures": [{
    "session_id": "<uuid>",
    "root": "/canonical/root",
    "state": "queued" | "baselining" | "recording" | "stopped" | "not_recording",
    "reason": "…" | null,                   // required for stopped and not_recording
    "retry": null | { "next_attempt_at_ms": 0 },
    "capture_mode": "watch-only" | null,
    "heartbeat_ms": 0 | null,
    "binding": null | {
      "harness": "…", "harness_session_id": "…", "binding_generation": "3",
      "state": "setup_pending" | "connected" | "unavailable" | "unlinked",
      "reason": "…" | null
    }
  }]
}
```

The existing `GET /v1/sessions` row keeps its shape. The fold in 6 is the
contract; a client without the reader computes the same rows from the intent
record, the logs, and the heartbeat files.

## 10. Explicitly not in this contract

Multiple chats per capture, question redelivery after restart, automatic
retention, fully concurrent GC, a second capture source, a missed-edit backfill
hook, polling, or a shorter debounce.

## Codex consult

Architect consult on 2026-10-17 (Codex `gpt-5.6-sol`, read-only, against the
first draft of this file plus the spec and the code it cites). Verdict on the
draft: "not ready". Every material objection was accepted; none was overruled.

| # | Codex objection | Resolution |
|---|---|---|
| 1 | Resumed readiness is not reproducible: nothing marks reconciliation complete. | New `capture.ready.v1` after the durability barrier on start and resume (1). |
| 2 | "Recording" cannot be computed from intent plus logs; live and crashed daemons look identical. | The session `owner.lock` heartbeat is now the public liveness rule with `as_of_ms` (7); no-heartbeat reads as not confirmed live. |
| 3 | Intent/event crash ordering undefined; withdrawn intent without a stop would show `stopped`. | Crash-point table and fold precedence (6); `not_recording{stop-unconfirmed}` for a capture that activated. One that never activated reads `stopped` with its withdrawal reason (fold rule 2; Brian, 2026-10-18). |
| 4 | "Unlinked is log-reproducible" contradicts revocation without an event. | Binding state is the fold of intent plus events; revoked intent wins (6). |
| 5 | Nullable `session_id` breaks stable admission targeting. | `session_id` allocated and persisted at admission, never null (5, 8). |
| 6 | Root identity: unrepresentable before start, unsafe integers, ambiguous after recreation. | Decimal-string `dev`/`ino`, nullable identity; the durable `session_id` allocated at admission is the stable key (8). |
| 7 | Initial verification failure contradicts the spec's two rules. | Initial failure creates no binding and releases the reservation; later invalidation keeps intent and slot (4). |
| 8 | `config-missing` is a pending reason in the spec, not unavailable. | Moved to a reason on `setup_pending` (4, 6). |
| 9 | One chat identity could be linked to two captures, making routing ambiguous. | Store-wide uniqueness of `(harness, harness_session_id)`; refusal is `BINDING_EXISTS` (4). |
| 10 | Generations underspecified. | Monotonic, never reused, durably allocated before publication, mandatory on new events (4). |
| 11 | Chat attach could hold a request near the 15 s limit while a baseline runs. | Returns admission immediately; CLI polls then resubmits idempotently (5). |
| 12 | Most mutating verbs missing targets and fences. | Setup-check answer, `begin_task`, `ask`, hook claim, `answer_question` added with generation fences and revalidation after every await (5). |
| 13 | Path targeting fails exactly when a root is missing or replaced. | Session id authoritative; literal stored-path fallback when `realpath` fails (5). |
| 14 | `retrying` hides the cause. | Causal reason kept; retry is a separate `retry.next_attempt_at_ms` (6). |
| 15 | Watcher terminal behavior undefined. | Watcher terminal rule: error with subscription intact = gap only; closed/unreinstallable = one gap then `stopped{watcher-failed}`; no in-activation retry (2). |
| 16 | `BINDING_EXISTS` wording labeled exact without spec backing. | Labeled contract-owned (5). |
| 17 | Slot counts repeated per row. | `binding_slots` once at the top of the projection (9). |

Codex's measurement objections (18 to 31) applied to the P1 benchmark, which is
now parked on the branch `briankeane/autocapture-bench-parked` (see the spec's
"Overhead").
