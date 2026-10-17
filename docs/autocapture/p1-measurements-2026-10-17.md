<!-- RESULT-BANNER -->

# P1: what it costs to record every workspace (measurements, 2026-10-17)

This report covers PR 1 of 6 for workspace auto-capture
(`docs/superpowers/specs/2026-10-05-workspace-auto-capture-design.md`). It
measures today's capture code running many captures in one process and checks
the result against the D8 gates the spec ratified. No product code changed. The
numbers say whether one daemon can carry the 16-capture limit (spec D10); they do
not tune it.

This run is the **viability check** that gates P2 (spec D6 split, 2026-10-17): a
miss in the watcher itself stops the feature; every other miss is attributed to
the PR that owns its cause and becomes that PR's acceptance item. The D8 verdict
proper is judged at P6 on the finished system. The bench ran **once**.

Reproduce: `npm run bench:autocapture`. Raw results: `docs/autocapture/raw/2026-10-17/results.json`
and `gates.md` next to it. Every temp directory is deleted at the end of the run.

## Viability verdict

<!-- VIABILITY -->

## Every D8 gate measured on today's code (N=16)

<!-- GATE-TABLE -->

## Method

### What runs

One Node process (`tools/autocapture-bench/subject.ts`) holds what a shared
daemon would hold, minus its control server:

- one store lock and **one** store shared by every capture in the run, as the
  shared daemon will hold it (the baseline repetitions each get a fresh store so
  "cold" means cold);
- the real shared reader (`startReaderServer` with a boundary registry, the same
  wiring as `src/daemon.ts`), so its timers and worker pools are in the
  measurement;
- N `CaptureSession`s from `startCapture`, started one at a time (the spec's
  single baseline slot).

The daemon itself is not changed and not started. The control server is left out
because no control traffic happens in a measured window; P2's control plane is
not measured here.

A parent process (`cli.ts`) drives the subject over IPC, samples it with
`top`, writes the workload, and never talks to the subject inside an idle
window except to take the snapshot at each edge.

### Emulated linked chat (stated explicitly)

The spec's supported configuration links a chat by **binding only**: no
per-capture transcript runtime (P5 fixes that). Today's code has no binding, so
the closest real cost is a capture started the way a chat attach starts one
today: with a configured transcript runtime for both harnesses (`claude-code`
and `codex`, enrichment sources `configured`), pointed at synthetic transcript
homes. That is the per-capture CoverageRunner **worst case** P5 removes. Each
"chat" in the c1 and c10 scenarios is one such capture among the 16. The c0
scenario is therefore also the measurement of the supported configuration
(binding-only links add no capture-side work).

Synthetic transcript homes: one Claude project directory with one transcript
per worktree, and 3,500 Codex rollouts (the real `~/.codex/sessions` held 3,516
on 2026-10-17; only the count was read) whose `session_meta.cwd` matches nothing
(so every Codex scan walks the full default scan limit of 2,000 files and finds
no match, the expensive path).

### Synthetic worktrees

Never the real workspaces. Sizes come from a read-only sample of
`~/conductor/workspaces/*/*` taken 2026-10-17 (`tools/autocapture-bench/plan.ts`):

- file counts of 48 real git worktrees (git-tracked plus untracked-not-ignored),
  drawn with a fixed seed for each synthetic worktree;
- a log2 histogram of the 50,751 real file sizes in those worktrees; each synthetic file draws a bucket
  by frequency and a size uniform within it;
- one extra worktree with exactly 4,200 files for the baseline gate.

Contents are seeded random bytes with a unique header per file, so the CAS
cannot deduplicate across files. Every worktree is a real git repository
(`git init`, one commit) with `node_modules/` in `.gitignore`. One worktree also
carries this repo's `package.json` and `package-lock.json` for the install
scenario.

### Scenarios

| Scenario | Captures | Emulated chats | What it measures | Brief item it covers |
|---|---|---|---|---|
| `n16-c0` | 16 | 0 | 10-min idle window | N=16; watch-only; enrichment off; the supported binding-only configuration |
| `n16-c1` | 16 | 1 | 10-min idle window | enrichment configured, one linked chat |
| `n16-c10` | 16 | 10 | 10-min idle window | enrichment configured, ten linked chats |
| `baseline-c0`, `baseline-c10` | 16 + 1 | 0 / 10 | 10 cold and 10 warm starts of the 4,200-file worktree, each rep in a fresh store; event-loop delay across them | cold vs warm CAS; baseline gate |
| `latency-c0`, `latency-c10` | 16 | 0 / 10 | write-to-durable latency on 8 captures (6 at c10: the non-chat captures), arms A1 (quiet) / B (another capture baselining) / A2 (quiet) | p99 regression gate; capture latency |
| `install` | 16 | 0 | `npm ci --offline` into a gitignored `node_modules` in one watched worktree, 240-s window | dependency install |
| `n0-c0`, `n1-c0`, `n32-c0` | 0 / 1 / 32 | 0 | 120-s idle window | N=0/1 scaling; N=32 headroom (twice the limit) |

