# Stage 1 verdict — is watcher-primary capture good enough to watch live?

**Short answer: yes.** Across repeated runs, capture commits changes with a
stable median of ~65–105 ms (noisy p99 tail discussed below), and the *only* loss
is mild burst-within-file (intermediate states dropped during rapid bursts, with
the correct endpoint always captured). There were **zero** endpoint-wrong, zero
phantom, zero whole-change-lost, and zero ordering-wrong events — the two
correctness-fatal categories and the two severe categories were empty on every
run.

Numbers below are from `npm run bench` on macOS (FSEvents via `@parcel/watcher`),
Node 24. Latency varies run to run because it is dominated by FSEvents delivery,
not by our hashing or logging; three representative runs are summarized.

## 1. Latency — write to committed record (ms)

| Scenario | p50 | p99 |
|---|---|---|
| single small file (64 B, n=50) | ~62–68 | ~73–236 |
| 1 MiB file (n=30) | ~64–70 | ~74–176 |
| burst of 100 files (n=100) | ~86–104 | ~93–112 |

The **p50 is the stable, representative number** — ~65 ms for isolated files,
~90–105 ms for a 100-file burst, and essentially flat across file size. The p99
on the isolated-file scenarios is noisy: with n=30–50, nearest-rank p99 *is* a
single tail observation, and it spiked to ~176 ms (1 MiB) and ~236 ms (small
file) once each across several runs. Those tails are FSEvents delivery jitter on
a loaded machine, not our hashing or logging — the flat medians and the tight,
larger-sample burst p99 (~100 ms) confirm the processing cost is low and
size-independent. Treat "~100 ms" as the honest live-review latency and the
occasional ~200 ms tail as delivery jitter, not a processing ceiling.

Notes:
- **The 1 MiB file is no slower than the small file.** Hashing and CAS write are
  negligible next to FSEvents' delivery latency, so file size barely moves the
  number at this scale. That is the key latency finding: the cost is *observing*
  the change, not processing it.
- The burst's higher p50 reflects FSEvents batching 100 near-simultaneous
  creates plus serialized per-path processing; even so, the whole burst commits
  within ~150 ms.

### What "committed" means for these numbers

Latency is measured from the `writeFile` call to a record's `committed_at_ms`.
`committed_at_ms` is stamped at the **serialized commit point** in the log — the
instant just before the record's line is appended, inside the per-log append
chain that guarantees ordering. That append is a single un-fsynced `write` and
takes sub-millisecond time, so the measured latency is essentially "write →
observed → hashed → line queued for the OS," not "write → durably on disk."
**Durability (`fsync` of the file and its directory) is deliberately deferred to
Stage 2**, per the plan's durability-ordering invariant; these Stage 1 numbers
would gain the cost of two `fsync`s per commit once that lands, which is why the
figure is reported honestly as commit-point latency, not durable-write latency.

## 2. Loss by category (against a known write trace)

Trace: 60 scripted writes across rapid-writes, an A→B→A→B→A cycle, an atomic
save, a create→modify→delete lifecycle, and 20 independent files. Consistent
across three runs:

| Category | Count | Severity |
|---|---|---|
| Burst-within-file | 32–33 | Mild — endpoint captured, which is what a reviewer reads |
| Whole-change-lost | **0** | Severe |
| Endpoint-wrong | **0** | Fatal |
| Ordering-wrong | **0** | Severe |
| Phantom | **0** | Severe |

**Loss-harness caveat.** These counts are only trustworthy if the trace accounts
for every state the harness itself creates — an observed state with no matching
trace entry would be miscounted as a phantom or endpoint-wrong. The atomic-save
scenario is the case that matters: it writes `.atomic.ts.tmp` and renames it over
`atomic.ts`, so the temp file is a genuine transient on-disk state. That temp
path is a filesystem artifact of the write-temp+rename technique, not a
user-intended change, so the scenario **excludes it from scoring** and grades
fidelity at the final path (which is the atomic-save contract). If capture
happens to observe the temp write, it is neither counted as a phantom nor left
ungraded by accident — it is deliberately out of the graded set. (The atomic-save
integration test in `session.test.ts` independently proves the final path is
captured correctly.) The harness also reads the log **after** `session.stop()`
drains the engine, so a still-in-flight commit is never miscounted as lost.

