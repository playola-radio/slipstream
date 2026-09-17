# Slipstream — MVP Implementation Plan

Date: 2026-09-16
Status: approved to build (Brian, after Codex adversarial review)

## What the MVP is

A **live feed of code changes as an agent makes them**, watched alongside the
agent in a browser. Conductor stays the launcher. Slipstream rides in via user-level
MCP + skill config.

## What the MVP promises — and does not

The single most important framing decision, per Codex's Q14 amendment:

> Slipstream streams **a live history of observed filesystem states, with explicit
> coverage gaps.** It does not claim to be a complete record of every write.

A watcher observes states, not writes. If a file goes `A → B → C` before Slipstream
reads it, Slipstream reports `A → C`. An `A → B → A` cycle can be entirely invisible.
This is disclosed in the schema via `slipstream.capture.gap.v1` and surfaced in the
UI — never papered over.

Likewise, `session_id` means **capture scope** (which worktree is being watched),
never proof of authorship. Attribution is revisable inference with an explicit
status, not a verified claim.

## The hard rule

**The event schema is the product's public interface.** The on-disk JSONL log +
CAS blobs are the source of truth; the HTTP/SSE reader is a thin view over them;
the bundled UI is one client among possible many. Anyone must be able to delete
the front-end and replace it. Every stage below is gated on this: if a stage's
capability is not reachable through the published schema + reader API, it is not
done.

## Stack — settled

**TypeScript on Node 24 LTS throughout**: daemon, MCP forwarder, and UI.

The capture path is syscall- and disk-bound, not CPU-bound. Per change it does a
stat, a read, a SHA-256 (OpenSSL — the same C library Go or Rust would call), a
blob write, a byte diff, and an append. A 100 KB file hashes in ~0.1 ms against a
human-perception budget of ~50 ms. Language choice is not the constraint.

The decisive argument is the hard rule above: one language means the daemon and
every bundled client share a single TypeScript type generated from the JSON
Schema, so the compiler enforces the contract. A split stack would hand-maintain
that contract in two places, which is where drift lives. The MCP forwarder is
~200 lines of stdio JSON-RPC with a first-party TypeScript SDK; the UI is React +
Monaco regardless; tree-sitter ships as wasm and loads identically in both.

Known Node-specific risks, each already answered by the design:
- Single event loop — hashing and parsing run in `worker_threads`, which the
  async-enrichment decision (Q1) already requires.
- FSEvents coalescing at scale (`npm install`, branch switch) — a platform limit,
  not a language one; `@parcel/watcher` is a native binding to the same API. The
  answer in any language is debounce, coalesce, and emit `capture.gap`.
- Durability — `fs.fsync` on both file and containing directory is exposed and
  required by the Stage 2 ordering rule.

Rejected: Swift (macOS-only, contradicts a replaceable front-end), C++ (no gain
over Rust here), Go/Rust daemon with a TS client (loses the shared schema type
for a path already far faster than needed).

**Revisit only with Stage 1 numbers.** If measured capture latency is the
bottleneck, the fix is moving one hot loop to a native addon or sidecar, not a
rewrite — and Stage 1's required p50/p99 measurements will name the function.

## Settled decisions

| # | Decision | Choice |
|---|---|---|
| Q1 | Feed granularity | Whole-function clips via tree-sitter, **as async enrichment**; raw bytes + ranges publish first |
| Q2 | Question/comment loop | Not in MVP; schema must make it purely additive |
| Q3 | Front-end-agnostic interface | On-disk JSONL + CAS blobs = truth; HTTP/SSE thin reader over it |
| Q4 | Session scope | One active capture session daemon-wide, bound to one harness session ID + one canonical worktree |
| Q5 | Harnesses | Claude Code + Codex from day one, watcher-primary capture |
| Q6 | MCP topology | stdio thin forwarder → one long-running daemon (verified necessary) |
| Q7 | Event envelope | CloudEvents structured JSON; minimal effort spent on it |
| Q8 | Skill packaging | Portable core `SKILL.md` + optional per-harness enrichment |
| Q9 | Install | Manual/documented for MVP |
| Q10 | stdio spawn model | Verified: one server process per session |
| Q11 | Task grouping | In MVP, via agent-declared `slipstream_begin_task` |
| Q12 | Large/binary/unreadable files | Explicit `unavailable` snapshots with reasons; never a fake empty blob |
| Q13 | Attribution | Revisable inference: `pending` / `heuristic` / `ambiguous` / `unknown` |
| Q14 | Definition of done | Live demo **plus** measured latency, crash/replay tests, and independent-client parity |

