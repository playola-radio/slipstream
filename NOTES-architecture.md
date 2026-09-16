# Slipstream — architecture decision notes

Date: 2026-09-16
Architect: Codex (gpt-6-astra) consult + local empirical checks.

## Fixed constraints (from Brian)

- Slipstream **may not replace Conductor** as the agent launcher.
- Feature 3 must reach the **original implementing LLM**, live — not a replay.
- Floor: Claude Code + Codex CLI, both launched by Conductor.

## Decision

**Headless local service + browser client.** TS/Node service, SQLite, React +
Monaco/CodeMirror client. Not a VS Code extension, not a fork.

**Integration model: cooperative, not observational.** Slipstream ships an **MCP
server + a skill** that the implementing agent loads. The agent *reports its own
changes* and *answers questions* by calling Slipstream's tools. Slipstream does not
attach to a foreign process.

## Why the MCP+skill approach resolves the blocker

Earlier finding: Conductor's MCP is the **cloud** control plane. On this machine
`list_projects` → `[]` and `list_models` → all agents `configured: false`. It
cannot see or message local sessions. So inbound injection into a foreign
session was a dead end, and Slipstream-owns-launch is now ruled out by constraint.

**Inverting the direction solves it.** Instead of Slipstream pushing into the agent,
the agent pulls from Slipstream. Verified locally:

- **Claude Code**: `~/.claude.json` already carries global `mcpServers`
  (render, sentry, mixpanel, conductor, pencil) and `~/.claude/settings.json`
  carries user-level `hooks`. **This very session — launched outside Slipstream —
  inherited both.** A Slipstream MCP server + skill registered at user level is
  therefore present in every Conductor-launched Claude session automatically.
- **Codex CLI**: `~/.codex/config.toml` has `[mcp_servers.*]` (same pattern) and
  `~/.codex/skills/` exists and is populated. Same mechanism available.

Conductor stays the launcher. Slipstream rides in via user-level config.

## How feature 3 actually works

The hard part was *inbound delivery to a busy/idle agent*. MCP tools are
agent-initiated, so a plain tool cannot wake an idle session. Resolve by making
the agent poll as part of its own loop:

1. User highlights code in Slipstream, asks a question.
2. Slipstream enqueues it against `(session_id, task_id, file, revision, selection)`.
3. The agent picks it up via one of:
   - **Skill instruction**: "call `slipstream_check_questions` after each task /
     before finishing." Deterministic, no new infrastructure.
   - **Hook-as-doorbell**: a `Stop` / `PostToolUse` hook that drains the queue
     and injects the question as context. Fires at real lifecycle boundaries.
   - **Claude Code channels** (research preview) for true push, if available.
4. Agent answers via `slipstream_answer(question_id, ...)`, optionally edits code.

**Known limit — be honest about it:** a fully idle session with no pending
boundary may not pick up a question until it next acts. The `Stop` hook is the
best mitigation (it fires exactly when the agent would otherwise go quiet, and
can block to let the agent respond). Slipstream's UI must show `queued` vs
`delivered` vs `answered` rather than pretending delivery is instant.

## Proposed tool surface

Reporting (agent → Slipstream):
- `slipstream_begin_task(title, intent)` → `task_id`. **Solves task grouping**
  directly — the agent declares its own boundaries instead of Slipstream inferring
  them from logs.
- `slipstream_report_change(task_id, file, before, after, summary)` — optional;
  largely redundant with hook-based capture (see below).
- `slipstream_end_task(task_id, summary)`

Q&A (agent ↔ Slipstream):
- `slipstream_check_questions()` → pending questions with file/selection/revision
- `slipstream_answer(question_id, answer)`

**Do not make the agent hand-report every edit.** Token-expensive and it will
forget. Capture bytes mechanically via a `PostToolUse` hook on Edit/Write plus
an FS watcher; use MCP for the things only the agent knows — **task boundaries,
intent, and answers**. That split is the key design call.

## Storage rules (unchanged, still critical)

- Store **before/after content per change event**. Never recompute history from
  today's git diff — an edit followed by a revert vanishes from net state but
  must remain in the stream.
- Task grouping comes from agent-declared boundaries (now first-class via
  `slipstream_begin_task`), falling back to top-level-request inference.
- Label uncertain changes `unattributed`. Never attribute an edit just because
  an agent was busy.

## UI — per the canvas (`~/Documents/ai-flow.pen`)

