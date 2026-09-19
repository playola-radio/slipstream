# Stage 4 plan — honest attribution and enrichment

Read `IMPLEMENTATION_PLAN.md` Stage 4 first. This file is the ratified PR graph
and the resolved schema forks for Stage 4, produced by a Codex design consult
(`gpt-6-astra`, 2026-09-19) and ratified by Brian's rulings D1–D3 below. It does
not restate or relax any Stage 4 success criterion — where a criterion is
narrowed (D2) or its gate is deferred (D3), that is an explicit ratified ruling.

## Ratified rulings (Brian, 2026-09-19)

- **D1 = B — keep the 4-PR / 2-track shape** (rejected Codex's 6-PR P0+G graph).
  Accepted tradeoff: without a shared foundation PR (P0), the wire contracts and
  the recovery-safety machinery (schedule-only-from-durable-commits, discard +
  reconstruct outstanding work on recovery, fence worker replies by recovery
  generation, revalidate target before append) are **published and tested inside
  A1 for attribution and inside B1 for clips**, not once up front. The two tracks
  still share one fsync'd serialized writer and the recovery path, so they are
  *not* fully independent — see "Accepted tradeoff" below.
- **D2 = A — ratify the candidate-eligibility narrowing.** A candidate is a
  *distinct, relevant* harness invocation whose declared file/worktree scope
  matches the changed path AND whose time window overlaps the change's
  observation interval. This narrows the literal "every timestamped tool-use
  record"; the narrowing is required for the honesty constraint (unrelated reads
  must not associate with a change) and for the two required tests to be
  meaningful.
- **D3 = A — define the measurement protocol now, ratify the numeric bar later.**
  The capture-latency regression gate has no number in the spec and "unchanged"
  is impossible under a shared writer. B2 defines and runs the protocol (p50/p99
  capture latency baseline-vs-saturation, throughput, skipped counts) and the
  numeric pass-bar is ratified from the measured baseline at B2 review time — not
  invented now, never declared passing with a failing gate.

## Accepted tradeoff (D1=B, logged)

Skipping P0 is a Completeness-6 architecture call. Upgrade trigger: **if A1 and
B1 end up duplicating the recovery-generation / worker-fencing logic, or the
shared-writer contention shows up as measured capture regression in B2, extract
a shared enrichment-foundation module then** (retrofit, not up front). Until
then each track owns its own copy. This is recorded so a later reviewer does not
read the duplication as accidental.

## The two tracks

Both branch off `develop`. Track A (attribution) and Track B (clips) touch
largely disjoint code and may proceed in parallel; within a track A1→A2 and
B1→B2 are sequential. Neither track blocks capture — every append is asynchronous
enrichment; a failed parse or attribution degrades the view, never drops or
delays a `file.changed` event.

### Track A — attribution

**A1 — Infer possible tool calls from recorded evidence (fake evidence).**
Scope IN:
- New events (contracts published here, since there is no P0):
  - `slipstream.harness.evidence.v1` — durable normalized evidence, never a
    filesystem change. Data (minus injected `session_id`):
    ```ts
    { evidence_key: { harness: 'claude-code'|'codex', harness_session_id, record_id },
      adapter_version, tool_name,
      timestamp: { at_ms, basis: 'tool-start'|'tool-end'|'record-time' },
      file_scope: {kind:'paths'; paths: string[]} | {kind:'unknown'; reason} }
    ```
    `record_id` identifies the *logical invocation* (native invocation id,
    namespaced by harness session), never a transcript line / inode / offset /
    generated UUID. Start/result representations of one invocation are joined
    before they count as candidates. (The exact native fields are proven in A2 —
    A1 works against fixtures.)
  - `slipstream.change.attribution.v1` — full replacement result targeting a
    change:
    ```ts
    { change_seq, policy_seq, status: 'heuristic'|'ambiguous'|'unknown',
      evidence_seqs: string[], reason, evidence_availability /* per-source */ }
    ```
  - `slipstream.enrichment.configured.v1` — resolved effective policy (see
    Fork 4). Each result references it via `policy_seq`.