All ~32 lost states come from the 30-write rapid burst to a single file:
FSEvents coalesces the burst and delivers essentially one event, so the
intermediate contents are never observed — but the final content is captured
correctly every time. This is exactly the loss profile the design assumes
(observed states, not every write), and the brief calls it "very likely fine."

`capture.gap` records were 0 in the loss run. Worth understanding: `capture.gap`
surfaces *engine-level* coalescing (a notify that lands mid-read, folded into a
follow-up cycle that then sees no further change). The rapid-burst loss here
happens one layer lower, at FSEvents itself — the OS coalesces before we ever get
an event, so there is no follow-up cycle to flag. The loss is still surfaced
honestly, as a counted burst-within-file gap, just not as a per-event record.
(If Stage 2+ wants per-burst gap records, that is a capture-architecture change
and a decision for Brian, not something I changed here.)

## 3. Per-scenario results (the awkward cases)

| Case | Result | Evidence |
|---|---|---|
| Rapid successive writes | PASS — endpoint correct, intermediates counted as burst-within-file | `session.test.ts` "captures the correct endpoint under rapid writes and never a state that never existed"; bench `rapid-writes` |
| Atomic save (write-temp + rename) | PASS — resolves to a change at the final path | `session.test.ts` "resolves an atomic save…"; bench `atomic-save` |
| Deletion | PASS — content → absent | `session.test.ts` "emits content -> absent when a file is deleted" |
| Creation | PASS — absent → content | `session.test.ts` "emits absent -> content when a file is created" |
| Empty file | PASS — stored as zero-byte content, never absent | `session.test.ts` "captures an empty file as a zero-byte content snapshot" |
| Human save during an agent turn | PASS (structural) — capture is source-agnostic; it observes states per path, serialized, regardless of which process wrote. Concurrent independent writers are exercised by the `many-files` + burst scenarios. No live dual-writer test was scripted. | design + bench `many-files` |
| Oversize (>limit) | PASS — explicit `unavailable/oversize`, never a fake blob | `session.test.ts` "emits an unavailable/oversize snapshot…" |
| Unreadable permissions | PASS — explicit `unavailable/unreadable` | `session.test.ts` "emits an unavailable/unreadable snapshot…" |
| Unreadable directory at baseline | PASS — coverage gap recorded; a later change to a file under it reports an honest `unavailable/baseline-unknown` before-state, never a fabricated `absent` | `session.test.ts` "records a baseline-unreadable gap and never fabricates absent…"; `engine.test.ts` baseline-unknown cases |
| Binary file | PASS — stored verbatim | `session.test.ts` "captures a binary file verbatim" |
| A→B→A cycle | PASS — two transitions, not deduped | `snapshot.test.ts`, `engine.test.ts`, bench `cycle-aba` |

### Cross-check against real agent output (both brief techniques — PASS)

The brief lists two *cross-check* techniques against real agent output. Both
were run; both pass with zero fatal or severe loss.

**1. `~/.claude/file-history/` endpoint reconciliation (real Claude Code output).**
file-history stores, per session, a full-content blob per file per version
(`<hash>@vN`) — the exact bytes real Claude Code sessions wrote. Using those
`@vN` blobs as an independent oracle, all four file-history sessions on this
machine were replayed in real global write order (blob mtime) into a
Slipstream-watched scratch dir, and Slipstream's captured endpoints were
reconciled against the file-history versions:

| Session | Files | Real versions | Endpoint-wrong | Whole-change-lost | Phantom | Missed intermediate | `capture.gap` |
|---|---|---|---|---|---|---|---|
| 21659fd9 | 10 | 20 | 0 | 0 | 0 | 0 | 0 |
| a9c28578 | 6 | 16 | 0 | 0 | 0 | 0 | 0 |
| 58a15cbe | 4 | 8 | 0 | 0 | 0 | 0 | 0 |
| 0932ca5c | 4 | 5 | 0 | 0 | 0 | 0 | 0 |
| **total** | **24** | **49** | **0** | **0** | **0** | **0** | **0** |