**Correction:** the `ai-flow-demo` export is one selected frame ("Task feed and
editor") with the filetree *minimized*, not absent. The source canvas has ~30
frames and the file explorer is designed throughout. Feature 1 stands as
originally specified. Read the canvas via the pencil MCP, not the partial export.

**The filetree is a three-column app, left to right:** explorer → change stream →
editor panes. The explorer collapses (that's what the export shows).

Explorer design as built on the canvas:
- Header `PROJECT FILES` (IBM Plex Mono 10, letterSpacing 1).
- **Filter is a segmented control, not a checkbox**: `Changed · 8` | `All files`
  on a `#11161C` track, active segment `#34404D`. "Show only diffed files" is
  the *default* selected state. (`QciBz` / `Y37W7`)
- Find-file field, collapse-folders + overflow icons.
- `Changed file tree` — nested rows (storefront → src → auth → session.ts …),
  per-row file-type icons, per-file delta counts.
- Scope toggle: `Repository · all stories` vs `This story only`.
- An **exclusions** section (`node_modules/`, `dist/`, `package-lock.json`).

Note the canvas vocabulary: **"stories"** and **"activity"**, not "tasks". Frames
named `Slipstream · Live story workspace`, `Slipstream · Control room`,
`Slipstream · The working proof`. Worth adopting — "story" reads better than "task"
for a unit of agent work.

Other panes:

- **Left — "Change stream"**: chronological, grouped by task. Numbered task
  headings (`01 Convert isActive from a boolean to an enum`) that enter inline
  then stick below the toolbar; the next task pushes the previous heading away
  (headings do not stack). Per-file cards with filename header + timestamp.
  Changed functions shown *whole* — signature to closing brace, including
  unchanged lines — with blue gutter markers on changed lines. Hideable via
  Activity control. Live footer: "New changes appear below" + "Jump to latest".
- **Right — editor panes**: tabs, per-pane Diff/Plain toggle, CURRENT · working
  tree vs PREVIOUS · before this task side by side, collapsed unchanged-line
  ranges ("1–5 unchanged lines", "Expand unchanged lines"), task attribution per
  pane (`TASK 01 · Define the enum`). Horizontal + vertical splits. Double-click
  code in the feed opens/focuses its file and reveals the lines.

Monaco is the obvious fit for the right pane (diff editor, collapsed regions).
The change stream should be lightweight rendered diffs, **not** a Monaco instance
per card.

Design tokens are already in the canvas (Geist for UI, IBM Plex Mono for code/
labels, resolved hex values). Pull them from `GetVariables()` at build time
rather than re-deriving them.

## Build order

- **Stage 0 (~1 day) — kill the routing risk.** Hand-write a minimal Slipstream MCP
  server + skill, register at user level for both harnesses, launch a real
  Conductor session, and verify: the agent calls `slipstream_begin_task`; a question
  queued mid-task is picked up and answered; a `Stop` hook drains the queue on
  an otherwise-idle agent. No UI.
- **Stage 1 (~3–5 days) — usable.** Service + SQLite + SSE; PostToolUse capture
  hook; change stream (sticky task headings, whole-function clips); right pane
  with Diff/Plain; selection → question → answer round trip.
- **Stage 2 — trustworthy.** Restart recovery, dedup, renames, overlapping
  sessions, subagent provenance, honest gap labeling.
- **Stage 3 — reach.** Electron packaging, multi-worktree, splits.

## Open questions for Brian

1. Is requiring a user-level install step (register Slipstream's MCP + skill + hooks
   once) acceptable? It's the price of not owning launch.
2. Should an agent's answer be allowed to **edit code**, or answer-only in v1?
3. Adopt the canvas's "story" vocabulary over "task"?

---

## Capture mechanics — verified findings (2026-09-16)

### Claude Code: already stores before/after content

- Live JSONL transcript per session at
  `~/.claude/projects/<slug>/<session-uuid>.jsonl`. **Verified live-appending**
  (grew 308→314 lines mid-turn). Carries timestamped `tool_use` events.
- **`file-history-snapshot` / `file-history-delta`** rows track every edited file,
  and the actual versioned content lives at
  `~/.claude/file-history/<session-uuid>/<hash>@v<N>`.
  Verified: v2/v3/v4 of `NOTES-architecture.md` present on disk.
- So for Claude Code, the "store before/after per change event" rule is **already
  satisfied by the harness**. Read it, don't rebuild it.

### Codex CLI: logs patches, does NOT store file content

- Rollout logs at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
  (1.5 GB of history on this machine). Row types: `session_meta`,
  `response_item`, `event_msg`, `turn_context`, `world_state`.
- `session_meta.payload.cwd` gives the **Conductor worktree path** — this is the
  session↔worktree join key.
- Edits appear as `response_item` → `payload.type: "function_call"`,
  `name: "apply_patch"`, with a V4A patch body in `arguments`
  (`*** Begin Patch` / `*** Update File:` / `-`/`+` hunks). Verified on real logs.
- **No `file-history` equivalent. No content backups.** A patch hunk gives you
  changed lines with a little context — not the full before/after file.

### Answer: is a watcher redundant?

**Not redundant — asymmetric.** Use both, with different jobs:

| | Claude Code | Codex CLI |
|---|---|---|
| Full before/after content | ✅ `file-history/` | ❌ patch hunks only |
| Timestamped edit events | ✅ | ✅ |
| Task/turn structure | ✅ | ✅ |

- **Harness logs are the source of truth for *attribution and timing*** — who
  changed what, when, under which turn. A watcher can never tell you this.
- **A watcher is the source of truth for *bytes*** — and it is genuinely needed
  for Codex, for shell-driven edits (`sed`, codemods, `npm install`, generated
  files), and for anything the agent does outside a patch tool.

Do **not** use nodemon (it's a dev-server restarter). Use `chokidar` (or
`fs.watch` via `@parcel/watcher`) + `isomorphic-git`/`simple-git`.

**Recommended pipeline:** watcher detects a write → hash + store full
before/after content in Slipstream's own CAS → correlate to the nearest preceding
harness edit event (same path, within the turn window) → attach attribution.
Unmatched writes get labeled `unattributed` rather than guessed.

This makes Slipstream's store harness-independent (the harness-agnostic fallback
comes free), while harness logs upgrade it from "a file changed" to "task 5
changed it, here's why."

### Gemini CLI

Not installed on this machine — nothing to verify. It does keep session logs
(`~/.gemini/tmp/<hash>/`), but treat it as unverified until tested. The
watcher-first design means a third harness costs only an attribution adapter,
not a new capture path.

---

## MVP decisions (settled with Brian, 2026-09-16)

**Scope:** a live feed of changes as they happen, watched alongside the agent.
**No Q&A loop in MVP** (Q2=no) — but the event schema must make questions purely
additive.

| # | Decision | Choice |
|---|---|---|
| Q1 | Feed granularity | **Whole-function clips** (tree-sitter), falling back to hunk+large context |
| Q2 | Question/comment loop | **Not in MVP** |
| Q3 | Front-end-agnostic interface | **On-disk JSONL log + CAS blobs = source of truth; HTTP/SSE thin reader over it** |
| Q4 | Session scope | **One session at a time**; `session_id`/`worktree` first-class on every event |
| Q5 | Harnesses | **Claude Code + Codex from day one**, via watcher-primary capture |
| Q6 | MCP topology | **stdio thin forwarder → one long-running daemon** |
| Q7 | Event envelope | **CloudEvents** + Slipstream-specific `data` |
| Q8 | Skill packaging | **Portable core `SKILL.md` + optional per-harness enrichment** |
| Q9 | Install | **Manual/documented for MVP**, installer later |
| Q10 | Verify stdio spawning | **Done — confirmed empirically** |

### Q10 result — stdio MCP spawns per session (VERIFIED, not inferred)

Registered a minimal stdio MCP probe server, ran two independent
`claude -p` sessions against it:

```
SPAWN pid=4953 ppid=4906   CALL pid=4953
SPAWN pid=5269 ppid=5160   CALL pid=5269
```

Two sessions → two distinct server processes, each serving its own tool call.
There is no shared-stdio option. **The MCP server therefore cannot own the
store** — it must forward to a single long-running daemon. Confirms Q6.

Probe kept at `<scratchpad>/mcp-probe/` for re-testing against Codex.

### Q1 note — why whole-function clips cost more, and why it's still fine

The cost is parsing: finding the enclosing function for a changed line needs a
real parser per language, not a regex. But this is smaller than I implied:

- `web-tree-sitter` (0.27.0) is one wasm dependency; grammars are per-language
  wasm files loaded on demand. Node 24 is present.
- The algorithm is small: parse the *after* content, walk to the innermost node
  spanning the changed byte range, climb to the nearest
  function/method/class declaration, emit its full byte span.
- Real cost is the long tail — languages without a grammar loaded, files that
  fail to parse mid-edit (an agent's half-written file is often invalid), and
  changes outside any function (imports, top-level config, JSON/Markdown).

**Design consequence:** treat the function span as an *enrichment*, not a
requirement. Every event always carries the raw changed byte range plus
before/after content. When parsing succeeds, the event additionally carries
`enclosing_span`. When it fails — unparseable, unsupported language, top-level
change — the UI falls back to hunk + large context automatically. This is Q1(b)
with Q1(c)'s escape hatch, and it means a broken parse degrades the view rather
than dropping the event.

---

## Codex adversarial review — amendments accepted (2026-09-16)

Full report: `/tmp/codex-differ-mvp.txt`. Codex kept the architecture
(watcher-primary, daemon, JSONL + CAS, single MCP tool, CloudEvents) and attacked
the *promises*. Three amendments accepted by Brian; plan written to
`IMPLEMENTATION_PLAN.md`.

**A1 — Q14 narrowed.** Slipstream promises "a live history of observed filesystem
states, with explicit coverage gaps," not a complete edit history. A watcher sees
states, not writes: `A→B→C` observed as `A→C`; `A→B→A` can be invisible. Disclosed
via `slipstream.capture.gap.v1`. Done now also requires measured latency, crash/replay
tests, and independent-client parity — a live demo alone does not establish an
accurate public interface.

**A2 — Q13 restructured.** Three things Q13 previously conflated are now separate
fields:
- `session_id` = **capture scope** (which worktree is watched), never authorship.
- `task_hint_id` = **declared grouping** (task open at observation). Immutable.
- `attribution.status` = `pending` | `heuristic` | `ambiguous` | `unknown`,
  revisable by later append-only `slipstream.change.attribution.v1` events.

Starting policy: ±2s window per harness tool-use record vs the change's
observation interval; one candidate → `heuristic`, several → `ambiguous`, none
after 5s grace → `unknown`. Calibration parameters, not correctness guarantees.
UI says "possibly agent", never "attributed".

**A3 — Q1 off the capture path.** Bytes + byte ranges publish immediately;
tree-sitter runs in isolated workers against immutable blobs and appends
`slipstream.change.clips.v1`. Clips are an **array** of paired spans — one change can
touch several functions, delete one, and edit imports. Budgets: parse ≤1 MiB
UTF-8, 100 ms/change, clips ≤300 lines / 64 KiB per side, fallback = changed
ranges ±20 lines. A parse error elsewhere in the file does not void a usable
enclosing function.

**Rejected: harness content as a second event stream.** Claude Code's
`file-history/` is used only to *validate* Stage 1 capture fidelity. A transcript
record may update attribution; it may never create a filesystem-change event.
This avoids double-capture structurally rather than by reconciliation.

**Newly settled (were silently assumed):** one active capture session
daemon-wide bound to one harness session ID + one canonical worktree, selected by
explicit CLI attach (others get `SESSION_NOT_SELECTED`, never steal ownership);
ambiguous identity fails attachment rather than guessing; baseline is current
bytes not git HEAD; renames are delete+create; symlinks excluded; oversize/
unreadable files get explicit `unavailable` snapshots, never a fake empty blob;
empty file is a stored zero-byte blob, not absent; blobs durably published
*before* the events referencing them; replay-then-follow is one cursor in one log
position; no automatic retention expiry in MVP.

### Vocabulary settled: "Task", not "story" (2026-09-16)

Brian's call, made before Stage 3 freezes the schema. Binding on the public
interface: `slipstream.task.started.v1`, `task_id`, `task_hint_id`,
`slipstream_begin_task`, subject `task/<task_id>`. The canvas frame names use
"story" (`Slipstream · Live story workspace`, etc.) — those are design-file labels;
UI copy follows the schema and says "task". Supersedes open question 3 in the
earlier "Open questions for Brian" section above.

### Product name settled: Slipstream (2026-09-16)

Working name "Differ" retired. A slipstream is the low-pressure pocket behind a
fast-moving object; riding in it makes following far cheaper than leading
(cyclists draft at ~20-40% less energy). That is exactly the thesis — stay in the
agent's wake and review as it works, rather than facing a pile of files at the
end. The metaphor is honest about the constraint too: the effect falls off with
distance, so keeping up is a requirement, not just a benefit. The "slingshot"
pass out of a slipstream is the natural home for the deferred Q&A feature.

Binding on the public interface: `slipstream.*` event types,
`urn:slipstream:session:<id>`, `slipstream_begin_task`, `.slipstream/` storage.
Renamed across both docs before any code existed, so nothing is stranded.