- **Fork 1 target reference:** `change_seq` names the `file.changed.v1` in this
  event's own `source`; identity is `(source, change_seq)`. Validate: target
  exists, is `file.changed.v1`, precedes numerically; forbid cross-session refs;
  compare as **BigInt**. No `change_id`, no `supersedes_seq`.
- **Observation interval** (minimal capture-path addition, flagged): add
  `observed_interval_ms: { start_ms, end_ms }` to `file.changed.v1`; `start_ms`
  == existing `observed_at_ms` (occurrence instant, meaning preserved); `end_ms`
  is snapshot-acquisition completion. The engine already holds both. Documented
  as "the observation *operation's* interval, not a proven interval containing
  every write." Reconciliation/legacy changes carry an explicit
  unavailable-interval disposition, never a fabricated narrow interval.
- **Matching policy (D2-narrowed):** each eligible candidate contributes a ±2s
  window; inclusive-overlap against the change's observation interval; grace
  timer starts at interval end (5s), never reset on reread/restart. Exactly one
  eligible candidate → `heuristic`; multiple → `ambiguous`; none after grace →
  `unknown`. "Candidate" = invocation, not agent: two overlapping calls by the
  same agent are two candidates → `ambiguous`. Multiple records of one call =
  one candidate.
- **Shared pure reducer (Fork 3):** I/O-free public module folding the log to
  `(source, change_seq) → highest-seq attribution`. Same replacement convention
  reused by clips in B1.
- Durable evidence ingestion, log-derived dedup (evidence-key→record,
  change→latest attribution), revision-by-append (compare *semantic* result —
  status, evidence set, reason, policy, availability — before publishing a
  revision; never compare evaluation time), restart recovery (schedule only from
  durably-committed changes; discard + reconstruct outstanding work; fence stale
  replies), bounded scheduling. Persist evidence **before** dependent attribution
  (replay completes a crash gap; also handles evidence that arrived before its
  change).
- **Remove the Stage-3 inline `attribution: { status:'unknown' }` seed** on newly
  produced changes: no result yet means *pending processing*, not `unknown`.
  Retain a documented legacy reading for existing logs.

Scope OUT: real transcript adapters (A2); tree-sitter/clips (Track B).

Tests: two overlapping parallel tool calls → `ambiguous`; human save inside a
matching agent window → not *silently* credited (visible uncertainty is the
honest outcome; do not pass with an easy out-of-window fixture); late evidence →
an initially-`unknown`/`pending` change gains evidence and is revised (original
event immutable); reread of unchanged evidence appends nothing; conflicting
normalized content for the same native key → disclosed conflict, never silent
overwrite; restart discards + reconstructs, no double-attribution.

**A2 — Read Claude Code and Codex transcripts (real evidence).**
Scope IN: both adapters producing `harness.evidence.v1`, with **fixture-proven
native record_id / file-scope mappings** for each transcript format (sanitized
fixtures committed; if a format lacks stable per-invocation identity, report the
evidence unsupported — do not improvise a key); incremental reads, partial
records, rotation/reread idempotence; public configuration surface (Fork 4 file
+ CLI); evidence-coverage disclosure — "unknown" = no supported candidate under
*recorded* coverage, never "human"; missing/malformed/inaccessible/unsupported
transcripts are distinguishable from successfully-read-with-no-match.
Scope OUT: changing A1's inference semantics to accommodate an adapter's limits.

Tests: edits before their task is declared → grouped by declaration sequence,
not backdated (unchanged from Stage 3 `task_hint_id` semantics); late transcript
arriving after restart → revises without duplicate evidence; native-identity
fixtures prove the mapping for both harnesses.

### Track B — clips

**B1 — Publish bounded fallback clips asynchronously (no tree-sitter yet).**
Scope IN:
- `slipstream.change.clips.v1` contract (published here):
  ```ts
  { change_seq, policy_seq,
    status: 'ready'|'fallback'|'skipped'|'unavailable',
    fallback_reason?, // required unless 'ready'
    clips: Array<{ before: Span|null, after: Span|null /* +per-side method+reason */ }> }
  ```
  Spans reference the target's existing blobs by **zero-based half-open byte
  offsets** (define UTF-8 boundary + line-count rules). `null` = no corresponding
  span (created/deleted function), never unreadable content.
