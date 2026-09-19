# Stage 4 plan — honest attribution and enrichment

Read `IMPLEMENTATION_PLAN.md` Stage 4 first. This file is the ratified PR graph
and the resolved schema forks for Stage 4, produced by Codex design consults
(`gpt-6-astra`, 2026-09-19) and ratified by Brian's rulings D1–D4 below. It does
not restate or relax any Stage 4 success criterion — where a criterion is
narrowed (D2), its gate is deferred (D3), or a producer is redesigned into a
public projection (D4), that is an explicit ratified ruling.

## Ratified rulings (Brian, 2026-09-19)

- **D1 = B — keep the 4-PR / 2-track shape** (rejected Codex's 6-PR P0+G graph).
  Accepted tradeoff: without a shared foundation PR (P0), the wire contracts and
  the recovery-safety machinery (schedule-only-from-durable-commits, discard +
  reconstruct outstanding work on recovery, fence worker replies by recovery
  generation, revalidate target before append) is **published and tested inside
  A1 for attribution**, not once up front. (D4 removes the clips half: clips no
  longer append to the log, so B1 carries none of this machinery — it is
  attribution-internal only. See the accepted-tradeoff note.)
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
- **D4 = A — clips are a reader-derived public projection, not a log producer.**
  Ratified via a second Codex consult (`gpt-6-astra`, 2026-09-19). Clips are a
  pure function of `(before-blob, after-blob, projection version)`, and both blobs
  are already the source of truth, so a `change.clips` event would persist
  redundant, recomputable state; the one property only a persisted clip event
  buys (audit replay of "what clip was shown at seq N") has no requirement behind
  it. Track B now publishes a **versioned clip projection** — schema + reusable
  I/O-scoped module + reader API — computed on demand from the immutable blobs,
  cached disposably, never appended to the log. **Dropped:**
  `slipstream.change.clips.v1`, worker resume-from-log recovery, the
  highest-seq-wins replacement convention, and `policy_seq` for clips.
  **Retained verbatim:** the budgets, paired-span shape, explicit failure
  reasons, independent-client parity, and — critically — the **D3 capture-latency
  gate**, because parsing contention *relocates* to the reader rather than
  disappearing (a cold-cache feed can request dozens of parses at once and
  reproduce eager parsing's contention). Attribution is unaffected: its evidence
  is external and ephemeral, so it stays a daemon producer writing log events.

## B2 implementation clarification (Brian, 2026-09-19)

The closed language token may be added to projection inputs and the disposable
cache key. This extends D4's input tuple to `(before blob, after blob, language,
projection_version)` so identical bytes under TypeScript and TSX grammars cannot
share an incorrect result. The reader selects the token from the public event
path; direct-disk callers can supply it. The pool/admission architecture stays
unchanged. This clarification does not change any latency or honesty gate.

## Accepted tradeoff (D1=B, logged)

Skipping P0 is a Completeness-6 architecture call. **D4 update:** clips no longer
append to the log or share the fsync writer, so the recovery-generation /
worker-fencing machinery is now **attribution-internal only** (A1 owns it) and
Track B carries no log-recovery logic to duplicate. What the tracks still share is
the enrichment-config surface (Fork 4). Upgrade trigger: **if the bounded-parse /
overload-admission logic ends up duplicated between A1's evidence scheduling and
B1's projection admission, or B2 measures real contention between the reader's
parse workers and capture, extract a shared enrichment-foundation module then**
(retrofit, not up front). This is recorded so a later reviewer does not read the
remaining duplication as accidental.

## The two tracks

Both branch off `develop`. Track A (attribution) and Track B (clips) touch
largely disjoint code and may proceed in parallel; within a track A1→A2 and
B1→B2 are sequential. Post-D4 the tracks are effectively independent: Track A
appends attribution events to the log; Track B appends nothing — clips are a
read-time projection over the immutable blobs, so Track B shares neither the
fsync writer nor the recovery path with Track A (only the enrichment-config
surface). Neither track blocks capture — attribution appends are asynchronous
enrichment and the clip projection runs off the capture path; a failed parse or
attribution degrades the view, never drops or delays a `file.changed` event.

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
  `(source, change_seq) → highest-seq attribution`. Attribution-only — clips
  (D4) are a read-time projection, not a log fold, and do not use this reducer.
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

### Track B — clips (reader-derived projection, D4)

Clips are a **versioned public projection** over the immutable before/after
blobs, not log events. The projection is computed on demand, cached disposably,
and served through the public reader API; nothing is appended to the event log.

**B1 — Publish the clip projection contract with bounded fallback (no tree-sitter yet).**
Scope IN:
- **Clip projection schema (public interface, published here)** — the result a
  client receives for a change, *not* a log event:
  ```ts
  { change_seq, projection_version,
    status: 'ready'|'fallback'|'skipped'|'unavailable',
    fallback_reason?, // required unless 'ready'
    clips: Array<{ before: Span|null, after: Span|null /* +per-side method+reason */ }> }
  ```
  Spans reference the change's existing blobs by **zero-based half-open byte
  offsets** (define UTF-8 boundary + line-count rules). `null` = no corresponding
  span (created/deleted function), never unreadable content. `projection_version`
  names the complete algorithm (language selection + extraction queries +
  diff/pairing + bounds + timeout policy) and is the cache key — a client always
  knows which projection produced a clip.
- **Reader API + reusable module.** A public reader endpoint serves the projection
  for a change (or a bounded range) computed on demand from the immutable blobs.
  The projection is a **reusable, I/O-scoped module callable against on-disk
  artifacts**, which the HTTP reader wraps and the Stage 2 TUI can call *without*
  the bundled UI — the "delete the front-end and replace it" invariant holds
  because the capability lives in the published projection, not in UI code.
- **Disposable cache, no log.** Computed results are cached for reuse and may be
  dropped and rebuilt at any time; nothing is appended to the event log, there is
  no resume-from-log recovery, no highest-seq replacement convention, and no
  `policy_seq`. A change's clips are viewable exactly while its blobs are retained
  — **P5 GC is unchanged** and no capped copies outlive their blobs, so there is
  no partial resurrection of GC'd content (the honest outcome: no blobs → clips
  explicitly unavailable, never faked).
- **Budgets + bounded admission (retained verbatim from the producer plan):**
  parse only UTF-8 ≤ 1 MiB, 100 ms wall-clock/change; bounded diff/fallback prep
  *before* any parse so a timeout keeps the fallback; clips capped 300 lines &
  64 KiB **across the whole array per side** (a multi-span array must not
  circumvent the cap); fallback = changed ranges ±20 lines; if even bounded ranges
  can't be produced → `skipped` with reason, never invented ranges.
- **Cold-cache protection (the D4 risk):** the reader bounds how much parsing it
  admits concurrently — isolated workers, bounded queue — so a feed requesting
  many *uncached* changes at once cannot starve capture (a cold cache reproduces
  eager parsing's contention). Excess requests get an explicit `skipped`/deferred
  disposition with a reason, never a silent stall; capture is always prioritized.
- **Changed-ranges:** the change schema carries snapshots, not ranges. The
  projection computes bounded ranges from the blobs for the fallback; it does not
  add ranges to `file.changed.v1`.

Scope OUT: tree-sitter function extraction (B2); rendering clips in the UI
(Stage 5, which consumes this projection API).

Tests: half-written unparseable file → `fallback`, projection still returned;
uncached change requested cold → computed on demand and cached; cache dropped then
re-requested → identical result recomputed (same `projection_version`);
oversize/binary → `skipped`/`unavailable` with reason; a burst of uncached
requests → bounded admission, capture unaffected, excess deferred with a reason
(not silently stalled); a change whose blobs were GC'd → clips explicitly
unavailable with a reason.

**B2 — Extract paired function clips + measured latency gate.**
Scope IN: tree-sitter integration for an explicit language set (recommend
JS/JSX/TS/TSX; fall back for unsupported) **inside the projection**; a parse error
*elsewhere* in the file does not void a usable enclosing function (mixed →
`fallback` with per-hunk + projection-level reasons); created/deleted/multiple-
function cases + edited imports → one projection result, multiple clips, top-level
fallback where appropriate; deterministic pairing by diff correspondence (no
semantic function-identity or move-detection promise) and explicit truncation;
bump `projection_version` when the algorithm changes (a later version may
legitimately show different spans for the same change — acceptable for a view,
provided the version + fallback/truncation reasons are explicit). **D3
measurement protocol (retained)** — p50/p99 capture latency baseline-vs-saturation,
throughput, skipped counts under a predefined protocol that drives **concurrent
cold-cache projection requests** against live capture, with the numeric pass-bar
ratified from the measured baseline at review time.
Scope OUT: UI (Stage 5); full both-tracks-on combined acceptance (Stage 5 Q14
run). B2 measures the reader's parse-worker saturation against capture; combined
attribution+clips acceptance is Stage 5.

Tests: a change touching several functions, deleting one, editing imports → one
projection result, multiple clips, top-level fallback where appropriate;
concurrent cold-cache clip requests saturating the parse workers → raw capture
latency within the ratified bar (measured).

## Fork resolutions (adopted as recommended; not separately ruled)

- **Fork 1 — targeting:** `change_seq` + `(source, change_seq)` identity, BigInt
  compare, no `change_id`/`supersedes_seq`. A retained change's seq never moves;
  a discarded partial seq *can* be reused → the recovery discipline above.
- **Fork 2 — evidence identity:** `slipstream.harness.evidence.v1` + native
  `record_id`; dedup derived from the log; persist evidence before attribution.
- **Fork 3 — reducer (attribution):** one shared I/O-free public reducer for
  attribution; daemon uses it to schedule + suppress dupes; HTTP reader keeps
  serving the raw event stream (no hidden fold of attribution into it); clients
  fold attribution but keep the change's original seq + `task_hint_id`;
  independent implementations reproduce the documented fold. Clips (D4) are a
  *separate, explicit, versioned* projection endpoint over the blobs, not a fold
  of the event stream and not part of this reducer.
- **Fork 4 — config:** daemon config file + CLI overrides. For **attribution**,
  the effective policy is recorded in `slipstream.enrichment.configured.v1` and
  results reference it via `policy_seq`; **prospective by sequence** (later changes
  use the new policy; late evidence rescopes an old change under *that change's
  original* policy; reread/restart never silently rescores history). For **clips**
  (D4, no `policy_seq`), the bounds live in the `projection_version` instead; the
  clip ceilings (1 MiB / 100 ms / 300 lines / 64 KiB) may only be set **stricter**
  — raising them is a product decision, out of scope. Because clips are recomputed
  on demand, a stricter version simply produces stricter results going forward;
  there is no persisted history to rescore.

## Open items to ratify later (not now)

- Native `record_id` / file-scope field mappings for both transcript formats —
  proven with fixtures in **A2**, not guessed now.
- The numeric capture-latency pass-bar — set from the measured baseline in **B2**.
- Historical rescoring under a changed attribution policy — explicitly out of
  initial scope.
- **Audit replay of clips** ("what clip was shown at seq N", preserved without
  keeping old parser binaries) — the one property only a persisted clip event
  would buy. No requirement needs it; explicitly out of scope under D4. If an
  audit consumer ever needs it, it returns as a deliberate partial-content
  retention contract, not a free side effect of logging clips.
