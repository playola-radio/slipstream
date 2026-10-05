# Workspace auto-capture — design

Date: 2026-10-05. Owner: Brian. Status: **spec in review** (no code yet).
Architecture via Codex consult (session in `.context/codex-session-id`,
transcript `.context/consult-autocapture-response.txt`).

## Goal

Every new Conductor workspace automatically starts a Slipstream capture of its
worktree, with negligible overhead on the machine — especially when idle — and
stops capturing when the workspace is archived.

## Owner decisions (Brian, 2026-10-05)

| # | Decision | Ruling |
|---|---|---|
| Q4 | One active capture daemon-wide | **Lifted.** Several captures may be active at once, one per worktree. |
| D1 | Capture cannot become ready | Workspace setup **fails visibly**; the agent never starts on an uncaptured workspace. |
| D2 | Dependency/build output | **Excluded** by an explicit, ratified pattern list, each exclusion disclosed in the log. |
| D3 | Trigger | **Personal Conductor setup/archive scripts** across projects (not daemon folder discovery). |
| D4 | Storage | **Retain history until explicitly deleted.** No automatic age/size retention. |
| D5 | Agent binding | **Watch-only capture now**; verified agent binding is a separate, later step. |
| D6 | Order | **Measure first**, then the minimal slice, then restart recovery and maintenance. |
| D7 | Install | A **global install** from a dedicated clone + launcher; npm packaging deferred. |

Stage 3 criteria amended by Q4 (manual start, explicit selection,
detach-before-switch) are amended *only* for watch-only auto-captures.
Identity verification, watcher-primary capture, and every other acceptance gate
are unchanged.

## What exists today (verified in code)

- Single-active lives only in the daemon control plane (`src/daemon.ts`
  `state`/`current`); attach while active → `SESSION_ACTIVE` (`src/daemon.ts:498`).
  Log, CAS, reader, boundary registry, and `CaptureSession` are multi-session.
- `slipstream start` runs the daemon in the foreground; it is not an idempotent
  ensure-running command (`src/cli.ts:475`).
- `attach` requires a harness identity; there is no watch-only mode.
- Transcript polling is switched on by daemon config (`transcriptRuntimeFrom`,
  `src/daemon.ts`), not by the attach's identity; it reschedules 2 s after each
  scan finishes (`src/session.ts:30`). Codex discovery is capped at 2,000 files
  (`src/config.ts:18`); `~/.codex/sessions` holds 3,276 today, so scans truncate.
- Each capture holds its own heartbeat lock, plus one store lock: N captures cost
  N+1 lock reads + `utimes` every 2 s (`src/lock.ts:107`, `:177`).
- Exclusions are only the store dir and `<root>/.git` (`src/session.ts:426`).
- Baseline reads every file and appends one `file.baselined` event per file.
- Delete/GC refuse while any capture is attaching/active/detaching
  (`src/daemon.ts:748`).
- The boundary registry assumes retained sessions never become active again
  (`src/boundary-registry.ts:30`).
- Codex attach verifies `cli_version` ∈ {0.154.0, 0.155.1}; Conductor bundles
  0.156.1. Irrelevant to watch-only capture; relevant to later binding.

## Conductor facts (verified 2026-10-05)

- Settings layer like VS Code. Precedence, highest first: managed →
  `<repo>/.conductor/settings.local.toml` → `<repo>/.conductor/settings.toml` →
  `~/.conductor/settings.toml` → defaults. `[scripts] setup` / `archive` are valid
  in the user file (schema `settings.schema.json`). Legacy `conductor.json` is
  still read.
- Setup runs after Conductor creates a workspace; archive runs before it archives
  one. Both run in the workspace dir with `CONDUCTOR_WORKSPACE_PATH` set.
- **A repo-level setup/archive script overrides the user-level one.** Six repos
  on this machine already define their own (mix of
  `.conductor/settings*.toml` and legacy `conductor.json`). These need a
  per-repo local override that runs Slipstream *and* the repo's own script.