- Worker lifecycle (`worker_threads`), immutable before/after blob reads off the
  capture path, debounced dispatch (the capture queue is never debounced),
  crash recovery (resume unfinished jobs from the log; every committed change
  gets its own result or an explicit `skipped`), and the same reducer/replacement
  convention as attribution.
- **Budgets + overload here (Codex correction — an unbounded worker is not a
  viable intermediate):** parse only UTF-8 ≤ 1 MiB, 100 ms wall-clock/change;
  bounded diff/fallback prep *before* any parse so a timeout keeps the fallback;
  clips capped 300 lines & 64 KiB **across the whole array per side** (a
  multi-span array must not circumvent the cap); fallback = changed ranges ±20
  lines; if even bounded ranges can't be produced → `skipped` with reason, never
  invented ranges. Under overload, enrichment is skipped with a stated reason and
  raw capture continues. Bound admission; prioritize capture; dispatch at most
  bounded enrichment work to the shared writer.
- **Changed-ranges gap:** the change schema carries snapshots, not ranges. B1
  computes bounded ranges off-path for the fallback; it does not add ranges to
  `file.changed.v1`.

Scope OUT: tree-sitter function extraction (B2).

Tests: half-written unparseable file mid-edit → falls back, event still
published; worker crash → job resumes from log; oversize/binary → `skipped`/
`unavailable` with reason.

**B2 — Extract paired function clips + measured latency gate.**
Scope IN: tree-sitter integration for an explicit language set (recommend
JS/JSX/TS/TSX; fall back for unsupported); a parse error *elsewhere* in the file
does not void a usable enclosing function (mixed event → `fallback` with
per-hunk + event-level reasons); created/deleted/multiple-function cases +
edited imports → one event, multiple clips, top-level fallback where appropriate;
deterministic pairing by diff correspondence (no semantic function-identity or
move-detection promise) and explicit truncation; **D3 measurement protocol** —
p50/p99 capture latency baseline-vs-saturation, throughput, skipped counts under
a predefined protocol, with the numeric pass-bar ratified from the measured
baseline at review time.
Scope OUT: UI (Stage 5); full both-tracks-on combined acceptance (Stage 5 Q14
run). B2 measures clip-worker saturation against capture; combined attribution+
clips acceptance is Stage 5.

Tests: a change touching several functions, deleting one, editing imports → one
event, multiple clips, top-level fallback where appropriate; parser workers
saturated → raw capture latency within the ratified bar (measured).

## Fork resolutions (adopted as recommended; not separately ruled)

- **Fork 1 — targeting:** `change_seq` + `(source, change_seq)` identity, BigInt
  compare, no `change_id`/`supersedes_seq`. A retained change's seq never moves;
  a discarded partial seq *can* be reused → the recovery discipline above.
- **Fork 2 — evidence identity:** `slipstream.harness.evidence.v1` + native
  `record_id`; dedup derived from the log; persist evidence before attribution.
- **Fork 3 — reducer:** one shared I/O-free public reducer; daemon uses it to
  schedule + suppress dupes; HTTP reader keeps serving the raw stream (no hidden
  projection); clients fold enrichment but keep the change's original seq +
  `task_hint_id`; independent implementations reproduce the documented fold.
- **Fork 4 — config:** daemon config file + CLI overrides; effective policy
  recorded in `slipstream.enrichment.configured.v1`; results reference it via
  `policy_seq`; **prospective by sequence** (later changes use the new policy;
  late evidence rescopes an old change under *that change's original* policy;
  reread/restart never silently rescores history). Clip ceilings (1 MiB / 100 ms
  / 300 lines / 64 KiB) may only be set **stricter** — raising them is a product
  decision, out of scope.

## Open items to ratify later (not now)

- Native `record_id` / file-scope field mappings for both transcript formats —
  proven with fixtures in **A2**, not guessed now.
- The numeric capture-latency pass-bar — set from the measured baseline in **B2**.
- Historical rescoring under a changed policy — explicitly out of initial scope.
