> **Viability: no watcher failure was measured, but two items need Brian's ruling
> before P2 starts.** Of 27 gate rows, 15 PASS, 9 FAIL and 3 are INCONCLUSIVE.
> - The baseline FAILs and the chat-CPU FAILs have code and counter evidence
>   pointing at code a later PR replaces (P2, P5).
> - **Ruling 1:** the 10-chat latency FAIL is attributed only by comparing
>   scenarios. The same test passed with no chats, and nothing traced where the
>   slow writes waited. Under D6 an unattributed miss stops the feature.
> - **Ruling 2:** total idle wakeups with no chats, a watcher-intrinsic gate, are
>   INCONCLUSIVE. The only proven lower bound without sudo, `top` IDLEW, is
>   0.01/s at 16 captures, far below 10/s. But the main thread ran 7.1 timer
>   callbacks/s at 16 (12.9/s at 32), driven by 2-s lock heartbeats. In an
>   idle process each is probably a wakeup; that is not proven, so it is not a
>   bound.
>
> This is not the D8 verdict; that is judged at P6 on the finished system.

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
proper is judged at P6 on the finished system. The bench ran **once**, and
the two rulings above decide whether P2 may start.

Reproduce: `npm run bench:autocapture`. Raw results: `docs/autocapture/raw/2026-10-17/results.json`
and `gates.md` next to it. Every temp directory is deleted at the end of the run.

## Viability verdict

The spec's split (D6, confirmed by Brian 2026-10-17): a miss in the watcher itself
stops the feature, any other miss becomes an acceptance item on the PR that owns its
cause, and a miss that cannot be attributed stops the feature.

**The watcher itself, at the 16-capture limit, with no chats (`n16-c0`):**

| Watcher-intrinsic check | Result |
|---|---|
| subscription failures, start failures, watcher-error gaps, lock compromises | 0 in every fleet (16 / 16 / 16 / 0 / 1 / 32 captures, 0 failed starts) |
| file descriptors | 33 at 16 captures (17 with none, +1 per capture; 49 at 32) against a soft limit of 1,048,576 |
| memory | 142 MiB footprint at 16 (81 MiB with none; 165 MiB at 32), limit 512 MiB |
| idle CPU | 0.59% mean / 0.90% p95 at 16 (0.02% with none, 0.83% at 32), limits 1% / 3% |
| recurring worktree reads after settling | 0 listings, stats, reads or git spawns in the window |
| wakeups | INCONCLUSIVE: proven lower bound (`top` IDLEW) 0.01/s at 16 against 10/s; timer callbacks 7.1/s at 16 (12.9/s at 32) are likely but unproven wakeups; the total is not measured |

No watcher-intrinsic failure was shown by anything measured. Total wakeups with no
chats are unknown: the 0.01/s `top` IDLEW lower bound neither proves nor disproves the
10/s limit, and the 7.1/s timer-callback rate suggests the total is closer to the
limit than that bound implies.
Whether P2 may start before that is measured is **Ruling 2**. Measuring it needs
`sudo powermetrics` on the subject; see "Wakeups".

**Each FAIL and its proposed owner:**

