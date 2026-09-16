# Slipstream — project instructions

Read `IMPLEMENTATION_PLAN.md` before starting work. Read `STAGE-1-BRIEF.md` if
you are implementing Stage 1.

## The rule that overrides convenience

**The event schema is the public interface.** The on-disk JSONL log and
content-addressed blobs are the source of truth; the reader API is a thin view;
the bundled UI is one client among possible many. Anyone must be able to delete
the front-end and replace it.

Practical consequence: if a capability is only reachable through the bundled UI
or through daemon internals, it is not done. No privileged back channel between
daemon and client.

## Honesty constraints

These are product requirements, not style preferences. Violating them makes the
tool lie to its user, which is worse than missing a feature.

- Capture reports **observed filesystem states with explicit gaps**, never a
  claim of complete edit history. A watcher sees states, not writes.
- Attribution is **revisable inference** with a status (`pending` / `heuristic` /
  `ambiguous` / `unknown`), never verified authorship. Proximity in time is
  evidence, not proof. UI language says "possibly agent", never "attributed".
- Unavailable content is **explicitly unavailable with a reason**. Never a fake
  empty blob, never a silent drop.
- `session_id` means capture scope — which worktree is watched — never authorship.

## Architecture invariants

- **Watcher-primary capture.** Harness logs may update attribution; they may
  never create a filesystem-change event. This prevents double-capture
  structurally rather than by reconciliation.
- **Enrichment never blocks capture.** Parsing and attribution are asynchronous
  and append-only. A failed parse degrades the view; it never drops an event.
- **Durability ordering.** Blobs are written and durably published *before* the
  events referencing them are appended. `fsync` the file and its directory.
- **Slipstream does not launch agents.** Conductor stays the launcher. Slipstream
  arrives through user-level MCP and skill config.

## Stack

TypeScript on Node 24 LTS throughout — daemon, MCP forwarder, UI.
`@parcel/watcher` for FSEvents, `worker_threads` for hashing and parsing.
Do not introduce a second language without measured Stage 1 evidence.

## Never commit captured data

`.slipstream/`, `sessions/`, `blobs/`, and `*.jsonl` are gitignored deliberately.
They hold real source bytes from whatever worktree is being watched. Never
commit them, never relax those ignore rules, not even from a test run.

## Process

- TDD: test first, minimal implementation, refactor. Never disable a test to
  make it pass.
- Small commits that compile and pass. Never `--no-verify`.
- No `Co-Authored-By` or co-sign trailers in commits.
- Branch off `develop`, never `main`. PR titles start with `design:` /
  `feature:` / `bugfix:` / `chore:` / `release:` and must be jargon-free — a
  layman should understand what the PR does from the title alone.
- Stop after three failed attempts at the same problem, document what failed,
  and reassess rather than continuing to retry.
- Keep the **Status** lines in `IMPLEMENTATION_PLAN.md` current.