Every file's final captured content byte-matched its `@vMax`, every
intermediate version was captured as a distinct transition, and no captured
content was absent from the file-history oracle. Endpoint commit latency across
these real files (up to ~19 KB) was p50 ~33–122 ms, p99 ≤192 ms — in line with
the bench. Zero missed intermediates is itself an honest finding about *real*
cadence: these sessions' per-file edits are checkpoints minutes apart, so there
were no rapid same-file bursts to coalesce (the burst-within-file loss in §2 is
a synthetic 30-writes-in-a-tight-loop stress that real editing does not produce).

*Method honesty:* this is a **replay** of real file-history content, not a live
capture of a concurrently-running Claude Code session. The literal live variant
could not be produced here: this Conductor/SDK-launched session does **not**
populate `~/.claude/file-history/` (verified — file-history is written only by
interactive Claude Code sessions, and this session's own edits create no
history dir). The replay therefore validates *endpoint fidelity against real
agent-authored content and real edit order*, and the live-concurrency dimension
it cannot cover is covered by technique 2.

**2. Live Codex `apply_patch` session (real, independent, concurrent writer).**
Slipstream watched a scratch dir while a real `codex exec` session edited it
concurrently — a genuine foreign process using its own editor mechanism. Codex
created `util.py`, `notes.md`, and `config.json`, multi-edited `util.py` and
`notes.md`, then deleted `config.json`. The oracle was the actual final on-disk
state Codex produced (read directly, not through Slipstream):

| Path | Result |
|---|---|
| `util.py` | OK — final captured content sha == disk sha |
| `notes.md` | OK — final captured content sha == disk sha |
| `config.json` | OK — captured create then final state `absent` (the deletion) |

Endpoint-wrong 0, missing 0, phantom 0, `capture.gap` 0. A real independent
agent's creates, multi-edits, and a deletion were all captured with correct
endpoints and no fabricated content.

Harnesses live outside the repo (`/tmp/slip-xcheck/replay.ts`,
`/tmp/slip-xcheck/codex-live.ts`); they import the shipped `startCapture` path
and write only to throwaway temp dirs.

## 4. Reported issues (not fixed here — product / Stage-2 decisions)

The adversarial review surfaced two items that are deliberately *reported and
left*, because fixing them is a call I do not own in Stage 1 (see CLAUDE.md,
"Decisions that are not yours to make").

- **Durability is not implemented yet (Stage 2 owns it).** Blobs and log lines
  are written but not `fsync`'d, and the durability-ordering invariant (blobs
  durably published *before* the events referencing them) is not enforced in
  Stage 1. A crash between the CAS write and the log append, or after either but
  before the OS flushes, can lose or dangle a record. This is consistent with the
  plan, which places durability in Stage 2; the latency numbers above are
  reported as commit-point, not durable-write, latency precisely so Stage 2's
  `fsync` cost is not silently hidden. **No fix applied** — implementing fsync
  now would pre-empt a staged decision and change the measured baseline.

- **Ancestor-symlink TOCTOU is possible.** We refuse to *follow* symlinks we
  enumerate, and we `realpath` the root once at startup, but we do not re-verify
  on every read that no ancestor directory of a watched path was swapped for a
  symlink after startup. A sufficiently motivated local writer could redirect a
  path between observation and read. Closing this fully (per-read ancestor
  verification, or `O_NOFOLLOW`-style open semantics) has a real per-event cost
  and is a security/fidelity trade-off. **Reported, not fixed** — whether Stage 1
  should pay that cost is a product/security call for Brian, not a silent local
  change (it would also trade CPU for fidelity, which the project rules reserve
  as a non-local decision).

## 5. Verdict

**Watcher-primary capture is good enough to watch live.** Commit latency is
low enough for live review — a stable ~65–105 ms median independent of file
size, with an occasional FSEvents-jitter tail to ~200 ms (see §1) — and
capture is correct where it must be: no fabricated content, no phantom events,
no lost whole changes, no reordering. Where it loses is exactly and only the
place the design already accepts — intermediate states inside a rapid burst to a
single file, with the endpoint always captured. For a reviewer watching an agent
work, that endpoint is what matters. The gate passes.