The c1 fleet runs only its idle window: baseline and latency are measured at the
two ends (c0 and c10). There is no "every capture enriched" scenario: c10
already measures the per-chat cost and the headroom fleet the per-capture cost.

Settling before an idle window: wait 30 s after the last capture started, then
require the sum of durable seqs, the count of worktree listings/stats/reads, and
git spawns to stay unchanged for 10 s (polled every 5 s, capped at 5 min). Path
resolutions (`realpath`, `access`, `exists`) are left out of the settle
signature because the emulated chats resolve the worktree path on every
transcript scan forever; they are still counted and reported in the
recurring-reads row.

Each chat count starts its fleet of N captures once and runs its windows
against it in order (idle, baselines, latency, install), because each capture
start takes several seconds on this host. The headroom fleets (N = 0, 1, 32, no
chats) run idle windows only, of `--diag-idle-seconds` (120 s).

### What each metric is and how it was taken

| Metric | Source | Notes |
|---|---|---|
| CPU mean / p95 | `top -l N -s 1 -pid P` 1-s samples, first sample dropped | Mean cross-checked against `process.cpuUsage()` over the window; the gate uses the larger. |
| wakeups/s | lower bound only: max(`top` IDLEW, main-thread timer callbacks more than 1 ms apart) | Interrupt wakeups need `proc_pid_rusage` (native code) or `powermetrics` (sudo). Upper bound UNMEASURED, so this gate can only be FAIL or INCONCLUSIVE. |
| footprint | `top` MEM (phys_footprint), max over the window | |
| heap, RSS | `process.memoryUsage()` at the window's end | |
| threads | `top` TH, max | |
| FDs | entries in `/dev/fd` of the subject, vs `ulimit -Sn` | |
| fs calls, fsyncs, bytes | wrappers on `node:fs`, `node:fs/promises`, `FileHandle`, installed before any product module loads, classified by path (worktree, store, lock, transcript, other) | Main-thread JS only. Native watcher (FSEvents) I/O, libuv internals, and the reader's worker threads are not traced. |
| block I/O | `process.resourceUsage()` fsRead/fsWrite | Kernel block operations, not bytes. |
| git spawns | wrappers on `node:child_process` | |
| baseline duration | wall time of `startCapture` (resolves after baseline and the durability barrier) | |
| event-loop delay | `monitorEventLoopDelay` (10 ms resolution) | |
| capture latency | write time in the parent to the moment the subject's health reports the durable seq of the matching `file.changed` (matched by content hash) | Both processes use the same monotonic clock. |
| log / CAS growth | bytes under `sessions/` and `blobs/` before and after each window | |
| lock heartbeat I/O | `readFile` + `utimes` calls on `owner.lock` files per second | |

## Machine

<!-- MACHINE -->

## Results

<!-- RESULTS -->

## Not measured

- **Interrupt and total wakeups**: no-sudo tools only. `powermetrics` needs sudo
  and was not run. Only lower bounds are reported.
- **Kernel disk bytes**: no-sudo tools give block operation counts
  (`resourceUsage`), not bytes. Bytes are the JS-visible reads and writes.
- **Native watcher and worker-thread I/O**: not traced (see the metric table).
  The "no recurring reads" gate covers main-thread JS calls and git spawns only.
- **Cold OS page cache**: purging needs sudo. "Cold" means a store that has never
  held the bytes (cold CAS); the files themselves are in the page cache.
- **24-hour soak**: not run. P6 owns it.
- **Daemon control server and LaunchAgent**: not built yet (P2, P3).

## Codex measurement objections and how they were handled

From the same Architect consult recorded in `contracts.md` (objections 18 to 31).

| # | Objection | Resolution |
|---|---|---|
| 18 | `top` IDLEW is not total wakeups. | Reported as a lower bound with the timer count; the gate is INCONCLUSIVE unless the lower bound already fails. |
| 19 | A bare `CaptureSession` loop misses the daemon's shared reader. | The subject runs the real reader with the daemon's registry wiring. The control server is omitted and disclosed. |
| 20 | "No recurring reads" needs evidence, not CPU. | fs and spawn probes classify every main-thread call by path; scope disclosed. |
| 21 | Gate on the supported (binding-only) configuration; emulation is a diagnostic. | Both are reported. c0 is the supported configuration; c1 and c10 are the brief's emulated chats. See "Emulation versus the supported configuration". |
| 22 | Latency on one capture hides per-capture variance. | 8 write targets (6 at c10) among 16 captures; aggregate and worst-capture p99. |
| 23 | Timestamp-based latency matching is fragile. | Writes matched to events by content hash. |
| 24 | Too few baseline repetitions for a p95. | Partly declined: 10 cold and 10 warm, not 30. One repetition takes about 140 s on this host, so 30 would add over an hour. With 10 samples the reported p95 is the maximum, which errs toward FAIL; see the baseline result for how far the fastest run sits from the threshold. |
| 25 | fsyncs and bytes must be split by store and worktree. | Probes classify per path class. |
| 26 | Uniform file sizes misrepresent CAS cost. | Real size histogram. |
| 27 | A failed capture start must not be silently dropped. | Start failures, watcher-error gaps, and compromise callbacks all count against the watcher gate. |
| 28 | Settling by a fixed sleep can measure the tail of baselining. | Signature-based settle. |
| 29 | `top`'s first sample is since-boot. | Dropped; mean cross-checked with `cpuUsage`. |
| 30 | A synthetic install does not exercise the ignore path realistically. | Real `npm ci --offline` of this repo's lockfile, with a labeled fallback. |
| 31 | Record the machine. | Machine section and `results.json`. |

