# One stream per workspace — resume on re-attach

Today every daemon `attach` mints `randomUUID()` (`src/daemon.ts` attach). Each
record → detach → attach cycle therefore produces another session, and another
entry in the client's session picker. This design makes `attach` resume the
workspace's existing session instead. The session id stays the same and `seq`
continues. A fresh session is created only when the workspace has none.

Architecture settled with the Codex consult (`.context/codex-consult-1.out`).
Product rulings D1–D4 are Brian's (2026-10-14).

## Scope

In scope:
- Daemon `attach` lookup + resume.
- Registry and reader correctness while a stopped session comes back to life.
- Task and question semantics across a resume.
- Contract, schema-description, and SKILL.md updates.

Out of scope:
- Merging existing duplicate sessions.
- Renaming workspaces or streams.
- Client changes.
- Any change to the `/v1/sessions` wire shape. Inactive sessions keep reporting
  `agent_connection: {state:"disconnected", reason:"capture_not_live"}`.

Unchanged:
- Single-active capture.
- An attach while capture is active keeps today's behaviour. The same chat gets
  `already_active: true`; a different chat gets `SESSION_ACTIVE`.

## 1. Finding the workspace's session

Add a new function `findWorkspaceSession(storeDir, canonicalRoot)` in
`src/store-reader.ts`. It does no indexing and no caching; every answer is
derived from the logs.

1. List `sessions/`, keeping only names that pass `isValidSessionId`.
2. Skip any session that has a tombstone (`readTombstone`). A removed session is
   never a candidate.
3. Read the first complete record of each remaining log. Validate it as
   `slipstream.session.started.v1` and compare its stored `root` with
   `canonicalRoot` (the attach worktree after `realpath`). Do not re-resolve
   historical roots.
4. **D3 (B):** if a session's first record is missing, torn or invalid, skip that
   session and write a daemon-log warning naming it. If nothing else matches,
   attach mints a fresh session as usual; the warning is the record that a
   skipped session might have belonged to this workspace. No reply field is
   added. Brian accepts the consequence: an unreadable first record can lead
   to a second stream.
5. Read the tail only of sessions whose root matched.
6. **D4 (A):** if more than one session matches (pre-existing duplicates), the
   one whose last complete record has the newest `time` wins. The session UUID
   breaks ties deterministically. This is a selection heuristic only; nothing is
   merged.

Matching only on a stored canonical root means path aliases such as symlinks or
`/private/var` resolve to the same session. A worktree that has moved on disk
counts as a new workspace.

## 2. Resume failure: fail closed

Once a candidate has been selected, any failure to resume it fails the attach
with a new control error, `SESSION_RESUME_FAILED`. The message names the session
id and the cause. The daemon **never** falls back to minting a fresh UUID,
because a silent second stream is exactly the bug this design fixes.

The remedy depends on the cause:

| Cause | Remedy |
| --- | --- |
| Lock held, or a storage/IO error | Retry |
| Corrupt history (mid-log corruption, missing CAS blob, root mismatch) | Restore the data, or `delete_session` it, which discards that history |

No special stale-lock reclaim is added; `lock.ts` is unchanged.

## 3. Registry lifecycle and the race-freedom invariant

`startAndActivate` changes as follows for a resumed id:

1. **Pin the boundary.** Before `startCapture`, call `registry.freeze(id, H)`.
   - If the registry already has an entry for the id, `H` is its current
     boundary.
   - Otherwise `H` is `onDiskHighWater` of the log.
   - `reserve()` must not be used here: on an unknown id it installs `0`, which
     would hide history and 409 valid cursors.
2. **Start capture.** Call `startCapture({ resumeSessionId: id, ... })` rather
   than `sessionId`.
3. **Hold the pin.** `H` stays pinned through recovery (including truncation of a
   torn tail beyond `H`), the `session.resumed` / gap / scope / reconcile
   appends, and agent-connection setup. Readers never see records past `H`
   until activation.
4. **Activate.** `registry.activate(id, liveBoundary(health))`. As today, this
   aborts followers.