### Three amendments accepted from Codex review

1. **Q14 narrowed** — promise observed states with explicit gaps, not complete
   edit history. Done requires measurement, not just a convincing demo.
2. **Q13 restructured** — separate capture scope / declared grouping /
   attribution into three distinct fields. Attribution carries a status and is
   revisable by later append-only events.
3. **Q1 moved off the capture path** — publish bytes and byte ranges
   immediately; append clips asynchronously. Clips are an array of paired spans
   (one change can touch several functions), never a single span.

### Rejected

- **Harness content as a second event stream.** Claude Code's `file-history/`
  is used only to *validate* capture fidelity in Stage 1. Emitting from it too
  would require reconciling two timelines with different coverage and version
  identities. A transcript record may *update attribution*; it may never
  *create* a filesystem-change event. This avoids double-capture structurally.

---

## Stage 1: Prove byte capture

**Goal**: Determine whether watcher-primary capture is accurate and fast enough
to watch live. This is the gate — if it fails, everything downstream is wasted.

**Deliverable**: A CLI that attaches to a worktree, baselines it, watches it, and
writes `file.changed` records with before/after CAS blobs to a JSONL log.

**Scope discipline**: no MCP, no task grouping, no parser, no SSE, no UI.

**Success Criteria**
- Baseline enumerates the worktree with watching installed *before* enumeration
  begins, reconciling during the scan. Baseline is current bytes, not git HEAD —
  a dirty worktree's existing changes are not presented as new edits.
- Per-path serialized processing; each read compares against the **last committed
  snapshot**, not whatever is on disk when the diff worker runs.
- Byte-identical observations emit nothing. Content-hash dedup is **not** applied
  globally — `A → B → A` is two legitimate transitions.
- Capture limits enforced: regular files ≤ 10 MiB. Oversize, unreadable,
  unstable, and io-error paths emit explicit `unavailable` snapshots.
- Renames represented as delete + create. Symlinks excluded, never followed
  outside the root.
- Measured p50/p99 latency from write to committed record.

**Tests**
- Known-write-trace comparison: a script performs a scripted sequence of writes;
  captured transitions are diffed against the trace. Missed intermediates are
  *counted and reported*, not treated as failures.
- Real Claude Code session editing files; captured endpoints cross-checked
  against `~/.claude/file-history/<session>/` versions.
- Real Codex session editing files via `apply_patch`.
- Rapid successive writes to one path.
- Atomic save (write-temp + rename) resolves to a change at the original path.
- File deletion; file creation; empty file (stored zero-byte blob, **not**
  absent).
- Human editor save during an agent turn.
- Oversize file, unreadable-permission file, binary file.

**Status**: Complete.
Implementation, tests (59 passing), and the measurement harness are done, and
the Codex adversarial review is green: the challenge + excess-audit pass produced
one combined fix wave (commit 8e41750), a re-review of that wave surfaced three
more issues (log-corruption-on-write-failure, a fabricated `absent` before-state
for files under an unreadable baseline dir, and a bench scoring gap), those were
fixed in commit fce5189, and the final re-review confirmed no new defects.

Verdict (`STAGE-1-REPORT.md`): watcher-primary capture **PASSES the gate** —
stable ~65–105 ms median commit latency (noisy small-sample p99 tail, ~100 ms
common case), zero fatal/severe loss across repeated runs, only mild
burst-within-file (endpoint always captured).

