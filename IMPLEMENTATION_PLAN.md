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
| Q2 | Question/comment loop | Additive durable ask submission approved 2026-09-25 (D1 below); Codex delivery and Claude delivery D3 merged, answer UI deferred |
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
recovery. Recovery establishes a durability barrier (fsync retained log +
containing directory) over the recovered prefix before `recovered_through_seq`
is published as durable, on the clean path as well as when truncating a torn
tail, so a recovered seq can never advertise bytes storage did not persist.
Single writer is enforced by an mtime-heartbeat session lock
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

**Status**: In Progress. Stage 3 ships as a five-PR graph (P1–P5). P1 (harness
identity probe) and P2 (durable task boundaries) are merged. P3 (shared daemon +
attach layer: control protocol/client, boundary registry, daemon singleton +
attach/detach/status/begin_task, CLI start/attach/status/detach + standalone
guard) is complete on `feature/stage3-shared-daemon-attach`. P4 (MCP forwarder,
harness identity adapters, `slipstream_begin_task` tool, portable skill + config
docs) is implemented on this branch (daemon-side identity-triple selection guard,
honest post-send retry, end-to-end forwarder tests); real-session acceptance and
the PR remain. P5 (detached-only `delete_session` + `gc`: durable-tombstone-first
deletion with retryable history cleanup, and conservative detached mark-and-sweep
blob reclamation) is implemented on this branch (`briankeane/maseru`) with the
adversarial review + excess audit applied; PR to `develop` pending.

---

## Stage 4: Prove honest attribution and enrichment

**Goal**: Add the two things that must never block or corrupt capture — harness
attribution and function clips — as append-only enrichment.

**Deliverable**: Claude Code and Codex transcript adapters emitting
`change.attribution` events; a versioned, public clip **projection** computed on
demand from the immutable before/after blobs and served through the reader API
(reader-derived, not log events — see D4 in `STAGE-4-PLAN.md`).

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

**Success Criteria — clips** (reader-derived projection, D4 — not log events)
- Clips are a **versioned public projection** over the immutable before/after
  blobs, computed on demand and served through the published reader API. Nothing
  is appended to the event log. The projection is a reusable module callable
  against on-disk artifacts, so any client — including the Stage 2 TUI — can get
  clips without the bundled UI.
- Parsing runs in isolated workers against immutable blobs, never on the capture
  path. The reader bounds how much parsing it admits concurrently so a cold-cache
  feed cannot starve capture; capture is always prioritized.
- Budgets: parse only UTF-8 ≤ 1 MiB, 100 ms wall-clock per change; clips capped
  at 300 lines and 64 KiB per side; fallback is changed ranges ± 20 lines.
- Clips are an **array** of paired spans. A deleted function exists only on the
  before side; a created one only on the after side.
- A parse error *elsewhere* in the file does not void a usable enclosing
  function. Fall back only when the relevant enclosing structure is unreliable.
- Explicit `fallback_reason` on every non-`ready` projection result; the result
  carries its `projection_version`. A change whose blobs were GC'd yields clips
  explicitly unavailable with a reason, never faked.
- Under overload, the projection is skipped/deferred with a stated reason and raw
  capture continues.

**Tests**
- Two overlapping parallel tool calls → `ambiguous`.
- Human save during an agent turn → not silently credited to the agent.
- Transcript arriving late → an initially `unknown` change gains evidence and is
  revised.
- Edits occurring before their task is declared → grouped by declaration
  sequence, not backdated.
- A change touching several functions, deleting one, and editing imports → one
  projection result, multiple clips, top-level fallback where appropriate.
- Half-written unparseable file mid-edit → falls back, projection still returned.
- Concurrent cold-cache clip requests saturating the parse workers → raw capture
  latency within the ratified bar (measured; D3 protocol, D4 cold-cache load).