| FAIL | Measured | Evidence | Proposed owner |
|---|---|---|---|
| 4,200-file baseline p95, warm ≤ 5 s and cold ≤ 15 s (c0 and c10) | 93.8 s warm / 91.3 s cold (c0); 81.9 / 81.1 s (c10) | `createCas` runs once per capture session (`src/session.ts:241`). Its `put` (`src/cas.ts:97`) republishes every blob missing from that session's in-memory `durable` set, with a temp write, file fsync, rename and shard-directory fsync, even when the blob is already on disk. So warm and cold starts both rewrite every blob, which matches their near-equal times. Component times were not recorded: a baseline also enumerates, reads, hashes, and appends one durable log record per file. The ~20 ms per file (4,200 files in ~90 s; the one-capture fleet's 2,574-file worktree in 49 s) is total amortized start time, not measured CAS time. | **P2** (owns concurrent captures and the shared store) |
| idle CPU mean and p95 with 1 emulated chat (`n16-c1`) | 22.4% / 35.3% | Each emulated chat runs today's per-capture transcript runtime, which re-scans the Codex rollout directory (3,500 files, none matching). Transcript file opens rose from 0/s (c0) to 849/s. No CPU profile was taken, so the share of CPU this explains is inferred, not measured. | **P5** (shared transcript discovery) |
| idle CPU mean and p95 with 10 emulated chats (`n16-c10`) | 111.7% / 221.4% | Transcript opens 5,383/s (about 538 per chat). CPU follows the chat count, not the capture count: c0 is 0.59% with the same 16 captures. Same inference caveat. | **P5** |
| p99 write latency regression while another capture baselines, with 10 emulated chats (`latency-c10`) | +30.5% (p99 216 → 281 ms; the slowest capture's p99, arm B over arm A, +33%); 0 of 1,800 writes lost; 100% of arm-B writes beside a baseline | The same baseline loop cost +5.6% with no chats (`latency-c0`, PASS). The emulated chats are the designed difference between the two scenarios, but they ran an hour apart on a changing host, with different target captures (8 vs 6), and nothing traced where writes waited. Event-loop delay in arm B: p99 12 ms, max 79 ms. **This attribution is a hypothesis, not a measurement (Ruling 1).** | **P5 with P2**, if Brian accepts the attribution |

c0 runs watch-only captures with no transcript runtime. It is the closest
reference for the intended binding-only linked chat, but it does not measure the
finished linked-chat configuration. c0 failed only the baseline gate.

## Every D8 gate measured on today's code (N=16)

| Gate | Scenario | Threshold | Measured | Verdict |
|---|---|---|---|---|
| idle CPU mean | n16-c0 | <= 1% | 0.59% (process cpuUsage 0.63%) | PASS |
| idle CPU p95 of 1-s samples | n16-c0 | <= 3% | 0.90% | PASS |
| process wakeups/s | n16-c0 | <= 10/s | >= 7.1/s (lower bound: top IDLEW 0.0, main-thread timer wakeups 7.1); upper bound unmeasured | INCONCLUSIVE |
| physical footprint | n16-c0 | <= 512 MiB | 142 MiB max | PASS |
| no recurring worktree enumeration/reads after settling (main-thread JS scope; native watcher I/O untraced) | n16-c0 | 0 calls | 0 worktree listings/stats/reads + git spawns (plus 0 path resolutions) | PASS |
| FDs vs soft limit | n16-c0 | < 50% of 1048576 | 33 | PASS |
| watcher subscription failures | n16-c0 | 0 | 0 | PASS |
| idle CPU mean | n16-c1 | <= 1% | 22.39% (process cpuUsage 21.95%) | FAIL |
| idle CPU p95 of 1-s samples | n16-c1 | <= 3% | 35.30% | FAIL |
| process wakeups/s | n16-c1 | <= 10/s | >= 7.3/s (lower bound: top IDLEW 0.7, main-thread timer wakeups 7.3); upper bound unmeasured | INCONCLUSIVE |
| physical footprint | n16-c1 | <= 512 MiB | 217 MiB max | PASS |
| no recurring worktree enumeration/reads after settling (main-thread JS scope; native watcher I/O untraced) | n16-c1 | 0 calls | 0 worktree listings/stats/reads + git spawns (plus 465 path resolutions) | PASS |
| FDs vs soft limit | n16-c1 | < 50% of 1048576 | 33 | PASS |
| watcher subscription failures | n16-c1 | 0 | 0 | PASS |
| idle CPU mean | n16-c10 | <= 1% | 111.74% (process cpuUsage 113.73%) | FAIL |
| idle CPU p95 of 1-s samples | n16-c10 | <= 3% | 221.40% | FAIL |
| process wakeups/s | n16-c10 | <= 10/s | >= 6.8/s (lower bound: top IDLEW 0.4, main-thread timer wakeups 6.8); upper bound unmeasured | INCONCLUSIVE |
| physical footprint | n16-c10 | <= 512 MiB | 248 MiB max | PASS |
| no recurring worktree enumeration/reads after settling (main-thread JS scope; native watcher I/O untraced) | n16-c10 | 0 calls | 0 worktree listings/stats/reads + git spawns (plus 2870 path resolutions) | PASS |
| FDs vs soft limit | n16-c10 | < 50% of 1048576 | 33 | PASS |
| watcher subscription failures | n16-c10 | 0 | 0 | PASS |
| 4,200-file baseline p95, warm CAS | baseline-c0 | <= 5 s | 93.82 s (n=10) | FAIL |
| 4,200-file baseline p95, cold CAS | baseline-c0 | <= 15 s | 91.26 s (n=10) | FAIL |
| 4,200-file baseline p95, warm CAS | baseline-c10 | <= 5 s | 81.88 s (n=10) | FAIL |
| 4,200-file baseline p95, cold CAS | baseline-c10 | <= 15 s | 81.06 s (n=10) | FAIL |
| p99 latency regression while another baselines | latency-c0 | <= 20% | 5.6% (p99 241 -> 254 ms); missing A 0/1200, B 0/600; arm B under a baseline 100.0% | PASS |
| p99 latency regression while another baselines | latency-c10 | <= 20% | 30.5% (p99 216 -> 281 ms); missing A 0/1200, B 0/600; arm B under a baseline 100.0% | FAIL |

`gates.md` is generated by the harness and copied here unedited. The install
window and the 0 / 1 / 32 fleets have no gate rows; they are reported under Results.

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
scenario is the closest reference for the supported configuration: watch-only
captures with no transcript runtime. It does not run bindings or P5's shared
discovery, so it does not measure the finished linked-chat configuration.

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
| `n16-c0` | 16 | 0 | 600-sample idle window | N=16; watch-only; enrichment off; the reference for the binding-only configuration |
| `n16-c1` | 16 | 1 | 600-sample idle window | enrichment configured, one linked chat |
| `n16-c10` | 16 | 10 | 600-sample idle window | enrichment configured, ten linked chats |
| `baseline-c0`, `baseline-c10` | 16 + 1 | 0 / 10 | 10 cold and 10 warm starts of the 4,200-file worktree, each rep in a fresh store; event-loop delay across them | cold vs warm CAS; baseline gate |
| `latency-c0`, `latency-c10` | 16 | 0 / 10 | write-to-durable latency on 8 captures (6 at c10: the non-chat captures), arms A1 (quiet) / B (another capture baselining) / A2 (quiet) | p99 regression gate; capture latency |
| `install` | 16 | 0 | `npm ci --offline` into a gitignored `node_modules` in one watched worktree, 240-sample window | dependency install |
| `n0-c0`, `n1-c0`, `n32-c0` | 0 / 1 / 32 | 0 | 120-sample idle window | N=0/1 scaling; N=32 headroom (twice the limit) |

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
| wakeups/s | lower bound only: `top` IDLEW; main-thread timer callbacks more than 1 ms apart are diagnostic only | Timer callbacks do not prove a thread slept and woke between callbacks. Interrupt wakeups need `proc_pid_rusage` (native code) or `powermetrics` (sudo). Upper bound UNMEASURED, so this gate can only be FAIL or INCONCLUSIVE. |
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

Brian's working machine, not an isolated bench host. The run took 2 h 54 min, from
13:50 to 16:44 CDT on 2026-10-17.

- Apple M1 Max, 10 cores, 64 GB RAM.
- macOS 26.5.2; Node v24.11.0.
- Load average (1 / 5 / 15 min) was 7.34 / 6.78 / 6.96 when the run started and
  3.61 / 8.30 / 12.48 when it ended. Only those two were recorded, so load during
  the run is unknown. `memory_pressure` reported 47% of memory free system-wide.
  On AC power, with no thermal warning recorded. (All from `results.json`.)
- Observed by hand just before the run, not archived: up 44 days; internal APFS
  SSD. Other processes running: several Conductor agent sessions (one at ~20% of a core
  at the start), a WebKit page (15–87% of a core across the minutes before the
  start), and an XProtect scan that ended before the run began.
- A colima VM (Docker runtime) was up but idle: 0.0% CPU, 0 containers. It
  reserves memory but adds no measurable CPU.

Other activity on the machine can move these measurements in either direction.
This run does not establish what a quieter machine would show.

## Results

### Scaling with the number of captures (no chats, idle)

| Captures | CPU mean (`top`) | CPU p95 | footprint | FDs | lock heartbeats/s | timer wakeups/s (lower bound) | window |
|---|---|---|---|---|---|---|---|
| 0 | 0.02% | 0.1% | 81 MiB | 17 | 0.5 | 0.5 | 223 s |
| 1 | 0.03% | 0.1% | 93 MiB | 18 | 1.0 | 1.0 | 216 s |
| 16 | 0.59% | 0.9% | 142 MiB | 33 | 8.5 | 7.1 | 1,149 s |
| 32 | 0.83% | 1.0% | 165 MiB | 49 | 16.5 | 12.9 | 210 s |

"window" is the elapsed time. The harness asks `top` for 120 or 600 one-second
samples, but on this loaded machine each sample took about 1.9 s, so windows ran
about twice their nominal length. The c1 and c10 windows ran 1,097 s and 1,067 s.
CPU and timer-callback rates are per elapsed second. **Correction (no re-run):**
the published raw `top` IDLEW rates divided cumulative counter deltas by nominal
one-second intervals, not elapsed time. From `results.json`, the c0 derivation
is `0.02 × 599 / 1,148.698358625 = 0.0104/s`; c1 is
`0.7 × 599 / 1,097.074961 = 0.3824/s`; c10 is
`0.4233333333 × 599 / 1,067.400387 = 0.2377/s`. The raw evidence and generated
gate table are preserved unchanged; the harness now divides by measured elapsed
time for future runs. Timer callbacks are a diagnostic rate, not a wakeup lower
bound, so neither correction changes the published INCONCLUSIVE verdicts. The
maximum thread count in any idle window was 13–15. No idle window wrote to the
store, fsynced, or grew a log.

### Wakeups

Every capture holds its own `owner.lock` with a 2-second heartbeat (a `readFile`
plus a `utimes`), and the store holds one more: 0.5/s per lock, 8.5/s at 16
captures, 16.5/s at 32. Timer callbacks were 7.1/s at 16 and 12.9/s at 32, but
they are not process-wakeup lower bounds. The corrected `top` IDLEW observations
are lower bounds only; the true total is not measured; see Ruling 2. P2 builds the
capture table that owns these locks, so it is the natural place to keep this from
growing with every capture. The total needs `sudo powermetrics`, and P6 needs it
for the D8 verdict.

### Capture start

Fleet starts are sequential (one baseline slot). Median start was 9.5 s at c0,
9.3 s at c1 and 8.4 s at c10. The slowest start in each fleet took 48–59 s. The three
16-capture fleets use the same 16 worktrees, the largest with 2,574 files; the
32-capture fleet's largest has 2,622. Starts were not recorded per worktree, so
which one was slowest is not known. By the log timestamps, starting 16 captures
took about 4 minutes and starting 32 about 10.

### Baselines (4,200 files, 10 cold and 10 warm, each in a fresh store)

| Fleet | cold (s) | warm (s) | event-loop delay p99 / max |
|---|---|---|---|
| beside 16 captures, 0 chats | 89.9–91.3 | 90.9–93.8 | 15 ms / 278 ms |
| beside 16 captures, 10 chats | 74.1–81.1 | 74.3–81.9 | 12 ms / 88 ms |

The fastest of 40 runs (74 s) is 15 times the warm limit, so 10 repetitions
instead of 30 (objection 24) does not change the verdict. The c10 runs being
faster than c0 is unexplained. They ran about an hour and a half later; load
during either set is unknown. It does not change any verdict.

### Write latency (one write every 200 ms, round-robin; 120 s per arm)

| Fleet | arm | writes | lost | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| c0, 8 targets | A (A1 + A2, quiet) | 1,200 | 0 | 197 ms | 213 ms | 241 ms | 507 ms |
| c0 | B (beside a baseline) | 600 | 0 | 206 ms | 227 ms | 254 ms | 277 ms |
| c10, 6 targets | A | 1,200 | 0 | 191 ms | 206 ms | 216 ms | 293 ms |
| c10 | B | 600 | 0 | 199 ms | 225 ms | 281 ms | 343 ms |

Arm B ran beside 3 complete baselines in each fleet, covering 100% of its writes.
A1 and A2 p99 were 230 / 244 ms at c0 and 215 / 216 ms at c10. These summaries
do not rule out drift within an arm. The ~200 ms median is the same in both arms. This run does
not break it down.

### Dependency install inside a watched worktree

`npm ci --offline --ignore-scripts` wrote 453 files into the gitignored
`node_modules` of one of the 16 watched worktrees in 0.8 s. Over the 463-s window
the process averaged 0.53% CPU (p95 0.8%), appended no events, read no worktree
files and fsynced nothing. It spawned git 4 times. No gaps.

## Not measured

- **Interrupt and total wakeups**: no-sudo tools only. `powermetrics` needs sudo
  and was not run. Only the corrected `top` IDLEW lower bound is reported; timer
  callbacks are diagnostic only.
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
| 18 | `top` IDLEW is not total wakeups. | Reported as the only lower bound; timer callbacks are diagnostic only. The gate is INCONCLUSIVE unless that lower bound already fails. |
| 19 | A bare `CaptureSession` loop misses the daemon's shared reader. | The subject runs the real reader with the daemon's registry wiring. The control server is omitted and disclosed. |
| 20 | "No recurring reads" needs evidence, not CPU. | fs and spawn probes classify every main-thread call by path; scope disclosed. |
| 21 | Gate on the supported (binding-only) configuration; emulation is a diagnostic. | Both are reported. c0 is the reference for the supported configuration (watch-only, no transcript runtime); c1 and c10 are the brief's emulated chats. See "Viability verdict". |
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
