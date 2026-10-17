# Workspace auto-capture — design

Date: 2026-10-05, revised 2026-10-17 (16-capture limit and overhead checks added the
same day). Owner: Brian. Status: **spec in review** (no product code yet).
Architecture via two Codex consult rounds (2026-10-05, 2026-10-17); this document
is the settled result.

## Goal

Every Conductor workspace is automatically captured, watch-only, up to **16
workspaces recording at once**, with negligible overhead on the machine,
especially when idle. Up to 10 agent chats can be linked
at once, one per capture, so Brian can flip between workspaces in the native app
and Ask Agent in each. Capture stops when the workspace is archived, and survives
daemon restarts and maintenance without anyone thinking about it.

Capture reports observed filesystem states with explicit gaps, never a claim of
complete edit history. A linked chat is a question-delivery relationship, never
file authorship.

## Owner decisions

2026-10-05 rows are kept. Superseded rows are marked; the 2026-10-17 ruling is the
one in force.

| # | Decision | Ruling 2026-10-05 | Ruling 2026-10-17 (Brian) |
|---|---|---|---|
| Q4 | Session scope | One active capture daemon-wide. **Lifted:** several captures at once, one per worktree. | **Lifted further.** Every workspace is captured, watch-only by default; capped at **16 recordings** (D10; about 57 workspaces are open today, but Brian expects to keep 12-16). Up to **10 agent chats** linked at once, **one linked chat per capture**. Never two chats on one capture; replacing a chat needs an explicit unlink. Flipping between workspaces in the native app and asking each agent is "extremely important". |
| D1 | Capture cannot become ready | ~~Setup fails visibly; the agent never starts on an uncaptured workspace.~~ **Superseded.** | **Revised.** Strict launch blocking is not required. Setup that cannot make capture ready exits non-zero with a readable reason. The workspace shows as **NOT recording** with that reason in public status and reader projections, even if no session log exists. Recovery and enrollment retry transient failures with backoff. Capture becoming ready after an agent already edited is honest: the first baseline is the first observed state, never a claim of the original state. P3 documents Conductor's real launch behavior when it writes the setup scripts. |
| D2 | Dependency/build output | ~~A fixed, ratified exclusion list.~~ **Superseded.** | Superseded by the shipped git-driven capture scope (PR #50, PR #54): `.gitignore` plus `.slipstreamignore`, disclosed by `slipstream.capture.scope.v1`. No fixed directory list. |
| D3 | Trigger | Personal Conductor setup/archive scripts across projects, not daemon folder discovery. | Unchanged. Chained into repo-level overrides via `.conductor/settings.local.toml`. |
| D4 | Storage | Retain history until explicitly deleted. | Unchanged. |
| D5 | Agent binding | ~~Watch-only now; verified binding is a separate later step.~~ **Changed.** | Capture is watch-only until a chat runs `slipstream attach`, which binds that chat **in place** onto the live capture: same `session_id`, no new baseline, no resume event, no fabricated gap. Earlier changes are never credited to the chat. |
| D6 | Order | Measure first, then the minimal slice, then recovery and maintenance. | **Revised (Brian, 2026-10-17).** P1 measured once and answered the question that could stop the feature: the watcher holds 16 captures cheaply. No further benchmark runs gate any PR. Known costs are fixed as code changes with counting tests; overhead is judged once, at P6, in real use. See "Overhead". |
| D7 | Install | ~~Global install from a dedicated clone plus launcher.~~ **Superseded.** | Install is the published npm package `@playola-radio/slipstream`. Setup scripts and the LaunchAgent use the absolute Node 24 path and the real `dist/cli.js` path, recorded at install time. No nvm sourcing. |
| D8 | Overhead gates | Proposed, not ratified. | **Amended (Brian, 2026-10-17).** The bar is idle CPU, memory and no lost changes, judged in real use at 16 captures (see "Overhead"); a miss there is report-and-stop. The wakeup, baseline-seconds and latency-regression gates are dropped: wakeups cannot be measured without sudo, and stopwatch numbers on a loaded laptop kept producing failures that told us nothing new. |
| D9 | GC | New. | **Ratified.** `slipstream gc` may quiesce all captures (a disclosed maintenance gap via stop events plus the existing resume gap), then automatically resume them and re-handshake bindings. Fully concurrent GC is deferred. |
| D10 | Capture cap | New. | **Ratified 2026-10-17.** At most **16** workspaces record at once. Beyond that a workspace is visibly **NOT recording** (`capture-limit-reached`) and starts automatically, oldest request first, when a slot frees. No eviction. The limit is one constant; raising it later is that change plus the P6 real-use check at the new number. |
| R | Restart recovery | Later unit. | **In the MVP.** Durable capture and binding intent, a user LaunchAgent, reuse of PR #64's resume. Bindings are restored as `setup_pending` and upgraded to `connected` only by a fresh live round trip. |

Stage 3 criteria amended by Q4 and D5 (one active capture daemon-wide, explicit
selection, detach-before-switch, no competing auto-start) are amended by explicit
dated notes in `IMPLEMENTATION_PLAN.md`; the original criterion text is kept.
Identity verification, watcher-primary capture, and every other acceptance gate
are unchanged.

## What exists today (verified in code)

- Single-active lives only in the daemon control plane (`src/daemon.ts`
  `state`/`current`). Attach while another workspace is active, or the same
  workspace with another chat, returns `SESSION_ACTIVE` (`src/daemon.ts:521`,
  `:524`). Log, CAS, reader, boundary registry and `CaptureSession` are
  multi-session.
- `CaptureSession` already separates filesystem capture from the daemon-held
  harness identity and exposes `recordAgentConnection` (`src/session.ts:124`,
  `:1122`). In-place binding needs no watcher restart.
- `slipstream start` runs the daemon in the foreground (`src/cli.ts:235`). The
  ensure-running logic that spawns it is private to `src/attach-workflow.ts`.
  Its error advice names a `slipstream stop` command that does not exist
  (`src/attach-workflow.ts:91`).
- `attach` requires a harness identity; there is no watch-only mode. One-command
  attach (A5) detects the chat from its environment, verifies the root
  transcript, installs workspace config, and proves one round trip.
- The control client times a response out at 15 s (`src/control-client.ts:39`),
  so a long baseline held on one request would hit that cliff.
- Transcript polling is switched on by daemon config (`transcriptRuntimeFrom`),
  not by the attach identity. Each capture owns its own discovery loop; it
  reschedules 2 s after each scan (`src/config.ts:32`). Codex discovery is capped
  at 2,000 files (`src/config.ts:18`); `~/.codex/sessions` holds more than that,
  so scans truncate and disclose it.
- Each capture holds its own heartbeat lock, plus one store lock: N captures cost
  N+1 lock reads and `utimes` every 2 s (`src/lock.ts`).
- Capture scope is git-driven (`.gitignore` plus `.slipstreamignore`, disclosed
  by `slipstream.capture.scope.v1`). Ignored files can still produce native
  watcher notifications.
- Baseline reads every in-scope file and appends one `file.baselined` event per
  file.
- Delete and GC refuse while any capture is attaching, active or detaching
  (`src/daemon.ts:881`). Detach appends no public stop event today.
- The boundary registry assumes retained sessions never become active again
  (`src/boundary-registry.ts`).
- PR #64 gives resume: same session id, recovered sequence, `session.resumed`,
  `capture.gap{restart}`, scope disclosure and reconciliation. Resume clears task
  selection and agent connection. Questions queued before a restart are history
  only and are not redelivered.
- Codex attach verifies `cli_version` against an exact allowlist (0.154.0,
  0.155.1); Conductor bundles 0.156.1. Irrelevant to watch-only capture; relevant
  to Codex chat linking, where it stays an explicit refusal.

## Conductor facts (verified 2026-10-05)

- Settings layer like VS Code. Precedence, highest first: managed ->
  `<repo>/.conductor/settings.local.toml` -> `<repo>/.conductor/settings.toml` ->
  `~/.conductor/settings.toml` -> defaults. `[scripts] setup` / `archive` are valid
  in the user file (schema `settings.schema.json`). Legacy `conductor.json` is
  still read.
- Setup runs after Conductor creates a workspace; archive runs before it archives
  one. Both run in the workspace dir with `CONDUCTOR_WORKSPACE_PATH` set.
- **A repo-level setup/archive script overrides the user-level one.** Six repos
  on this machine already define their own (mix of `.conductor/settings*.toml`
  and legacy `conductor.json`). These need a per-repo local override that runs
  Slipstream *and* the repo's own script.
- **Unverified, and no longer load-bearing:** whether Conductor blocks agent start
  until setup succeeds. D1 (revised) does not depend on it. P3 documents the
  behavior when it writes the setup scripts.
- Live workspace count: 46 ready + 11 sleeping = **57** (1,050 archived). With the
  cap of 16 (D10), most of these wait until Brian archives down; see enrollment.

## Design

### Units

#### 1. Multi-capture control plane

Replace the single `state`/`current` slot with:

- `capturesBySessionId`: lifecycle, canonical root, activation generation, session
  handle, optional binding, and per-capture in-flight operations.
- `sessionIdByCanonicalRoot`: includes waiting, queued, and starting captures.
- `bindingsBySessionId` (unit 2). There is **no daemon-wide selected-binding
  slot**.
- One store-wide ownership/shutdown state and one baseline queue.
- One capture limit (D10): `MAX_CAPTURES = 16` running capture intents, counting
  queued, baselining, recording and failed-retrying captures. Waiting intents are
  kept in request order.

Lifecycle: `queued -> baselining -> ready -> stopping -> stopped`, with explicit
failure states. A per-capture failure affects only that capture; loss of the
store lock shuts down all writers.

Targeting and admission:

- Canonicalize the path first, then atomically reserve the root. Concurrent
  requests for the same root share one activation.
- Ancestor and descendant roots are rejected by path components, including waiting and queued
  roots. Sibling git worktrees that share repository metadata are allowed.
- **Capture limit (D10).** A new root while 16 captures hold slots is not
  admitted. Its intent is kept as waiting, public status is NOT recording with
  reason `capture-limit-reached`, and the caller gets:

  > `CAPTURE_LIMIT_REACHED: 16/16 capture slots in use. This workspace is NOT recording. It starts automatically when another workspace is archived or detached.`

  When a capture stops for archive or detach, the oldest waiting intent is
  admitted automatically through the normal queue. Maintenance and restart keep
  slots; they never reshuffle which workspaces record. A chat attach on a waiting
  workspace gets the same refusal and stays unlinked. A capture is never evicted
  to make room.
- `detach` and `status` take a target. A CLI convenience may resolve the current
  directory, but the wire request names its target. `status` with no target lists
  all.
- Every mutating verb, including task and question delivery, resolves its target
  and re-checks the activation and binding generation after each await.
- PR #64's historical-session selection and corruption behavior is preserved. If
  repeated all-session scans become material, use a rebuildable in-memory index;
  the logs stay authoritative.

#### 2. Watch-only capture and in-place chat binding

**Watch-only.** `attach --watch-only` needs no harness identity and starts no
transcript polling. Its start event records an additive initial capture mode, so a
disk reader can tell a watch-only activation. That mode is not rewritten by later
binding. A watch-only capture refuses tasks and questions until a chat is bound.

**Binding in place.** One-command attach keeps environment-based chat detection,
root-transcript verification, supported-runtime checks, and workspace
configuration install. Its preflight becomes workspace-targeted: an existing
watch-only capture is eligible, and another workspace's state is irrelevant.

1. If the workspace is queued or baselining, attach joins its readiness operation.
   It neither starts a duplicate capture nor fails with `CAPTURE_NOT_READY`.
2. Once ready, binding is serialized against detach, archive and competing chat
   attaches on that capture.
3. After verification and a durable `agent.connection.v1 {state: "setup_pending",
   target}` append, the binding is published.
4. The existing hook-delivery and answer round trip is kept. Only its durable
   `connected` event enables Ask Agent. `connected` means a round trip succeeded,
   not that the chat is alive now.
5. Failed verification or configuration leaves filesystem capture running and
   unbound.

Event consequences: same `session_id`, continuous sequence, no new baseline, no
`session.resumed`, no fabricated gap. The connection event records a
question-delivery relationship, never file authorship. Earlier changes are never
credited to the newly bound chat.

**Binding record.** `bindingsBySessionId` holds, per binding:
`{harness, harness_session_id, canonical_worktree, verified_transcript_path,
binding_generation, connection_state}`.

**Routing by identity.** `--store` selects the daemon, never the chat.

- **App to question.** `ask` names the selected capture's `session_id`. The
  daemon requires that capture's connected binding and durably records the
  question's target. Switching the app's selection cannot redirect a queued
  question, and never changes a binding.
- **Hook to claim.** The existing hook sends harness, harness session id,
  worktree and transcript path. The daemon resolves that exact identity to one
  binding, rejects mismatches and subagents, and returns only that capture's
  question or setup check.
- **Tool to answer/task.** The MCP forwarder supplies harness context
  independently of the model's arguments. The daemon resolves the identity triple
  to the capture and verifies question ownership before accepting an answer.
  There is no fallback to a "current capture". Explicitly supplied session ids
  must also match. Forwarders do not need a global selection or a hard-coded
  capture UUID in workspace config.
- **Setup proof.** A fresh unpredictable check id is scoped to capture, binding
  generation and activation. It is delivered only to the matching root hook and
  answered only from the matching forwarder identity at the current generation.
  The capture's `agent.connection.v1 {state: "connected"}` is appended before the
  acknowledgement.

**Cap and refusals.** At most **10 durable binding intents**, counting connected,
pending, unavailable and in-flight reservations. Slots are reserved atomically;
restored bindings keep theirs; there is no eviction on app switching or
inactivity. Failed verification releases an uncommitted reservation; a durably
linked but pending chat keeps its slot. Occupied slots and their states are
exposed. Refusal text:

> `BINDING_LIMIT_REACHED: 10/10 chats linked. This workspace is still recording without a linked chat. Unlink another chat to connect this one.`

Same-chat attach is idempotent. A different chat on a capture that already has a
binding gets `BINDING_EXISTS` with explicit unlink instructions; it cannot steal
the binding.

**Unlink.** `unlink --session <id>` durably revokes binding intent, invalidates
setup checks, clears the binding's task selection and claim eligibility, and
leaves filesystem capture running. Public binding and unlink events make these
transitions reproducible; per-session connection events keep reporting handshake
results. Event names and shapes are settled in P1's contract.

**Binding situations.**

| Situation | Behavior |
|---|---|
| Same chat resumed by Conductor, same harness session id | Reuse intent; verify identity and complete any required fresh handshake. |
| New chat in the same workspace | Refuse takeover (`BINDING_EXISTS`); explicit unlink, then attach the new chat. |
| Transcript missing, unreadable, changed identity, or unsupported runtime | Capture keeps running; binding is unavailable with a public reason. Intent and slot are retained; validation retries without guessing another chat. |
| Transcript exists but the chat is gone | Stays pending until a live round trip occurs. Transcript existence proves no liveness. |
| Workspace archived | Durably revoke capture and binding intent; release the slot; never restore automatically. |
| Hook or tool configuration missing or unloaded | Pending with a repair/reload reason; no promise of automatic reconnection. |

#### 3. Admission and `--wait`

Admission returns a stable target and lifecycle state before any baseline work.
Baselines and reconciliations run one at a time (concurrency 1). `--wait` makes
short targeted status polls until ready or failed, so no control request is held
near the 15 s timeout. A caller timeout reports **still pending, outcome
unknown**, never "nothing happened"; retrying the same target cannot create a
second capture.

Ready means watcher installed, baseline and reconciliation complete, and the
durability barrier succeeded. Queued is explicitly **not coverage**.

#### 4. Public lifecycle

New event `slipstream.capture.stopped.v1`, reason one of: `detached`, `archived`,
`maintenance`, `root-missing`, `watcher-failed`. On a clean stop: stop
observation, drain accepted work, append and flush the stop event, close the log.
After ownership loss or an unwritable store no stop event is manufactured;
recovery discloses the gap.

Public status and binding states are published through the reader contract so a
client never needs private control status:

- Capture: queued, baselining, recording, stopped (with reason), and **NOT
  recording** with a readable failure reason, including when setup failed and no
  session log was created.
- Binding: `setup_pending`, `connected`, unavailable (with reason), unlinked.

A historical start without a stop is not proof that capture is live. Today's
reader cannot tell a stopped capture from a quiet one; with many always-on
captures that distinction must be in the public log.

#### 5. Durable recovery

Capture intent and binding intent are persisted in a documented control-intent
record, durably, before a lifecycle change is acknowledged. It is control intent,
not evidence that capture happened. A user LaunchAgent restarts the daemon after
a crash or login, with absolute executable paths and visible failure diagnostics.
Capture before user login is not promised.

- Running intent survives daemon shutdown, crash and maintenance. Explicit detach
  or archive withdraws it, durably, even when the daemon is down, and a successful
  archive acknowledgement fences stale recovery work.
- Before any recovery write, reserve fresh ids and pin **every** resumable session
  at its recovered durable boundary in the boundary registry, then queue startup
  and reconciliation at concurrency 1. All resumable sessions are reserved before
  the reader is exposed; each is activated after its durability barrier.
- Reuse PR #64: same session id, recovered sequence, `session.resumed`,
  `capture.gap{restart}`, scope disclosure, reconciliation.
- Archived or tombstoned intent is never resumed. A missing or replaced root fails
  visibly as NOT recording; a recreated directory at the same path does not
  inherit the capture.
- Transient failures retry with backoff. No reconstruction of unseen edits and no
  additional capture source.
- **Bindings.** Resume restores binding intent, revalidates transcript identity
  and runtime, appends a fresh `setup_pending` and a new activation-scoped setup
  check. The chat's next eligible tool callback receives it and its answer
  re-establishes `connected`. No `slipstream attach` rerun is needed while hooks
  and tools stay installed and loaded. The same pending check is re-offered on
  later eligible callbacks until acknowledged, throttled, with idempotent
  confirmation; today's delivered-once flag must not strand recovery after a lost
  callback. Durable revocations are honored even if a crash interrupted their
  public event; intent is never inferred from an old `connected` event.
- Existing PR #64 semantics are kept: the current task resets, and questions
  queued before a restart stay history-only (no redelivery).

#### 6. Conductor integration and enrollment

- **Install.** The published npm package. At install time, resolve and validate
  `process.execPath` (Node 24) and the package's real `dist/cli.js`; store them
  absolute and correctly quoted in the Conductor scripts and the LaunchAgent. No
  nvm sourcing, no interactive-shell dependence; subprocesses get a deliberate
  PATH that includes git. A Node or package upgrade refreshes the script paths and
  the LaunchAgent together. Because Node will not strip TypeScript types inside
  `node_modules`, the package ships compiled output.
- **Ensure-running.** Extract the private ensure-running logic from
  `src/attach-workflow.ts` and share it between chat attach and Conductor setup,
  with LaunchAgent supervision for the managed install. Explicit daemon
  configuration is preserved. Fix the nonexistent `slipstream stop` advice.
- **Setup script.** `slipstream conductor setup`: ensure the daemon, admit a
  watch-only capture for `$CONDUCTOR_WORKSPACE_PATH`, wait for ready, then run the
  repo's own setup. If capture cannot become ready: non-zero exit with a readable
  reason, and the workspace shows NOT recording (D1 revised). Never a silent
  half-capture.
- **Archive script.** `slipstream conductor archive` durably withdraws running
  intent and stops that target before any repo archive command can remove the
  root. History is retained (D4).
- **Overrides.** The installer inspects effective configuration, including legacy
  `conductor.json`, and writes `<repo>/.conductor/settings.local.toml` chaining
  `slipstream conductor setup && <repo's own setup>` (and the archive equivalent),
  preserving unrelated settings, recording the chained command, and reporting
  drift if the repo's script later changes.
- **Existing-workspace enrollment.** An idempotent command consumes Conductor's
  verified inventory of non-archived workspaces, including sleeping ones, and
  enrolls them through the same queue. It does not infer "open" from a directory
  existing. It records current baselines (first observed state), not historical
  backfill, and reports per-workspace failures. With more than 16 live workspaces,
  roots are admitted most recently active first (Conductor's own activity time if
  the inventory exposes one, otherwise inventory order, disclosed in the output);
  the rest wait visibly under D10. The output says to archive unused workspaces to
  free slots.

#### 7. Maintenance

- **Delete.** Inactive, non-resuming sessions can be deleted while unrelated
  captures run. The target is reserved against attach, tombstone-first ordering is
  kept, and its restart intent and binding intent are removed. Active targets are
  rejected.
- **GC (D9).** An explicit maintenance transaction closes new activation
  admission, cleanly stops all captures (reason `maintenance`), preserves running
  and binding intent, runs the existing detached mark-and-sweep, and resumes the
  intended captures automatically, re-handshaking bindings as in unit 5. Stale
  setup checks cannot connect a new activation. Resume happens even after a GC
  failure when storage is still usable. If any writer cannot be proven stopped,
  sweeping is refused; every store writer participates in the exclusion.
- Fully concurrent GC would need protection spanning blob publication, including
  reuse of an existing hash, through event commit. It is deferred.
- No automatic retention.

#### 8. Shared transcript discovery

Linking a chat does **not** by itself enable enrichment. Unconfigured enrichment
stays off; Ask Agent and binding restore never depend on the scanner. When
enrichment is configured, one daemon-owned scheduler replaces N per-capture
discovery loops: enumerate Codex sessions once per cycle and each relevant Claude
directory once, share discovery and header work, then apply the existing per-root
eligibility and per-session evidence and coverage rules. Evidence from other
eligible chats in the same worktree is preserved (restricting to the linked
transcript would silently narrow attribution evidence). Cadence and scan-limit
disclosure are unchanged; sharing discovery removes the multiplication, it does
not make a truncated scan complete. No limit raised, no interval shortened,
without measurements.

### Data flow

Conductor creates a workspace -> setup script -> `slipstream conductor setup` ->
daemon admits a watch-only capture (queued -> baselining -> ready) -> setup exits
0, then the repo's own setup runs. If the agent edits before ready, those edits
are inside the first baseline, which says so by being the first observed state.
Changes flow through the existing watcher -> engine -> log -> reader path, per
capture.

A chat runs `slipstream attach` -> the daemon binds it in place -> the next root
hook callback receives the setup check -> the agent returns it -> `connected`.
Native app: Ask Agent names the selected capture's `session_id`; the daemon
delivers to that capture's binding only.

Archive -> intent withdrawn and binding revoked -> targeted stop ->
`slipstream.capture.stopped.v1`; history stays in the store. Daemon crash or
login -> LaunchAgent starts the daemon -> all resumable sessions reserved and
pinned -> captures resume through the queue -> bindings return as `setup_pending`
until a live round trip.

### Error handling

- Daemon unreachable, root overlaps, or baseline fails -> setup exits non-zero
  with the reason; the workspace is NOT recording in public projections; recovery
  retries transient failures with backoff.
- Root deleted or replaced under a live capture -> `capture.stopped`
  (`root-missing`); never re-attached to a recreated directory.
- Watcher error -> existing coverage-gap path, per capture.
- Lock loss on one capture affects only that capture; store-lock loss stops all
  writers and no stop events are manufactured.
- Resource failure yields an explicit NOT-recording state, never silent eviction.
  The capture limit (D10) is explicit and public, never quiet.
- Binding failures never stop capture; they surface as binding states with
  reasons.

## Overhead

**What P1 found (one run, 2026-10-17, Brian's loaded M1 Max).** Sixteen
watch-only captures in one process: 0 watcher failures, 33 file descriptors,
142 MiB footprint, 0.6% of one core idle, and no recurring worktree reads after
settling. The watcher scales to the cap. The run also confirmed two costs that
were already visible in today's code. They are code to change, not open
questions:

- **Restarting a capture re-saves every file.** `createCas` runs once per
  session and `put` republishes, with fsyncs, every blob that session has not
  yet written, even when the blob is already on disk. A 4,200-file start took
  about 90 s whether the store was warm or cold. P2 owns this.
- **Each linked chat rescans transcripts on its own.** With one emulated chat,
  idle CPU was 22% (about 850 transcript file opens/s); with ten, 112%. P5's
  shared discovery owns this.

The benchmark tool is parked on the branch `briankeane/autocapture-bench-parked`.
It is not maintained and gates nothing.

**Counting tests (CI, deterministic).** These replace stopwatch gates for the
known costs. They count operations, so they give the same answer on any machine:

- Starting a capture over files already in the store publishes no new blobs
  and fsyncs no blob files (P2).
- After settling, an idle capture makes no worktree listings, content reads or
  git spawns (P2).
- Writes made to live captures while another capture baselines all appear as
  changes; none are lost (P2).
- With several linked chats, one discovery cycle enumerates each transcript
  directory once, not once per chat (P5).

**Real-use check (P6, the D8 verdict).** Sixteen workspaces recording, with
linked chats, for a working day of normal use: the daemon's idle CPU stays at or
under 1% of one core on average, its memory stays at or under 512 MiB with no
sustained growth, and no change is lost (no unexplained gap, zero watcher
subscription failures). A miss is written up with numbers and stops the work
(CLAUDE.md).

No check is ever met by quietly narrowing capture, lowering the capture limit
below D10, or trading CPU for fidelity.

## PR graph

P1 is complete. P3 and P4 can proceed in parallel once their intent contract is
locked; P5 is independent after P2; native-client work can begin against P2's
published contracts. Durable binding belongs in P3, not a later enhancement.

| PR | Depends on | Review boundary | Shared behavior |
|---|---|---|---|
| **P1 Measurements and amended contracts** | none | One overhead run at 16 captures (result above); D10 cap; event and control contract design | No runtime changes |
| **P2 Concurrent captures and linked chats** | P1 | Capture table, admission and `--wait`, 16-capture limit with visible waiting, targeting, in-place binding, 10-slot cap, unlink, generation fencing, public lifecycle and binding projections; no re-save of stored blobs on start; P2's counting tests | **Yes:** daemon, session, hooks, forwarders, readers |
| **P3 Durable recovery and Conductor enrollment** | P2 | Capture and binding intent, fresh recovery handshake, LaunchAgent, absolute npm paths, scripts and overrides (documenting Conductor's real launch behavior), existing-workspace enrollment, visible failures and retries | **Yes:** recovery, registry, attach orchestration |
| **P4 Maintenance without manual detachment** | P2; P3 intent contract | Inactive deletion, disclosed GC quiescence, automatic capture resume and binding re-handshake | **Yes:** lifecycle, storage, maintenance |
| **P5 Shared transcript discovery** | P2 | Shared scheduling and discovery with unchanged per-root eligibility, evidence and coverage semantics; P5's counting test | **Yes:** transcript and enrichment suites |
| **P6 Native app and release acceptance** | P3-P5 | Per-capture recording and connection states, failure reasons, independent Ask Agent behavior, restart/GC recovery, the real-use overhead check, reader parity | **Yes** if client changes are needed |

No clone-install PR and no exclusions PR. Every shared-behavior PR runs the full
affected pre-existing suites (touched-area rule).

Acceptance requirements (P6 unless a PR owns the test):

- Flip between at least two native-app workspaces and Ask Agent in each; only the
  intended chat receives and answers each question.
- Restart the daemon: both captures resume; both bindings show pending; each
  reconnects after its own next eligible callback and answer.
- Repeat through GC quiescence; stale checks cannot connect a new activation.
- Cross-chat answers, subagent callbacks, unlink/relink races, and concurrent
  attempts for the tenth slot.
- Same-id chat resume, new-chat refusal, missing transcripts, archive during
  recovery, and lost setup-check responses.
- Failed setup stays visible; later readiness baselines current bytes without
  presenting earlier edits as captured history.
- Public-reader and native parity, and the real-use overhead check at 16
  captures with linked chats (the D8 verdict).
- The 17th workspace is visibly NOT recording (`capture-limit-reached`) and starts
  automatically when a slot frees.
- Trace CLI -> control -> session/log -> reader -> Ask Agent end to end; exercise
  both independent readers and the existing Conductor Claude attach workflow.
  Codex's unsupported version stays an explicit refusal.

## Testing

- P2: concurrent attach/detach, same-root coalescing, overlap rejection,
  per-capture isolation (one capture's lock loss or watcher error leaves others
  healthy), targeted verbs, watch-only refusal of tasks and questions, in-place
  binding (no baseline, no resume event), `BINDING_EXISTS`,
  `BINDING_LIMIT_REACHED` and the tenth-slot race, `CAPTURE_LIMIT_REACHED` and
  the sixteenth-slot race, oldest-first admission when a slot frees, unlink and relink races, hook,
  tool and answer routing by identity including cross-chat answers and subagents,
  setup-check scope to capture/generation/activation, `--wait` outliving the 15 s
  control timeout, `capture.stopped` reasons, independent readers see each
  session, and the P2 counting tests under "Overhead". Full pre-existing
  daemon/session/control/reader suites.
- P3: crash at each lifecycle transition, missing or replaced root on resume,
  archive racing restart and archive with the daemon down, reserve-all before
  reader exposure, binding restore as `setup_pending`, re-offered check after a
  lost callback, setup exit codes and NOT-recording projection, backoff retry,
  local-override chaining and drift, enrollment idempotence and over-limit
  ordering, waiting intents surviving restart, absolute paths after an upgrade.
- P4: inactive delete beside running captures, publication/reuse/sweep races,
  disk-full, store-lock loss, quiesce-then-resume with binding re-handshake.
- P5: one enumeration for N captures (the P5 counting test), per-root eligibility and disclosure
  unchanged, evidence preserved from other chats in the worktree, scan-limit
  disclosure.
- P6: the acceptance list above.

## Out of scope

Redelivery of questions queued before a restart or GC (PR #64's history-only rule
stays); multiple chats per capture; daemon folder discovery; Codex version
allowlist changes; automatic retention; fully concurrent GC; a second capture
source, a missed-edit backfill hook, polling, or a shorter debounce.