**Status**: Complete — all four PRs merged to `develop` (#18 A1, #19 B1, #20 B2,
#21 A2). PR graph designed via Codex consults and ratified
(Brian D1–D4, 2026-09-19): a 4-PR / 2-track shape — Track A attribution
(A1 engine+contracts with fake evidence → A2 real transcript adapters), Track B.
**A1 built** on `feature/stage4-a1-attribution`: three event contracts
(`harness.evidence`, `change.attribution`, `enrichment.configured`), the pure
I/O-free reducer, `change_seq`-targeted attribution with ±window/grace matching,
observed intervals on `file.changed`, durable evidence ingestion with
log-derived dedup and disclosed conflicts, revision-by-append on semantic
change, and restart recovery that reconstructs outstanding work behind a
generation-fenced replay barrier (no double-attribution). The Stage-3 inline
`attribution:{status:'unknown'}` seed is removed — no-result-yet is now PENDING,
disclosed as a separate revisable event. Acceptance tests pass against FAKE
evidence; real transcript adapters are A2. Track B
clips (B1 clip-projection contract + bounded fallback → B2 tree-sitter extraction
+ measured latency gate). **B1 built** on
`briankeane/clip-projection-contract`: the pure work-capped core
(`projectClips` over before/after bytes), the I/O-scoped reusable module
(`computeClipProjection`, the direct-disk/TUI path), a worker-thread wrapper and
pool, the on-demand service (bounded admission + queue, content-addressed
disposable LRU, in-flight coalescing, revalidate-on-hit, 100 ms wall-clock
deadline that cancels and replaces a stuck worker), the reader endpoint
`GET /v1/sessions/:id/changes/:seq/clips`, and the published contract
`schemas/projections/clip.v1.json` served at `/v1/schemas/projections/:version`.
No log event, no persistence: clips are viewable exactly while the blobs are
retained, and GC'd blobs yield an explicit `unavailable` projection with a
reason. Byte/line rules and status/reason semantics are documented in
`CLIP-PROJECTION.md`. **B2 complete; PR #20 merged**: `clip.v3` provides WASM
function extraction for JS/JSX/TS/TSX, paired spans, explicit mixed fallback and
the approved closed language input/cache key. The native worker-cancellation
crash was reproduced and replaced with WASM under the original design/budgets.
Review/challenge/Excess findings and re-reviews are resolved. The final-runtime
full run (`81fa5a3`) captured 1,200/1,200 writes without crashing, and all three
saturation arms passed the load checks. Baseline overall p99 was 1,240–1,399 ms;
saturation was 1,128–1,166 ms on the shared host. Brian ratified the 20% latency /
5% throughput regression allowance on 2026-09-19, with zero missing writes and
all load checks required. **D3 passes**: all 18 latency and three throughput
comparisons satisfy the bar.
Ubuntu CI exposed cold-worker startup timing in result-shape tests; after three
failures and outside reassessment, those tests now hold their deadline clock
while retaining real disk/worker/HTTP assertions. Real-clock deadline and load
checks remain; production budgets and capture design are unchanged. Typecheck,
648 main tests and 86 tool tests pass locally; Ubuntu and macOS CI are green at
`7ea847f` and the subsequent documentation revision `33f111d`.
See `B2-MEASUREMENT-REPORT.md` for all numbers, host conditions and history.
Stage 4 as a whole is complete; the remaining watching UI + combined
attribution-plus-clips acceptance run are Stage 5. D4 makes clips a
**reader-derived public projection**
over the immutable blobs (versioned, cached on demand, served via the reader API)
rather than `change.clips` log events; attribution stays a log producer. See
`STAGE-4-PLAN.md` for the D4 rationale, resolved schema forks, the D2
candidate-eligibility narrowing, and the D3 latency ruling (retained under
D4 — parsing contention relocates to the reader).

### A2 — Real Claude Code + Codex transcript adapters (complete)

**Goal**: replace A1's fake evidence with real transcript reads that produce
`slipstream.harness.evidence.v1`, plus honest coverage disclosure and the Fork 4
config surface. A2 does **not** change A1 inference semantics.

Design locked via Codex consult (`gpt-6-astra`, 2026-09-19; see
`.context/a2-consult.md`). Key decisions:

- **Q1 coverage (refinement of the A1 sketch — flagged for review).** The A1
  plan sketched a per-source `evidence_availability` field on
  `change.attribution.v1`; it was never implemented. A2 replaces it with a
  **separate durable event `slipstream.enrichment.coverage.v1`** and keeps the
  policy's `SourceCoverage` as declared config only (`'unconfigured' |
  'configured'`). Rationale: the evaluator never reads `policy.sources`, and
  Fork 4 binds policy prospectively by `policy_seq`, so putting *runtime* health
  in the policy would freeze stale health onto old changes. Coverage health is
  retrospective; it must fold highest-seq-wins, independent of policy. The
  coverage event carries `harness`, `state` (`pending | readable | degraded |
  unavailable`), and an `issues[]` list (`missing | inaccessible | malformed |
  unsupported | discovery-limited`). `readable` = the declared scan scope was
  processed, never "complete edit history". Absent coverage = unknown, never
  successful reading. This satisfies the A2 criterion "failures distinguishable
  from read-with-no-match; unknown ≠ human" more robustly than a policy field.
- **Q2 discovery.** Multiple harness sessions per worktree are legitimate
  candidates. Discover by configurable transcript roots + canonicalized
  `session_meta.cwd`/validated Claude slug as a *discovery filter, not authorship
  evidence*; mtime is **not** an eligibility boundary. Bounded scans disclose
  `discovery-limited` rather than pretend completeness.
- **Q3 tool taxonomy.** Read-only tools (Read/Grep/Glob/LS) emit nothing; known
  writes emit `paths`; Bash/plain shell/unrecognized tools emit
  `file_scope={kind:'unknown'}`; missing stable invocation id → unsupported,
  never a fabricated key. Only a fixture-proven `apply_patch` envelope is parsed
  for paths — arbitrary shell text with patch markers stays unknown-scope.
- **Q4 incremental read.** In-memory per-file cursor (`dev/ino`, byte offset);
  durable dedup (evidence_key + variant signature) is the only idempotence
  mechanism — no second persisted cursor. Advance the processed offset only after
  each record is durably appended or reported duplicate; honor the ingestor's
  retryable queue-full rejection. Inode change / size shrink → reread from 0.
- **Q5 adapter core.** Pure `step(state, record, ctx) => { state, evidence[],
  diagnostics }` (Claude records hold multiple tool calls; results join the prior
  call's metadata). Start evidence emitted immediately; a matched result emits an
  end record under the **same** key/tool/scope (never a provisional unknown-scope
  end later "corrected" — that is a same-basis conflict in the fold). Filesystem
  canonicalization stays in the I/O layer; the core relativizes paths against the
  already-canonical root exactly like the capture path (`relative(root, abs)`).

**Success Criteria** (from the brief / STAGE-4-PLAN A2):
- Both adapters produce `harness.evidence.v1` with fixture-proven native
  `record_id` + `file_scope` mappings (sanitized fixtures committed as `.json` /
  `.ts`, never `*.jsonl`).
- Incremental reads, partial records, rotation/reread idempotence.
- Public config surface (Fork 4 file + CLI overrides).
- Coverage disclosure distinguishes missing/malformed/inaccessible/unsupported
  from read-with-no-match; `unknown` ≠ `human`.

**Tests**: (a) edits before their task is declared → grouped by declaration
sequence, not backdated; (b) late transcript arriving after restart → revises
without duplicate evidence; (c) native-identity fixtures prove the `record_id` +
file-scope mapping for BOTH harnesses.

**Status**: Complete. Codex adversarial review PASSED (gate #18).
- Adapters, discovery, incremental file reader, coverage watcher/runner, config
  surface (file + CLI overrides), and session/daemon/CLI wiring landed.
- All three required tests present: (a) `session.test.ts` append-order grouping;
  (b) `transcript/restart-idempotence.test.ts` (fresh watcher rereads from
  offset 0, ingestor log-derived dedup absorbs the replayed prefix, only the
  late record appends); (c) `transcript/claude.test.ts` + `codex.test.ts`
  native-identity fixtures. `npm run typecheck` + `npm test` (678) green.
- Review hardening: a transcript reader is pinned to the (dev, ino) generation
  discovery confirmed and refuses a same-path replacement (`unconfirmed`) rather
  than crediting a foreign session's writes; identity and evidence bytes come from
  one open handle (no stat→read TOCTOU); generation ids are 64-bit bigints (no
  Number precision collapse); a bare `null` head line can no longer abort a
  discovery tick.
- PR #21 review fixes: an unconfirmed replacement degrades a readable sibling
  without inventing an issue (alone it stays pending); transcript reads drain in
  1 MiB chunks within a poll, expanding the window for an over-chunk line.
  Typecheck, all 114 transcript tests, and all 680 full-suite tests pass.
- **Resolved (Brian, 2026-09-19) — append-only assumption confirmed.** Same-inode
  truncate-and-regrow detection stays as shipped: Claude Code and Codex both write
  append-only JSONL (grow, or atomic-replace → new inode caught by generation
  pinning; in-place shrink caught by the size check). The one uncaught case — an
  in-place shrink then regrow to at-or-above the last observed size within a poll
  interval — does not occur for either supported harness, so the P2 regrow-skip is
  a won't-fix, not a defect. The assumption is now documented at the shrink-detection
  site in `src/transcript/file-reader.ts`; a non-append-only source is out of scope.
- **Resolved (Brian, 2026-09-19) — coverage event shape confirmed intended.** The
  coverage event is a *separate* durable `slipstream.enrichment.coverage.v1`
  (Q1 above), replacing A1's unimplemented `evidence_availability` sketch. Shape
  reviewed and accepted: `{session_id, harness, state, issues?}` with
  `state ∈ {pending, readable, degraded, unavailable}` and typed `issues`, folded
  highest-seq-wins per harness, absence = health-unknown. Honesty-consistent
  (`readable` is explicitly not a claim of complete history; a readable sibling
  never conceals an unreadable one). Stage-5 forward note: the event discloses
  health but not the scanned scope size, so a UI cannot show "scanned N transcripts"
  from this shape alone — revisit only if Stage 5 needs it.
- **Deferred hardening (tracked) — inode-reuse residual.** Full robustness against
  an OS reusing a `(dev, ino)` between polls for a different file at the same path
  needs a long-lived fd per reader (distinct from the shipped bigint-precision
  generation fix). Narrow window; accepted for Stage 4, revisit if it ever surfaces.
- **Known benign tradeoff:** the watcher's `lastKey` is in-memory, so the first
  tick after a restart may republish identical coverage. Harmless — coverage
  folds highest-seq-wins and the fold is idempotent.

---

## Stage 5 pivot (Brian, 2026-09-20)

The prior Stage 5 (a **React/browser** three-column client + Monaco) is
**CANCELLED**. Two directives replace it:

1. The Stage 5 watching UI must be a **native application** — not browser, not
   Electron, not a web view.
2. **First** build a pre-Stage-5 **terminal proving ground** ("Stage T"): a rich
   TUI (live feed + live function-interface-change list + focused diff) consuming
   **only** the public reader API and reusing the pure fold, so the fold + API are
   proven before any native-GUI investment. Stage T is also a first-class client
   the "delete the front-end and reproduce it" invariant already requires.

Design driven by a Codex `gpt-6-astra` architecture consult (2026-09-20; capture
in `.context/terminal-stage-proposal.md`). Language/framework research +
adversarial consult captured in `.context/native-language-decision-brief.md` —
**the native language is NOT locked; it awaits Brian's sign-off.**

### Cross-cutting facts settled by the consult
- A watching client **displays committed attribution**, it does not produce it.
  Reuse `foldAttributions` (highest-seq valid *published* attribution per
  `(source, change_seq)`) and `foldEvidence` for evidence display; a client that
  is missing a published result renders `pending`. It must **not** run its own
  clock or `evaluateChange` — recomputing inference could disagree with the
  durable record (honesty violation).
- The **runtime descriptor** (loopback URL + bearer token) is a public
  *connection bootstrap*, not privileged session data. The "consume only the
  public API" rule holds **with this one explicit bootstrap exception**; a client
  must never silently fall back to reading session state off disk.
- A colocated native client holds the token and hits loopback directly — the
  browser-era forwarding proxy is **moot for a colocated topology** (keep auth +
  host/origin checks; token in the OS secret store; 127.0.0.1 only). A *remote*
  daemon is a separate, undecided transport scope.
- `change-view.ts` renders **marked after-content, not a two-sided diff**, and
  does not consume clips. The focused diff view is **new** rendering over the clip
  projection + blobs, not a reuse-wiring task.
- Public event timestamps do **not** expose durable-commit latency
  (`CLIP-LATENCY-PROTOCOL.md` forbids using them as a proxy). Acceptance latency
  must come from instrumented measurement, not `receipt − event_time`. A live
  capture-latency meter would need a separately defined public telemetry source.

---

## Stage T: Terminal proving ground (pre-Stage-5)

**Goal**: A rich TUI over the public reader API — a live event/change feed, a
live-updating function-interface-change list, and a focused two-sided diff —
proving the fold + API before native-GUI work, and standing as an independent
client. TypeScript on Node 24 (no stack exception needed).

**Deliverable & dependency-ordered PR graph** (each PR is a boundary that may hold
several small passing TDD commits; ordering + splits per the Codex consult):

- **T0 — Contracts & amendments (gate).** Ratify: the function-interface-change
  semantics (a decision for Brian, below), the public *bootstrap exception*
  wording, and the canonical **parity definition** (a named session-state at a
  `(session, seq)` prefix, with hand-specified expected states — two clients
  calling the same fold are **not** an independent oracle).
- **T1a — Public read client (finite).** Typed decoding of the public CloudEvent
  envelope (preserve `source`/full envelope, not just `{type,seq,data}`),
  `GET /v1/sessions` + high-water, finite NDJSON replay (`after=`), and error
  mapping (`409` exposes the advertised durable high-water + an explicit recovery
  choice — never a silent reset; `410` = removed, stop). Depends on T0.
- **T1b — Public read client (follow).** SSE follow with an **applied-event**
  cursor (advance only after the model applies an event, not on receipt/render;
  unknown event types still advance; malformed events / sequence discontinuities
  are surfaced, never dropped), cancellation, backpressure (event consumption
  independent of blob/diff work — no unbounded queue), reconnect with **descriptor
  refresh** (a daemon restart mints a new token + ephemeral port — rediscovery
  must refresh credentials for *all* clients incl. blob/projection). Depends T1a.
- **T2a — Pure session-state fold.** Baseline, observed changes, immutable task
  hints/grouping, gaps, sequence identity. Pure reducer; expected-state fixtures.
  Depends T0.
- **T2b — Attribution + coverage display.** Fold **published** attribution
  revisions via `foldAttributions` (preserve reason, policy reference, evidence
  references, excluded conflicts — not just `{status,reason}`); coverage per
  harness (absent = health-unknown; `readable` ≠ complete); evidence disclosure
  via `foldEvidence`. Measure re-fold cost; do not refold the whole session per
  event unboundedly. Depends T2a.
- **T3a — TUI shell.** Terminal lifecycle, session picker, navigation, a *visible*
  connection state (a disconnect is a reader interruption, **not** a capture gap).
  Depends T1b, T2b.
- **T3b — Live feed.** Task grouping (declarations + immutable `task_hint_id`, not
  authorship/completion; baselines are not edits); all honesty states rendered
  distinctly (`pending`, "possibly agent" = heuristic, `ambiguous`, `unknown` ≠
  human; revisions update the original change in place without changing chronology;
  gaps preserve reason + scope). Sanitize paths/titles/reasons for the terminal.
  Depends T3a.
- **T4a — Blob/clip access.** HTTP blob + clip-projection client, projection
  version handling, a bounded demand queue (coordinate admission with the reader's
  clip pool — do not double contention), cancellation, transient retry. Depends
  T1a.
- **T4b — Focused two-sided diff.** New rendering over paired clips: both sides,
  original line offsets, deletion + null-span + `unavailable` + binary + display-
  limit distinguished; preserve `fallback_reason`, per-side `method`/`reason`,
  `truncated` (`ready` ≠ untruncated); slice raw bytes before decode; collapsed
  unchanged context labeled differently from missing capture history; clip-pair
  adjacency must not imply semantic function identity. Depends T3a, T4a.
- **T5a — Interface-change contract + core.** Versioned contract and pure
  extraction/matching, starting from adversarial fixtures. **Gated on Brian's
  semantics decision.** (See "Decisions for Brian".)
- **T5b — Interface projection surface.** If route (a): the public endpoint +
  schema, bounded worker execution, disposable caching + retention behavior,
  reproducible from immutable before/after inputs (not merely the bounded clip
  array — that can omit functions). A reader projection is **not** a second
  capture source and emits no log events. Depends T5a.
- **T5c — Interface-change list view.** Live list distinguishing "no changes
  found" from pending/unsupported/incomplete/timed-out/overloaded/unavailable
  (partial extraction can't justify an exhaustive zero; a failed parse is not a
  removal; an unavailable before-side is not an addition); every row links to its
  originating change and inherits that change's revisable attribution + gap
  context. Depends T3b, T4a, T5b.
- **T6a — Combined-load + parity rehearsal.** Restart/reconnect + both projection
  workloads under load; compare clients through the same `(session, seq)` prefix
  against hand-specified expected states, controlling projection version + blob
  retention + transient failures separately.
- **T6b — Report.** Instrumented acceptance report; update Status only against
  gates actually satisfied.

**Honesty is not deferrable to a later pass** — every view above ships its honesty
contract when it ships.

**Status**: In Progress. T-QA (live QA harness) merged (#25). T0.1 (`display-fold.v1` contract + oracle, `DISPLAY-FOLD.md`) is in review. T0.2 onward is Not Started.

---

## Stage 5: Build the **native** watching UI and run acceptance

**Goal**: The native watching workspace, consuming **only** the public reader API
(plus the bootstrap-descriptor exception), building on Stage T, plus the Q14
acceptance run.

**Deliverable** (native, language TBD — pending Brian, see decision brief). A
dependency-ordered, **language-agnostic** graph that mirrors Stage T:
- **S5.0 (gate).** Brian locks: language/framework; an explicit client-scoped
  exception to "TypeScript throughout" if the language is not TS; and the
  fold-reproduction strategy (embed a JS engine / Node sidecar / reimplement the
  *small display fold*) — all gated on cross-language conformance fixtures over
  published events + a versioned fold contract + an applied-through-seq boundary.
- **S5.1** app skeleton **split from** transport/reconnect parity (both reuse
  Stage T's language-neutral fixtures).
- **S5.2** session-state parity against the shared expected-state fixtures.
- **S5.3** native live feed — uncertainty, coverage and gap rendering complete on
  arrival.
- **S5.4** native focused diff renderer (the "Monaco-diff equivalent" — a native
  replacement whose exact bar Brian must approve; preserve the underlying
  requirement: lightweight feed rendering + one expensive focused renderer).
- **S5.5** native interface-change list (independent of S5.4 once the shared
  selection/state contracts exist).
- **S5.6** an honesty/uncertainty **audit**, not the first honesty implementation.
- **S5.7** the Q14 acceptance run (below).

**Success Criteria** (substance preserved from the cancelled Stage 5; changes the
pivot forces are marked ⚠ **pending Brian's ratification** — not enacted here):
- The client consumes **only** the published reader API + schemas (plus the
  bootstrap descriptor); no privileged access to daemon internals.
- Uncertainty is visible: `ambiguous`/`unknown` render as such; coverage gaps
  render as gaps; `unknown` ≠ human; a stale view must disclose it is behind.
- Feed uses lightweight rendered diffs; the expensive focused renderer is
  instantiated for the focused pane only, never per card.
- **Acceptance run (Q14's bar):** live Conductor sessions for both harnesses; task
  grouping visible; daemon killed and readers reconnected mid-session; measured
  capture latency reported (instrumented, not inferred from event timestamps);
  known coverage gaps documented; then the bundled native UI is **stopped
  entirely** and an independent client reproduces the same session state.
- ⚠ **Reproduction client:** the cancelled criterion named "the Stage 2 TUI".
  Substituting Stage T's rich TUI is a criterion **amendment** for Brian.
- ⚠ **Native replacement for "Monaco diff" / "Diff/Plain toggle" / "collapsed
  unchanged ranges"** — needs a Brian-approved native bar.
- ⚠ **Carried-over browser deliverables not yet reassigned:** the
  `Changed · N | All files` explorer (where "All files" = the captured inventory
  with disclosed exclusions/unknown scopes, **never** new worktree filesystem
  access), the three-column interaction, sticky non-stacking headings,
  whole-function stream cards, and design tokens (the canvas `GetVariables()`
  source no longer applies to a native UI). Each needs a PR or an explicit scope
  amendment.

**Prerequisite gap (flag):** Q14 requires live real-harness sessions, but **Stage
3 is still In Progress** (P4 real-session acceptance + PR and P5's PR to `develop`
remain). Stage T / Stage 5 must not silently discharge those.

**Explicitly not in this MVP**: answer display and reply transport, review or approval
workflow, automatic installer, launcher replacement, historical content import.
The additive ask/send re-scope approved by Brian on 2026-09-25 starts with D1
durable question submission below; queue acceptance does not promise delivery.

**Status**: Not Started (reshaped; gated on S5.0 + the ⚠ ratifications).

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


## D1: Durable question submission (2026-09-25)

**Status**: Merged into `develop` through PRs #33 and #34 at
`1434899ad21e8f471da65fbe034c9a25ffc18b4b`. The D1 worker reported its
required checks green; D2 is a separate Codex delivery slice.

Brian approved the additive ask/send slice. D1 queues a normalized question tied
to an immutable captured file-change snapshot through the existing owner-only
control socket. Its public queued event is readable through the GET-only reader.
Same-ID retries coalesce and replay the original durable result, including after
in-process storage recovery. Capacity is 16 unexpired questions; TTL is 30 minutes.

Contract and scope: [docs/ask-agent/contract.md](docs/ask-agent/contract.md) and
[docs/ask-agent/spec.md](docs/ask-agent/spec.md). Queue acceptance acknowledges
only durability. Hook delivery (D2), the Swift ask composer (S1), and answer UI
were separate slices. The frozen display-fold.v1 dependencies and fixtures stay unchanged:
`src/public-events.ts` adds the new event alongside the released event catalogue.
No capture, attribution, or existing success criterion changes.

## D2: Codex hook delivery (2026-09-25)

**Status**: Merged into `develop`. D2 Codex delivery and S1 Swift sending are
available to the D3 branch. No four-path milestone is claimed.

Codex root identity is bound explicitly at attach. A PostToolUse claim must match
the harness session, canonical worktree and bound root transcript, with both
agent properties omitted. One oldest eligible question is reserved and a public
dispatch-attempt event is durably appended before the hook response. The event
does not prove receipt or an answer. Contract: [docs/ask-agent/contract.md](docs/ask-agent/contract.md).

## D3: Claude Code hook delivery (2026-09-25)

**Status**: Merged into `develop` (PR #36). Terminal Claude Code
`2.1.283` delivery passed on an explicitly attached root: a child callback
stayed silent, the selected root received the question once and continued,
another root could not claim a second queued question, and `/clear` created a
new session whose root could not claim the old queue. Conductor app Claude Code
`2.1.280` passed a child-barrier delivery: the child callback stayed silent,
the selected root received the question once, the public log recorded one
attempt, and its answer included the question ID and recorded nonce before
continuing. A 24,542-byte eligible context also reached the app without
truncation; the full selected source and final end marker appeared in the host
hook record. In a separate Conductor app run against a different selected root,
two unrelated app-root callbacks produced zero emissions and zero public
attempts. Earlier direct-binary probes on both runtimes emitted a 32,700-byte
context with the final marker present.

A post-merge follow-up fixes two defects found by independent checks. Attach now
returns retryable `not-yet` when a record inside the bounded head is still being
written after a valid identity record; previously it could succeed before the
next record was complete. The shared Codex/Claude hook formatter no longer
truncates selected source: when JSON escaping would push a long path past
32 KiB, the path moves to a delimited raw block and the source stays verbatim.
The overflow cases are synthetic protocol-boundary fixtures; no captured macOS
path has been shown to reach them.

D3 adds bounded Claude root transcript verification at attach and a Claude
Code `PostToolUse` command using the D2 claim/attempt contract. Supported
observed identities are Terminal `2.1.283`/`sdk-cli` and Conductor
`2.1.280`/`sdk-ts`; ambiguous or unsupported identity fails closed. No new
capture source, Swift UI, launcher, hook installer or automatic hook trust is
added. Contract: [docs/ask-agent/contract.md](docs/ask-agent/contract.md).