5. **On failure:**
   - If `startCapture` throws, the registry keeps the pre-resume `H`. It does not
     drop to `0` the way today's fresh-attach path does.
   - If a session handle exists by the time of the failure, freeze at
     `health` durable seq.

A fresh workspace (no match) keeps today's `randomUUID()` + `reserve` path.

The header comment in `src/boundary-registry.ts` currently rests race-freedom on
"attach ALWAYS mints a NEW session UUID". It is replaced with:

> Before any session log can grow, its registry boundary is installed, and the
> registry is authoritative over disk from then on. A disk fallback re-checks the
> registry after its async read. Follower registration is synchronous.

## 4. Readers and followers

- **SSE followers on a stopped session** wait in `staticBoundary.waitForAdvance`.
  `activate()` aborts them. The client then reconnects with `Last-Event-ID` and
  receives the live boundary. This is existing behaviour and it is sufficient:
  a reconnect has nothing to miss and nothing to duplicate.
- **Fix in `http-reader.ts` `boundaryFor`.** After the
  `onDiskHighWater` await, re-check `registry.get(id)` and prefer a registry
  entry if one appeared meanwhile. Do this on the throw path too. Without the
  fix, a disk read that started before the pin could install a stale static
  boundary over the resume.
- **Finite reads** (non-follow) are bounded by the boundary they resolved, which
  is `≤ H` during resume. They are not aborted.

## 5. Concurrency with maintenance

`attach` and maintenance (`delete_session`, `gc`) are already mutually
exclusive. `attach` sets `state = 'attaching'` synchronously, and maintenance
claims `maintenanceInFlight` synchronously. Two additions:

- `attachInFlight` must cover canonicalization, lookup, and startup, so that
  shutdown and maintenance wait for the whole attach.
- After lookup, re-check the torn/compromised store state before resuming.

`gc` already keeps the blobs referenced by retained sessions, so a resumed
session's blob verification is safe. `maintenance.ts` gets no production
changes.

## 6. Control and request identity

The attach reply does **not** gain a `resumed` field. `already_active` stays
reserved for an already-running binding. A resumed attach runs a fresh
setup-pending check for the new chat, through the normal
`slipstream.agent.connection.v1` path.

`beginTask`, `ask`, `claimQuestion` and `answerQuestion` currently re-check
`req.session_id` and the triple after an await. Because an id can now come back
to life, an id comparison is no longer enough: each of them must also confirm
that `current` is the same object reference it captured before the await.
Without this, a detach followed by a resume of the same id would let a stale
request act on the new activation.

## 7. Semantics across a resume

### D1 (A): task pointer and agent connection reset

- A `slipstream.session.resumed.v1` record clears the current-task pointer. This
  applies to the live fold (`taskSequencer.onCommitted`) and to the recovery fold
  (`recovery.ts`). Changes after a resume carry no `task_hint_id` until a new
  `begin_task`.
- Task declaration and idempotency history are kept. Replaying an old
  `request_id` returns the original result, but it does **not** reactivate that
  task as current.
- An in-process storage recovery (`tryStorageRecovery` → `seedTaskState`) must
  preserve tasks declared since the latest resume. This falls out of the
  recovery fold: the pointer is only set by `task.started` records after the
  last `session.resumed`.
- A `session.resumed` record supersedes any earlier `agent.connection` record.
  The contract states that a log consumer must treat connection status from
  before the latest resume as stale. Nothing new is appended for this. The
  daemon's live view already uses the registry.
- SKILL.md gains an exception to "do not re-call it to 'resume' a task": after a
  new attach, the agent declares its task again.

### D2 (A): questions do not carry across a resume

- Questions queued before a resume stay in history, but they cannot be claimed
  afterwards. Claim eligibility (`unattemptedQuestions`) is rebuilt only from
  queues recorded after the latest `session.resumed`, both on resume and on
  storage recovery. Storage recovery must not resurrect them.
- No dispatch attempts are fabricated.
- Questions that were already attempted keep today's answer handling. The
  answer/attempt indexes still cover full history.
- `committedQuestions` (request-id idempotency) keeps full history.