- **Unverified:** whether Conductor blocks agent start until setup succeeds.
  D1 depends on it; P3 must probe it before relying on it.
- Live workspace count: 46 ready + 11 sleeping = **57** (1,050 archived).

## Design

### Units

1. **Global install** (`tools/install-global.sh`). Clones the repo to
   `~/.local/share/slipstream`, writes `~/.local/bin/slipstream`:
   `exec <absolute node 24 path> ~/.local/share/slipstream/src/cli.ts "$@"`, and
   `~/.local/bin/slipstream-update [ref]` (fetch, checkout ref — default
   `develop` — `npm ci`, restart the daemon). Absolute Node path because
   Conductor scripts may not load nvm and Homebrew's Node is v26 (untested).
   The code lives outside `~/.slipstream` (that is the store).
2. **Multi-capture control plane** (daemon). The single slot becomes a
   session-indexed lifecycle table plus a canonical-root index. Overlapping roots
   (one root inside another) are rejected. Concurrent `attach` of the same root
   coalesces onto one capture. `detach` and `status` take a target; `status` with
   no target lists all. Every mutating verb (including task/question delivery)
   resolves and re-checks its target after each await.
3. **Watch-only capture mode.** `attach --watch-only` needs no harness identity
   and runs no transcript polling for that capture. A watch-only capture never
   accepts task declarations or questions (`SESSION_NOT_SELECTED`-class refusal)
   until a later, verified binding exists. Its `session.started` event records
   that it is watch-only, so the public log states its coverage honestly.
4. **Ensure-running.** `slipstream start --detach` is idempotent: if a live
   daemon owns the store it returns success; otherwise it spawns one and waits for
   readiness.
5. **Baseline admission.** Baselines run one at a time (bounded concurrency = 1).
   Status distinguishes `queued` / `baselining` / `ready`. `attach --wait` returns
   only once the watcher is installed and baseline reconciliation is complete.
6. **Exclusions.** A ratified directory-name list, applied at enumeration and
   observation, recorded in `session.started` as an explicit exclusion scope so
   readers can see what is not captured. Proposed list (to ratify in spec review):
   `node_modules`, `.build`, `DerivedData`, `Pods`, `build`, `dist`, `.next`,
   `.venv`, `__pycache__`, `coverage`. `.gitignore` is **not** consulted.
7. **Conductor integration.** `slipstream conductor setup` = ensure-running +
   `attach --watch-only --wait "$CONDUCTOR_WORKSPACE_PATH"`, non-zero exit with a
   readable message on failure (D1). `slipstream conductor archive` = targeted
   detach of the capture for that root (history retained, D4). Installed into
   `~/.conductor/settings.toml`. For each repo with its own script, the installer
   writes `<repo>/.conductor/settings.local.toml` chaining
   `slipstream conductor setup && <repo's own setup>` (and the archive
   equivalent), and reports drift if the repo's script later changes.

### Data flow

Conductor creates workspace → setup script → `slipstream conductor setup` →
daemon admits capture (queued → baselining → ready) → setup exits 0 → agent
starts on a fully baselined worktree. Changes flow through the existing
watcher → engine → log → reader path, per capture. Archive → targeted detach →
`slipstream.capture.stopped.v1` (new; `reason`: `detached` | `root-missing` |
`watcher-failed`); history stays in the store. Today detach appends nothing, so
a reader cannot tell a stopped capture from a quiet one; with many always-on
captures that distinction must be in the public log.

### Error handling

- Daemon unreachable, root overlaps, baseline fails → setup exits non-zero with
  the reason (D1). Never a silent half-capture.
- Root deleted or replaced under a live capture → `capture.stopped`
  (`root-missing`); the session is never re-attached to a recreated directory.
- Watcher error → existing coverage-gap path, per capture.
- Lock loss on one capture affects only that capture.

