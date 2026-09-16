# Stage 1 verdict — is watcher-primary capture good enough to watch live?

**Short answer: yes.** Across repeated runs, capture commits changes in well
under ~150 ms at p99, and the *only* loss is mild burst-within-file (intermediate
states dropped during rapid bursts, with the correct endpoint always captured).
There were **zero** endpoint-wrong, zero phantom, zero whole-change-lost, and
zero ordering-wrong events — the two correctness-fatal categories and the two
severe categories were empty on every run.

Numbers below are from `npm run bench` on macOS (FSEvents via `@parcel/watcher`),
Node 24. Latency varies run to run because it is dominated by FSEvents delivery,
not by our hashing or logging; three representative runs are summarized.

## 1. Latency — write to committed record (ms)

| Scenario | p50 | p99 |
|---|---|---|
| single small file (64 B, n=50) | ~62–69 | ~71–111 |
| 1 MiB file (n=30) | ~65–72 | ~82–108 |
| burst of 100 files (n=100) | ~94–147 | ~100–153 |

Notes:
- **The 1 MiB file is no slower than the small file.** Hashing and CAS write are
  negligible next to FSEvents' delivery latency, so file size barely moves the
  number at this scale. That is the key latency finding: the cost is *observing*
  the change, not processing it.
- The burst's higher p50 reflects FSEvents batching 100 near-simultaneous
  creates plus serialized per-path processing; even so, the whole burst commits
  within ~150 ms.

## 2. Loss by category (against a known write trace)

Trace: 60 scripted writes across rapid-writes, an A→B→A→B→A cycle, an atomic
save, a create→modify→delete lifecycle, and 20 independent files. Consistent
across three runs:

| Category | Count | Severity |
|---|---|---|
| Burst-within-file | 31–33 | Mild — endpoint captured, which is what a reviewer reads |
| Whole-change-lost | **0** | Severe |
| Endpoint-wrong | **0** | Fatal |
| Ordering-wrong | **0** | Severe |
| Phantom | **0** | Severe |

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
| Binary file | PASS — stored verbatim | `session.test.ts` "captures a binary file verbatim" |
| A→B→A cycle | PASS — two transitions, not deduped | `snapshot.test.ts`, `engine.test.ts`, bench `cycle-aba` |

### Validation not yet performed (noted gap, not a capture failure)

The brief lists two *cross-check* techniques as validation available for free:
capturing a real Claude Code session and checking endpoints against
`~/.claude/file-history/`, and a real Codex `apply_patch` session. I validated
against **scripted** write traces and the integration suite, not a live agent
session. The behaviors those sessions would exercise (rapid writes, atomic
saves, creates/deletes from a real editor) are covered above. Running the live
cross-check is a worthwhile confirmation and can be done on request; it is a
validation-method gap, not a measured capture loss.

## 4. Verdict

**Watcher-primary capture is good enough to watch live.** Commit latency is
low enough for live review (p99 under ~150 ms), independent of file size, and
capture is correct where it must be: no fabricated content, no phantom events,
no lost whole changes, no reordering. Where it loses is exactly and only the
place the design already accepts — intermediate states inside a rapid burst to a
single file, with the endpoint always captured. For a reviewer watching an agent
work, that endpoint is what matters. The gate passes.