This matches `docs/ask-agent/decisions.md`: "do not claim old queues resume
across daemon restart."

### Gap reason

Keep `capture.gap.v1` reason `restart` and redefine its description to cover
re-attach after a detach as well as a daemon restart. The gap means the daemon
did not watch for an unknown interval. It does not claim to know that interval
exactly; reconciliation reports the observed states afterwards.

## 8. Components touched

| File | Change |
| --- | --- |
| `src/store-reader.ts` | `findWorkspaceSession` |
| `src/daemon.ts` | Lookup in attach, resume path in `startAndActivate`, failure freeze at `H`, `attachInFlight` coverage, `current` reference guards, `SESSION_RESUME_FAILED` |
| `src/boundary-registry.ts` | Invariant comment only |
| `src/http-reader.ts` | `boundaryFor` re-check |
| `src/session.ts` | Live-fold resets on `session.resumed`; question eligibility after the latest resume |
| `src/recovery.ts` | Recovery-fold resets; expose post-resume question eligibility |
| `schemas/slipstream.capture.gap.v1.json` | `restart` description |
| `schemas/slipstream.session.resumed.v1.json` | Reset semantics in the description |
| `docs/ask-agent/contract.md` | Attach resumes, `SESSION_RESUME_FAILED`, reset semantics, stale connection rule |
| `SKILL.md` | Re-declare the task after a new attach |
| `IMPLEMENTATION_PLAN.md` | Status line |

No production changes to `maintenance.ts`, `reader-runtime.ts` or `lock.ts`.
`attach-workflow.ts` output is unchanged; it still prints "Recording
<worktree>…".

## 9. Tests

Each test is mapped to a requirement from the brief.

- **Re-attach resumes, same id, continuous seq**
  - Same daemon: attach → edits → detach → edits while detached → attach.
    - Same `session_id`.
    - The first post-resume record is `H+1`.
    - `session.resumed` + `restart` gap are present.
    - Files edited while detached are reconciled.
  - Restarted daemon: same assertions with a new daemon on the same store.
- **Different chat, same workspace**
  - Attach with chat B after chat A detached: same id, a fresh `setup_pending`
    targeting B.
  - Chat B attaching while A is active still gets `SESSION_ACTIVE`.
- **Removed session never resumed**
  - After `delete_session`, attach mints a new id.
  - A tombstoned residual log is ignored.
- **Lookup**
  - Duplicates: the newest last-record `time` wins, with the UUID tie-break.
  - A symlinked worktree path matches.
  - A session with an unreadable first record is skipped with a warning.
- **Resume failure (fail closed)**
  - Each of these yields `SESSION_RESUME_FAILED` naming the id, mints no
    fallback UUID, and keeps the registry boundary at `H`:
    - corrupt mid-log
    - held session lock
    - missing CAS blob
    - root mismatch
    - injected startup failure
- **Follower sees post-resume records**
  - SSE follower on the frozen session, and on a disk-only session (prior daemon
    run): after resume, the follower reconnects and receives every record past
    `H` exactly once.
  - A delayed disk lookup in `boundaryFor` that crosses the pin does not
    install a stale boundary.
  - Finite reads during resume stay `≤ H`.
- **Concurrent attach / maintenance**
  - `delete_session` / `gc` during an attach that is still in lookup is refused,
    and vice versa.
  - Shutdown waits for an in-flight lookup.
- **Semantic resets (D1/D2)**
  - No `task_hint_id` after a resume until a new `begin_task`.
  - Replaying an old `request_id` does not reactivate its task.
  - Storage recovery after a post-resume `begin_task` keeps that task current.
  - Pre-resume questions are not claimable after a resume, including after
    storage recovery.
  - A pre-resume connection is not carried forward.
- **Activation identity**
  - A `begin_task`/`ask`/`claim`/`answer` straddling detach + resume of the same
    id is rejected.
- **Touched-area regression**
  - Full existing suites for the daemon, boundary registry, HTTP reader,
    session, recovery, and ask-agent.
  - `typecheck` and `lint`.