### Later units (after the minimal slice)

- **Restart recovery.** Persist each capture's intended running/stopped state
  durably; a user LaunchAgent restarts the daemon after crash/login; resume
  intended captures with existing session ids and explicit restart gaps; never
  resurrect archived ones. Reserve **all** resumable ids in the boundary
  registry before the reader is exposed; activate each after its durability
  barrier.
- **Maintenance during capture.** Delete inactive sessions while others run;
  concurrent GC needs protection spanning blob publication through event commit,
  including reuse of an existing hash.
- **Shared transcript discovery** for when enrichment is configured: one
  enumeration for all captures with per-root eligibility and identical coverage
  disclosure. Not needed for watch-only.

## Overhead measurement and gates

Measured on Brian's Mac before the control-plane change, by a harness that
starts N `CaptureSession`s in one process against one store (the library is
already multi-session). N = 0 / 1 / 10 / 57 / 136, watch-only and with
enrichment configured, cold/warm CAS, plus a dependency install inside a watched
worktree. Collect CPU, RSS/physical footprint, heap, threads, FDs, wakeups,
fsyncs, bytes read/written, baseline duration, event-loop delay, capture
latency, log/CAS growth.

Proposed gates at N = 57 (Codex proposal, **to ratify in spec review**; 136
is reported as headroom, not gated):

- 10-minute idle mean ≤ 1% of one core; p95 1-s sample ≤ 3%; ≤ 10 process
  wakeups/s.
- Total footprint ≤ 512 MiB; no sustained growth over a 24 h unchanged soak.
- No recurring worktree enumeration or content reads after settling.
- 4,200-file baseline p95 ≤ 5 s warm CAS, ≤ 15 s cold CAS.
- Existing captures: ≤ 20% p99 latency regression while another baselines.
- Zero watcher subscription failures; FDs < 50% of the soft limit.

A failed gate is written up with numbers and stops the work (CLAUDE.md); it is
never met by quietly narrowing capture.

## PR graph

| PR | Depends | Scope | Shared-behavior risk |
|---|---|---|---|
| P0 Global install | — | `tools/install-global.sh`, launcher, update command | no |
| P1 Measurement + amendments | — | N-capture harness, report, Q4 amendment in `IMPLEMENTATION_PLAN.md`, ratified gates | no |
| P2 Multi-capture + watch-only | P1 | units 2–6 | **yes** — daemon, control protocol, session, CLI; full suites |
| P3 Conductor integration | P0, P2 | unit 7; probe setup-blocks-agent | no |
| P4 Restart recovery | P2 | durable intent, LaunchAgent, registry reserve-all | **yes** — boundary registry, recovery |
| P5 Maintenance during capture | P2 | inactive delete, concurrent GC | **yes** — CAS, maintenance |
| P6 Scale acceptance | P3–P5 | gates at N = 57 + 24 h soak, public-reader parity | no |

Shared transcript discovery is deferred until enrichment is turned on for
auto-captures.

## Testing

- P2: concurrent attach/detach, same-root coalescing, overlap rejection,
  per-capture isolation (one capture's lock loss/watcher error leaves others
  healthy), targeted verbs, watch-only refusal of tasks/questions, exclusion
  disclosure in `session.started`, independent readers see each session. Full
  pre-existing daemon/session/control/reader suites (touched-area rule).
- P3: setup success/failure exit codes, archive detaches only its root,
  concurrent setups, the setup-blocks-agent probe, local-override chaining.
- P4: crash at each lifecycle transition, missing/replaced root on resume,
  archive racing restart.
- P5: publication/reuse/sweep races, disk-full, store-lock loss.

## Out of scope

npm packaging (to be published as `@playola/slipstream`; needs a build step
because Node will not strip TypeScript types inside `node_modules`), agent binding
for auto-captures, automatic retention, daemon folder discovery, Codex version
allowlist changes.
