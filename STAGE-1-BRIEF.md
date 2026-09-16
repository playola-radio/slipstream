# Stage 1 handoff brief — prove byte capture

You are implementing **Stage 1 only** of Slipstream. Read
`IMPLEMENTATION_PLAN.md` and `NOTES-architecture.md` first; this brief adds the
context that is not in them and tells you where the traps are.

## What Slipstream is

A tool that streams a coding agent's file changes live, so a developer can review
alongside the agent instead of facing a pile of files at the end. Not shipped.
No code exists yet — you are writing the first line.

## What Stage 1 is, and is not

**Stage 1 answers one question: is watcher-primary capture accurate and fast
enough to watch live?** It is a measurement gate. If the answer is no, the rest
of the plan is wasted, so nothing else gets built until this is known.

Build: a CLI that attaches to a worktree, baselines it, watches it, and writes
`file.changed` records with before/after content-addressed blobs to a JSONL log.

Do **not** build: MCP server, forwarder, task grouping, tree-sitter, HTTP/SSE
reader, UI, or the full CloudEvents envelope. Those are Stages 2–5. A minimal
internal record shape is fine here; Stage 2 freezes the public schema.

**The deliverable includes numbers.** p50/p99 latency from write to committed
record, and a count of missed intermediate states against a known write trace.
A working watcher without measurements does not close this stage.

## Stack

TypeScript, Node 24 LTS, `@parcel/watcher` for FSEvents, `worker_threads` for
hashing. See the "Stack — settled" section of the plan for why. Do not introduce
a second language. Do not add a framework the stage does not need.

## The five things most likely to be gotten wrong

These are specific, and each one has burned this design already:

1. **Compare against the last committed snapshot, not what is on disk.** When a
   diff worker runs, the file may already have changed again. Reading current
   disk state as the "before" silently corrupts history. Serialize processing per
   path.

2. **Do not deduplicate globally by content hash.** `A → B → A` is two real
   transitions, and the second one must appear. Only byte-identical
   *consecutive* observations are suppressed.

3. **An empty file is a stored zero-byte blob, not `absent`.** Absent means the
   path does not exist. Conflating them makes deletion and truncation
   indistinguishable.

4. **Never write a fake empty blob.** Oversize (>10 MiB), unreadable, unstable,
   or io-error paths emit an explicit `unavailable` snapshot carrying a reason.
   Silence or a fake blob is worse than an honest gap — the entire product
   promise is honest gaps.

5. **Baseline is current bytes, not git HEAD.** If the worktree is dirty on
   attach, those existing changes are the starting state. They must not appear as
   edits the agent just made. Install the watcher *before* enumerating, and
   reconcile during the scan.

## Test environment warning

You will likely test inside a Conductor worktree while an agent edits that same
worktree. That is the right test, but the watcher can observe its own output.
Exclude the capture store from capture, and do not point the test harness at the
directory it writes into. `.gitignore` already excludes `.slipstream/`,
`sessions/`, `blobs/`, and `*.jsonl` — that is deliberate, because captured
blobs are real source bytes from a watched worktree and must never be
committable.

## Validation you have available for free

Claude Code stores full versioned file content at
`~/.claude/file-history/<session-uuid>/<hash>@v<N>`, and its live JSONL
transcript is at `~/.claude/projects/<slug>/<session-uuid>.jsonl`. Use these to
**check** captured endpoints against what the harness recorded.

Do not emit events from them. Harness content is a validation source in Stage 1
and an attribution source in Stage 4 — never a second change stream. That
constraint is what structurally prevents double-capture, and it was a deliberate
rejection during review.

Codex CLI stores rollout logs at
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` with `apply_patch` V4A
hunks, and **no file content at all** — which is precisely why capture is
watcher-primary rather than harness-primary.

## Definition of done

Every test listed under Stage 1 in `IMPLEMENTATION_PLAN.md` passes or is
explicitly reported as a known gap with a number attached. Specifically including
the awkward ones: rapid successive writes, atomic save (write-temp + rename),
deletion, creation, empty file, human save during an agent turn, oversize,
unreadable, and binary.

Then report, in plain terms, whether watcher-primary capture is good enough to
watch live — and if not, exactly where it loses.

## Required report format

Stage 1 ends with a written verdict in this shape. "It seemed fine" is not an
available answer, and neither is a single aggregate percentage — loss is only
interpretable by category.

**1. Latency.** p50 and p99 milliseconds from write to committed record.
Separately for: single small file, a 1 MiB file, and a burst of 100 files.

**2. Loss, broken down by category.** A raw percentage flattens cases that mean
very different things, so report counts per category against the known write
trace:

| Category | What it means | How bad |
|---|---|---|
| Burst-within-file | Intermediate states lost, correct endpoint captured | Mild — the endpoint is what a reviewer reads anyway |
| Whole-change-lost | A file changed and no event was emitted at all | Severe — the feed is silently incomplete |
| Endpoint-wrong | An event was emitted with content that never existed on disk | Fatal — worse than no event |
| Ordering-wrong | Events committed in an order contradicting the trace | Severe |
| Phantom | An event emitted for a change that did not happen | Severe |

`endpoint-wrong` and `phantom` are correctness bugs, not acceptable loss. Any
nonzero count there is a defect to fix within Stage 1, not a gap to report.

**3. Per-scenario results** for each awkward case listed above — rapid writes,
atomic save, delete, create, empty file, human save mid-turn, oversize,
unreadable, binary — pass, or fail with the category and count.

**4. A one-paragraph verdict**: is this good enough to watch live, and where
does it lose?

## What you must not decide alone

If capture turns out lossy, **stop and report. Do not remedy it.** Specifically,
do not without checking with Brian first:

- Change the capture architecture, or add a second capture source.
- Add a harness hook (`PostToolUse` or otherwise) to backfill misses.
- Emit events from Claude Code's `file-history/` or any harness log.
- Add polling, shorten the debounce, or otherwise trade CPU for fidelity.
- Relax, reword, or drop any Stage 1 success criterion.
- Declare Stage 1 complete with a known-lossy result.

The reason is that "too lossy" is a product decision, not an engineering one.
Supplementing capture with harness hooks, accepting the loss and disclosing it,
and narrowing what Slipstream promises are three different products. That call is
Brian's, and it needs the numbers above to be made well.

A high `burst-within-file` count with clean endpoints is very likely **fine** and
should be reported as such rather than treated as failure — the whole design
already assumes observed states, not every write.

## Working agreement

- Follow the repo's `CLAUDE.md`: TDD, small commits that compile and pass, no
  `--no-verify`, no `Co-Authored-By` trailers.
- Branch off `develop`, never `main`. PR titles start with `feature:` /
  `chore:` / `bugfix:` and are jargon-free.
- Stop after three failed attempts at the same problem and reassess, per
  `CLAUDE.md`.
- Update Stage 1's **Status** line in `IMPLEMENTATION_PLAN.md` as you go.