A second Codex pass reviewed the harness for measurement validity before the one
run (findings 32 to 38, all fixed in the harness before it ran; a re-review found
four of the fixes incomplete, and the rows below describe the final fix):

| # | Objection | Resolution |
|---|---|---|
| 32 | The latency gate scored only the writes that survived; 599 lost writes could still PASS. | A lost write's latency is unknown, so it brackets the regression: the pass bound counts arm B's lost writes as unboundedly slow (and arm A's as instant), the fail bound the reverse. A pass needs the pass bound to pass. |
| 33 | Baseline coverage summed durations, so a long last baseline could hide gaps. | Coverage is the share of arm-B writes stamped inside a baseline's own interval (start until `startCapture` resolves; the stop after it is excluded); under 95% is INCONCLUSIVE. |
| 34 | A window measured after settling gave up still got a normal verdict. | Leftover startup work can only add cost, so an unsettled window keeps a pass on a cost gate but turns a failure into INCONCLUSIVE; the latency comparison is INCONCLUSIVE either way. Watcher subscription failures are exempt: an observed failure stands. Each downgraded row says so. |
| 35 | Empty measurements compared `null <= threshold` and passed. | Absent or non-finite values are UNMEASURED; numeric arguments must be positive integers. |
| 36 | A failed baseline loop could hang the run. | The loop returns its error with the runs so far; subject requests reject on exit or after 15 min. |
| 37 | A stop could delete the temp dir while git, npm or `top` still wrote into it. | Every child is tracked, the stop flag is checked before any child is created (so none is abandoned), and all are killed and awaited before deletion. |
| 38 | File-handle writes (the lock heartbeat) counted zero bytes. | Counted from the handle call's own data argument; covered by a test. |

## Conductor launch behavior: pending Brian's run

Documentation only; D1 (revised) does not depend on the answer. Slipstream did
not change any Conductor settings. The probe is
`tools/autocapture-bench/conductor-probe.sh`; the steps are in the PR's QA
section and repeated here.

Questions:

1. Does the agent start, and accept a message, before a setup script finishes?
2. Does a setup script that exits non-zero show as failed, and does the agent
   still start?
3. Which environment variables does a setup script see?
4. Does a repo's `.conductor/settings.local.toml` setup script override the user
   `~/.conductor/settings.toml` one?

Steps (Brian runs these; each one is reversible):

1. Make a throwaway repo and add it to Conductor as a project:
   `mkdir ~/probe-repo && cd ~/probe-repo && git init && git commit --allow-empty -m init`.
2. **User-level run.** Back up `~/.conductor/settings.toml`, then add under
   `[scripts]`:
   `setup = "/abs/path/to/slipstream/tools/autocapture-bench/conductor-probe.sh user 60 0"`.
   (While this is in place, any new workspace in a repo without its own setup
   script runs the probe too: it sleeps 60 s and logs, nothing else.)
3. Create a workspace in `probe-repo`. Note the wall-clock time the workspace
   appears, the time the agent first accepts a message (send "run date"), and
   whether the UI shows setup as running. Answer Q1 from the log's
   `started`/`ended` against those times.
4. Change the arguments to `user 5 3` and create another workspace. Note how the
   failure is shown and whether the agent starts anyway (Q2).
5. **Repo-level override.** In `~/probe-repo` only, create
   `.conductor/settings.local.toml` with
   `[scripts]` `setup = "/abs/path/…/conductor-probe.sh repo-local 5 0"`.
   Create a third workspace. If the new log's label is `repo-local` and no `user`
   log appeared for it, the repo file overrides the user file (Q4).
6. Q3: the `CONDUCTOR_*` values and all variable names are in every log under
   `~/slipstream-conductor-probe/`.
7. Restore `~/.conductor/settings.toml` from the backup, archive the probe
   workspaces, and delete `~/probe-repo`.

Results: **pending Brian's run.**

| Question | Answer | Evidence |
|---|---|---|
| Q1 agent before setup ends | pending | |
| Q2 non-zero exit shown as failed | pending | |
| Q3 environment variables | pending | |
| Q4 repo-local overrides user | pending | |