Both real-agent cross-checks (this section's "Tests") were run and pass — see
`STAGE-1-REPORT.md` § "Cross-check against real agent output":
- `~/.claude/file-history/` endpoint reconciliation: all four real Claude Code
  sessions on this machine (24 files, 49 versions) replayed in real write order;
  every endpoint byte-matched `@vMax`, zero fatal/severe/phantom/missed. (Run as
  a *replay* of real file-history content — the literal live-session variant is
  impossible from this Conductor/SDK session, which does not populate
  file-history; the live-concurrency dimension is covered by the next check.)
- Live Codex `apply_patch` session (real independent concurrent writer):
  create + multi-edit + delete all captured with correct endpoints, deletion
  captured as `absent`, zero phantom/gap.

Two reported-not-fixed items (product/Stage-2 decisions for Brian, per "Decisions
that are not yours to make"): fsync/durability ordering is deferred to Stage 2;
ancestor-symlink TOCTOU is possible and left as a security/fidelity trade-off.
Neither is a Stage-1 gate; both are explicitly Stage-2/product scope.

---

## Stage 2: Prove the durable interface

**Goal**: Freeze the v1 public contract and prove it survives a crash. After this
stage the schema is a published interface, not an implementation detail.

**Deliverable**: Finalized JSON Schemas, sequencing, durable blob publication,
restart reconciliation, the cursor-based replay/follow reader, and a minimal
disk-reading TUI client that consumes only public artifacts.

**Success Criteria**
- Storage layout published and stable:
  `sessions/<session_id>/events.jsonl`, `blobs/sha256/<ab>/<hex>`,
  `schemas/<event-type>.json`.
- Single writer assigns contiguous per-session sequence numbers as decimal
  strings. Sequence expresses commit order, not exact cross-file write
  chronology. `time` is never used for ordering.
- **Durability rule**: referenced blobs are written and durably published
  *before* the events referencing them are appended. The event log is flushed
  before anything is acknowledged or published over HTTP.
- Reader API: `GET /v1/sessions`, `GET /v1/sessions/{id}/events?after={seq}` with
  `follow=false` (finite NDJSON, durable high-water sequence in a response
  header) and `follow=true` (SSE), `GET /v1/blobs/sha256/{hex}`,
  `GET /v1/schemas/{type}`.
- Replay-then-follow uses **one cursor in one log position** — never a history
  query plus a separately registered live callback. No gap, no duplicate.
- SSE: `id` is the session-local sequence, `event` is `slipstream`, `Last-Event-ID`
  overrides `after`, heartbeats are SSE comments (not persisted events). A slow
  client is disconnected and resumes from its cursor; it never blocks capture.
- Error codes: `400` invalid cursor, `404` unknown session, `410` removed
  session, `409` cursor beyond durable high-water. Never silently reset a cursor.
- Loopback-only HTTP with authentication and explicit origin policy; owner-only
  storage permissions.

**Tests**
- Kill the daemon mid-capture; restart. Session identity and sequence are
  preserved, an incomplete trailing record is removed, a `session.resumed` event
  is appended at `recovered_through_seq + 1`, and a restart gap plus
  reconciliation events follow.
- Corruption in the *middle* of the log is an error, not a skipped event.
- Two independent readers (HTTP reader and direct disk reader) converge on
  identical recorded state.
- Reconnect from a stale cursor mid-stream: no gap, no duplicate.
- Disk-full: capture stops acknowledging, health state goes failing, and the gap
  is recorded once storage recovers.
- Schema-evolution guard: a client ignoring unknown event types and unknown
  object fields still renders a complete feed.

**Status**: Complete — durable write path + restart reconciliation (PR 2a)
complete. Done: frozen v1 CloudEvents envelope and JSON Schemas under `schemas/`;
single-writer contiguous decimal sequencing derived from the validated log
(BigInt, `time` never used for ordering); durable blob publication (fsync file +
containing directory) before the referencing event, log flushed before ack;
owner-only storage permissions (0700/0600); restart reconciliation preserving
session identity and seq, discarding only a torn trailing record, appending
`session.resumed` at `recovered_through_seq + 1` followed by a restart gap and
reconciliation changes; mid-log corruption a hard error; disk-full stops
acknowledging, health goes failing, and a single storage gap is recorded on
recovery. Single writer is enforced by an mtime-heartbeat session lock
(`src/lock.ts`): a live owner is refused, a crash-stale lock is reclaimed, and a
dispossessed owner detects the takeover via a per-acquisition nonce and stops
acknowledging (health `ELOCKLOST`). A strict single-writer guarantee against
*concurrent same-session daemon starts* is not achievable in pure Node — the
takeover is detected asynchronously, so an append already awaiting its fsync
cannot be un-written, and any pure-Node stale-break must briefly vacate the lock
path. That residual is closed operationally: Conductor launches one daemon per
worktree, so concurrent acquirers on one session do not occur. On-disk tests for
all three required failure paths pass. PR 2b delivered the `/v1` reader API
(finite NDJSON and SSE follow with one-cursor replay-then-follow, HTTP error
codes, and loopback bearer auth with host/origin checks), the two-reader
convergence and stale-cursor reconnect tests, the schema-evolution guard, and
the disk-reading TUI client (plus the `serve`/`view` CLI). PR #6 review fixes
add bounded replay with backpressure, failed-startup capture cleanup, validated
tombstones and runtime descriptors, correct schema error statuses, and immediate
SSE headers. All 247 deterministic tests and typecheck pass. The recovery
durable-sync gap remains tracked as separate work.

---

## Stage 3: Prove riding alongside Conductor, with tasks

**Goal**: Slipstream attaches to exactly one Conductor-launched session among several
and receives declared task boundaries from the agent — without owning launch.

**Deliverable**: Daemon IPC over an owner-only local socket, stdio forwarders for
both harnesses, explicit CLI attach/detach, the portable skill, and the single
MCP tool `slipstream_begin_task`.

**Success Criteria**
- One active capture session daemon-wide, bound to one exact harness session ID
  and one canonical worktree. Retained sessions remain readable.
- Explicit CLI attachment selects the session. Forwarders in non-selected
  sessions return `SESSION_NOT_SELECTED` and **never steal ownership**. Switching
  requires detach then attach.
- Identity binding uses verified harness session context; CWD alone is
  insufficient. Ambiguous identity **fails attachment rather than guessing**.
- Two agents writing in the selected worktree are both captured, with attribution
  marked ambiguous or unknown. Single capture scope ≠ single writer.
- `slipstream_begin_task(title)` → `{session_id, task_id, event_id, seq}`, acknowledged
  only after the event is committed. Forwarder-supplied request UUID gives
  idempotency on retry.
- Error surface: `DAEMON_UNAVAILABLE`, `SESSION_NOT_SELECTED`,
  `IDENTITY_UNRESOLVED`, `CAPTURE_NOT_READY`, `INVALID_TITLE`,
  `STORAGE_UNAVAILABLE`.
- Task boundary is the declaration event's sequence. Late declarations are
  **never silently backdated**. No declaration means an ungrouped bucket. There
  is no task-completed claim in this MVP.
- Manually started daemon; forwarders fail fast if it is unavailable. No
  competing auto-start.
- CLI documented for start, attach, status, detach, session deletion, GC.

**Tests**
- Three Conductor worktrees open; only the attached session can declare tasks;
  the other two forwarders return `SESSION_NOT_SELECTED`.
- Skill loaded from user-level config into a session Slipstream did not launch
  (both harnesses) — verifying the inheritance already confirmed for this session.
- Retried `slipstream_begin_task` with the same request UUID commits once.
- Agent never calls `slipstream_begin_task`: changes land in the ungrouped bucket and
  the feed stays correct.
- Daemon down: forwarder returns `DAEMON_UNAVAILABLE` without hanging the agent.

**Status**: Not Started

---

## Stage 4: Prove honest attribution and enrichment

**Goal**: Add the two things that must never block or corrupt capture — harness
attribution and function clips — as append-only enrichment.

**Deliverable**: Claude Code and Codex transcript adapters emitting
`change.attribution` events; async tree-sitter workers emitting `change.clips`
events.

**Success Criteria — attribution**
- Starting policy (configurable, calibrated not guaranteed): each timestamped
  harness tool-use record contributes a ±2s window matched against the change's
  observation interval. Exactly one candidate → `heuristic`; multiple →
  `ambiguous`; none after a 5s grace → `unknown`.
- Late evidence revises any result via a new `change.attribution` event. The
  highest-sequence attribution targeting a change wins; original events stay
  immutable.
- `task_hint_id` never changes. Clients may regroup on revised attribution but
  must retain original chronology.
- Evidence identity survives transcript rereads and daemon restarts.
- No status claims verified authorship. UI language is "possibly agent", never
  "attributed".

**Success Criteria — clips**
- Parsing runs in isolated workers against immutable before/after blobs, never on
  the capture path. Enrichment is debounced; the capture queue is not.
- Budgets: parse only UTF-8 ≤ 1 MiB, 100 ms wall-clock per change; clips capped
  at 300 lines and 64 KiB per side; fallback is changed ranges ± 20 lines.
- Clips are an **array** of paired spans. A deleted function exists only on the
  before side; a created one only on the after side.
- A parse error *elsewhere* in the file does not void a usable enclosing
  function. Fall back only when the relevant enclosing structure is unreliable.
- Explicit `fallback_reason` on every non-`ready` clip event.
- Under overload, enrichment is skipped with a stated reason and raw capture
  continues.

**Tests**
- Two overlapping parallel tool calls → `ambiguous`.
- Human save during an agent turn → not silently credited to the agent.
- Transcript arriving late → an initially `unknown` change gains evidence and is
  revised.
- Edits occurring before their task is declared → grouped by declaration
  sequence, not backdated.
- A change touching several functions, deleting one, and editing imports → one
  event, multiple clips, top-level fallback where appropriate.
- Half-written unparseable file mid-edit → falls back, event still published.
- Parser workers saturated → raw capture latency unchanged (measured).

**Status**: Not Started

---

## Stage 5: Build the watching UI and run acceptance

**Goal**: The three-column workspace from the canvas, consuming only public APIs,
plus the Q14 acceptance run.

**Deliverable**: React client — explorer (segmented `Changed · N` | `All files`,
Changed active by default) → change stream (sticky non-stacking task headings,
whole-function clips with gutter markers) → editor panes (Monaco diff,
Diff/Plain toggle, collapsed unchanged ranges).

**Success Criteria**
- The client consumes **only** the published reader API and schemas. It holds no
  privileged access to the daemon's internals.
- Uncertainty is visible: ambiguous and unknown attribution render as such;
  coverage gaps render as gaps.
- Change stream uses lightweight rendered diffs; Monaco is instantiated for the
  focused pane only, never per card.
- Design tokens pulled from the canvas `GetVariables()`, not re-derived.
- **Acceptance run (this is Q14's bar):** live Conductor sessions for both
  harnesses; task grouping visible; daemon killed and readers reconnected
  mid-session; measured capture latency reported; known coverage gaps documented;
  then the bundled UI is **stopped entirely** and the Stage 2 TUI reproduces the
  same session state.

**Explicitly not in this MVP**: question/answer loop, review or approval
workflow, automatic installer, launcher replacement, historical content import.

**Status**: Not Started

---

## Vocabulary — settled

**Product name: Slipstream.** Decided 2026-09-16 (working name "Differ" retired).
A slipstream is the low-pressure pocket behind a fast-moving object — riding in
it makes following dramatically cheaper than leading. That is the product thesis:
stay in the agent's wake and review as it works, instead of facing a pile of
files at the end. The metaphor also encodes the constraint honestly — the effect
falls off with distance, so you have to keep up. Binding on the public interface:
`slipstream.*` event types, `urn:slipstream:session:<id>`, `slipstream_begin_task`,
`.slipstream/` storage.

**"Task", not "story."** Decided 2026-09-16, ahead of Stage 3's schema freeze.
This is binding on the public interface: `slipstream.task.started.v1`, `task_id`,
`task_hint_id`, `slipstream_begin_task`, subject `task/<task_id>`. The canvas uses
"story" in several frame names; the UI copy follows the schema, so those read as
tasks. Changing this after Stage 3 is a breaking event-type version bump.

## Open questions deferred past MVP

1. Should an agent's answer be allowed to edit code, when Q&A arrives?
2. Automatic install/registration of the MCP server, skill, and hooks.

---

# Test-architecture refactor: the filesystem-observation boundary

Date: 2026-09-17
Status: approved to build (Brian; boundary line settled via Codex consult)

## Why

`session.test.ts` drives real FSEvents, so its results depend on the host OS.
Two tests pass only on a real developer Mac: a baseline-unreadable + post-restore
observation (fails on Linux — inotify does not re-add a watch after chmod) and an
unavailable/unreadable transition (flaky on hosted macOS — suspected FSEvents
mtime-suppression on chmod). No hosted CI runner faithfully reproduces a real Mac
for permission/timing-dependent watcher behavior.

## The decision (locked)

Introduce ONE centralized, owner-maintained boundary — `Platform` — for
**filesystem observation only** (the watcher seam, the sole truly
platform-divergent surface). Everywhere else, non-boundary tests drive a single
`FakePlatform`. Reader / enumerate / CAS / log stay **real over temp dirs** —
they are already portable and deterministic; a whole in-memory filesystem would
be a second filesystem to maintain just to test a filesystem observer.

Honesty constraint made structural: `FakePlatform` **never auto-translates a
filesystem mutation into an observation.** Tests deliver observations explicitly
(`observe(path)`), because "one notification per write" is exactly the fidelity
the real watcher cannot promise. Encoding it in the fake would make the fake more
honest than production and let CI certify a capture the OS won't deliver.

Contract discipline: shared watcher-contract assertions run against BOTH the real
`Platform` (real-fs driver) and `FakePlatform` (controlled-observation driver).
We share the *assertions*, not an assumption that their notification sequences
match. Platform-capability probes ("does real FSEvents emit on chmod?") stay
real-OS-only; fake conformance can never rescue a failing real probe.

## Stage R1: Introduce the `Platform` observation boundary
**Goal**: Extract the watcher into a documented `Platform` seam with no behavior change.
**Success Criteria**: `src/platform.ts` exports `Platform` (`watch({root, ignore, onObservation, onError}) => Promise<{close}>`) and `createPlatform()` wrapping `@parcel/watcher`; `session.ts` depends on a `Platform` in place of the `createWatcher` seam; full suite green locally against the real Platform.
**Tests**: existing `session.test.ts` unchanged, still green (proves the extraction is behavior-preserving).
**Status**: Complete. `src/platform.ts` added, `src/watcher.ts` deleted, `session.ts` depends on `Platform`; typecheck clean, 71/71 green.

## Stage R2: Centralized `FakePlatform` + contract tests
**Goal**: One reusable fake of the boundary, pinned to the real one by a shared contract.
**Success Criteria**: `src/test/fake-platform.ts` implements `Platform`, fresh per test, with controls `observe(path, atMs?)` and `failWith(err)`, and does NOT auto-observe fs mutations; a shared contract asserts subscription readiness, ignore/exclusion behavior, out-of-root filtering, and shutdown, and passes against both real (real-fs driver, `.os` tier) and fake (CI tier).
**Tests**: `src/test/platform-contract.ts` (shared assertions); `src/platform.os.test.ts` (real driver); fake driver runs in CI tier.
**Status**: Complete. `FakePlatform` + `platform-contract.ts` added; the shared contract asserts in-root delivery (readiness), ignore/exclusion (including `..name` children), out-of-root filtering, and post-close shutdown, and runs against both real (`platform.os.test.ts`) and fake (`platform.test.ts`) drivers, plus a few fake-only unit tests (exact path/timestamp resolution, `failWith`, before-`watch()` misuse). Typecheck clean.

## Stage R3: Move deterministic session tests onto the fake; quarantine OS probes
**Goal**: The CI tier is deterministic; every real-OS claim is isolated and honest.
**Success Criteria**: `session.test.ts` drives observations via `FakePlatform` (deterministic, CI-safe) for the 14 logic tests (baseline dedup, create/modify/delete, empty/binary/oversize, rapid-endpoint, `..notes` path-keep, exclusion filtering, baseline-unknown before-state, unavailable propagation); the genuinely platform-dependent probes (real chmod→observation, real FSEvents delivery/coalescing/ignore-respect/rename-to-final-path, real readdir EACCES→baseline-unreadable gap) move to `session.os.test.ts`; `waitForRecords` throws on timeout instead of returning stale records at the deadline.
**Tests**: reclassified as above; the two previously-failing tests become deterministic (fake) for their logic and honest real-OS probes for their OS claim.
**Status**: Complete. `session.test.ts` is fake-driven; `session.os.test.ts` holds the real chmod/FSEvents/rapid-write probes; `reader.test.ts` unreadable mapping moved to the `openFile` seam; `waitForRecords` throws on timeout. 75 CI-tier + 7 OS-tier green locally.

## Stage R4: Test tiering + workflow + docs
**Goal**: CI runs the deterministic tier cross-platform; the real-OS tier is opt-in/local.
**Success Criteria**: `npm test` runs the deterministic tier (`src/**/*.test.ts` excluding `*.os.test.ts`); `npm run test:os` runs `src/**/*.os.test.ts`; `.github/workflows/tests.yml` runs the deterministic tier on ubuntu AND macos (portability proof, resolves the red macos-only workaround); `TESTING.md` documents the two tiers, the fake, and the contract discipline.
**Tests**: CI green on both OSes; `test:os` green locally on the Mac.
**Status**: Complete. `package.json` scripts split the tiers via the `!(*.os)` extglob; `tests.yml` runs `npm test` on an ubuntu+macos matrix with a type-check step; `TESTING.md` documents the boundary, the fake, the contract, and the two tiers. `npm test` = 75 green, `npm run test:os` = 7 green, typecheck clean locally.
