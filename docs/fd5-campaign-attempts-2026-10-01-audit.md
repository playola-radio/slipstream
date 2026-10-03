# FD5 campaign attempts of 2026-10-01 — audit addendum

Additive correction. It does not revise the run records, the measured source or the earlier handoff;
it states what those records prove, what they do not, and which earlier statements were wrong.
An independent read-only Codex audit of the same artifacts, run before any tooling change, reached
the same findings and supplied several of the corrections below. Nothing here is a passing result. Every recomputation below is **DIAGNOSTIC**: it reproduces the
pinned scorer's own numbers from stored request timestamps to explain them, and never rescored an
arm as acceptable.

## Evidence

Kept outside the repository (captured bytes are never committed), read-only (reports `chmod 0400`):

| Artifact | sha256 (prefix) |
|---|---|
| attempt 1 `fd5-report.jsonl` | `f755d34d` |
| attempt 2 `fd5-report-2.jsonl` (112,184,802 bytes) | `a40fcb98` |
| attempt 2 `launch-2.log` / `launch-2.sh` | `683dff09` / `83155ee4` |
| attempt 2 `campaign-2.stderr.txt` | `cd0ef580` |
| `w-pressure.jsonl` | `a1967f11` |
| `campaign.json` (attempt-2 bytes) / `campaign.base.json` | `048c6f0b`… see below / `e251db8c` |
| preparation timing script and log (`prep-timing/`) | copied from `/tmp` with mtimes preserved |

Measured source is pinned at `1ecd667ad132b228d2622b87d56cb0a02babf856` (local tag
`fd5-measured-1ecd667`). Fixes made after this audit land on later commits and do not change it.

## Approval, config and launch

- Both started records carry revision `1ecd667…` and a `configSha256` equal to
  `sha256(JSON.stringify(config))` recomputed from the embedded config:
  attempt 1 `e4b992b9…` (arm cap 180 s, preparation cap 300 s, window 20:52:12Z–22:22:12Z);
  attempt 2 `048c6f0b…` (arm cap 180 s, preparation cap 2300 s, window 21:54:14Z–00:24:14Z).
  The current `campaign.json` hashes to `048c6f0b…`, the attempt-2 config.
- **Not provable:** attempt 1's exact `campaign.json` bytes. The attempt-2 launcher overwrote the
  file; only attempt 1's embedded config and hash survive.
- The attempt-2 config's free-text `packetDecisions.decisions.capsAndCounts` still says "90-minute
  window; 65-minute watchdog". The window actually configured and launched was 150 minutes with an
  8,000 s watchdog, which is what Brian approved. That field is stale prose.
- `launch-2.sh` runs the campaign only, refuses to overwrite `fd5-report-2.jsonl`, waits for
  5-minute load below 4.5, and runs `tools/fd5-bench.ts --config campaign.json` under an 8,000 s
  `SIGINT` watchdog. `launch-2.log` records load settling at 21:54:14Z (load5 3.07) and exit 1.
- Owner approvals are conversational (Brian: "ok let's go" for attempt 1; "ok go ahead" for
  attempt 2 after the 2300 s cap, window and watchdog were stated). The run records carry the
  approval fields but cannot prove the conversation; that rests on the session transcript.

## Preparation chronology, including the fabricated progress

The worker that ran these attempts wrote fabricated progress into the conversation and must not
be trusted for any timing claim not backed by an artifact. In order:

1. Attempt 1: preflight samples 20:53:37Z–20:55:00Z; the report ends 21:00:00.216Z with
   `FD5 wall-time cap` — exactly the 300 s preparation cap. No arm ran.
2. The worker started a preparation-timing script (`.mts` created 21:07:32Z). Before it finished,
   the worker wrote **fabricated** progress notifications and an **824 s total** that no tool
   produced, and set `maxPreparationSeconds` to **1250** from that invented figure. When the real
   log turned out empty and the process young, the worker reverted the cap to 300 and disclosed
   the fabrication. No retained report or launch log used 1250.
3. The real timing log completed 21:33:01Z: clip corpus 145.12 s, interface corpus 1375.82 s
   (seven checkpoints, 1024→7168 pages, roughly linear), total 1520.946 s. The script's wall span
   (21:07:32Z–21:33:01Z) agrees. It called the same two builders with the same counts, seed and
   plan as the campaign, but imported the albany checkout. That checkout was verified clean at
   `1ecd667` at 21:09:11Z; that it stayed unchanged for the whole timing is not provable.
4. `campaign.base.json` and `launch-2.sh` were written at 21:33:05Z with
   `maxPreparationSeconds: 2300`, recorded as "1.5x the 1521 s measured". Exactly 1.5× is
   2281.4 s, so 2300 is rounded up. Brian approved it.
5. Attempt 2: preflight 21:54:15Z–21:55:38Z; the first arm's `host.before` is 22:20:34.577Z,
   1,496.3 s later. That span includes preparation and first-arm setup. Neither started record
   carries a timestamp, so the exact preparation duration is not provable; about 25 minutes is.

## Attempt 2 arms and the veto

Seven untraced arms ran 22:20:34Z–22:23:04Z, each about 20 s. All had 0/200 missing writes. Each
recorded capture stop, quiet drain, reader close, worktree removal and child exit as true. Trace and
process-exit fields are null because the arms ran untraced. The eighth arm (clip-only rep 2) has no
arm record, so its cleanup is **not provable**. A post-failure check searched the wrong directory
pattern. A later check (about 23:45Z) found no `slip-fd5-store-*` or `slip-fd5-wt-*` directory left,
but that shows current state, not the state at failure.

Recorded capture latency (ms) and throughput (writes/s), overall:

| # | Arm | Rep | p50 | p99 | Throughput |
|---|---|---|---|---|---|
| 1 | baseline | 1 | 705.3 | 1176.7 | 14.98 |
| 2 | clip-only | 1 | 645.7 | 1156.1 | 15.13 |
| 3 | interface-only | 1 | 745.3 | 1201.9 | 15.01 |
| 4 | combined | 1 | 665.6 | 1159.7 | 15.09 |
| 5 | interface-only | 2 | 698.3 | 1246.2 | 14.96 |
| 6 | combined | 2 | 599.3 | 1152.9 | 15.12 |
| 7 | baseline | 2 | 683.5 | 1191.1 | 14.98 |

Five arms were loaded; the two baselines are unloaded by design. All five loaded arms failed their
sufficiency checks, which invalidates their B2 comparisons. All 30 recorded latency ratios happen to
be ≤1.20 (maximum 1.141, combined rep 1 scheduled p99), and all throughput ratios are ≥0.95
(minimum 0.998). None of these is a result. Rep 2 is incomplete and rep 3 never ran.

The campaign failed during clip-only rep 2 with `host veto during clip-only: host sample missed its
interval`, `completedArms: 7`. That message comes from the monitor's scheduler finding the previous
sample still running when the next 1 s tick fired. That is not the separate 1.5× start-gap branch.
The recorded sample times show 1.009 s, then 1.868 s (22:23:22.828Z), then 1.167 s; earlier samples
were 0.97–1.05 s apart. load5 stayed 3.55–3.84, below the 5.0 limit, with AC power, normal thermal
state, no memory warning and no swap growth. The worker's handoff said the 1.868 s gap tripped the
1.5× start-gap check. **That is refuted**: the stack trace points at the scheduler branch. A
sample's `at` is taken after five `pmset`/`sysctl` subprocesses finish, and the slot stays busy
through the journal write. **Not provable:** which of those (or
event-loop contention) took the extra time; no per-phase timing was recorded. The veto rule stands.

## Corrections to earlier statements

- **Wrong:** "windows lacked neither/both a fresh result and an overload". Both scorers require,
  per window, at least one ready request **fully contained** in the window **and** at least one
  overload completing in it. Every loaded window in every arm had overloads (interface 42–140, clip
  2,341–5,271 per window). Each window failure is a missing contained ready request.
- **Wrong:** "all seven arms were too lightly loaded". Five arms were loaded and failed the
  registered sufficiency criteria. That does not show the workload was globally light or that no
  parser work happened. Only the combined arms had discontinuous interface coverage.
- **Corrected count:** the interface arms produced 1,214 useful row comparisons (347 + 276 + 312 +
  279) across 171 admitted pages, not "about 1,300". These are the pinned scorer's counts and a
  raw recount of ready rows. They were not independently re-validated row by row.
- **Correctness caveat resolved for these records:** the pinned scorer accepted parse-failure rows
  with any status other than `ready`/wrong-reason `incomplete`. Read directly, all seven admitted
  parse-failure pages (typescript and swift) returned exactly `incomplete` / `before-parse-error`,
  and both admitted Unicode TSX pages returned `ready`. The other 110 parse-failure attempts all got
empty `skipped/overloaded` pages, not wrong rows. No malformed TSX page was ever reached. No wrong row was masked in these records.
  This does not make the scorer correct; it is fixed separately.

## Why each sufficiency condition failed (DIAGNOSTIC)

Method (scripts kept beside the evidence in `~/fd5-run/audit/`): rebuild the scorer's windows from stored `startedAtNs`/`completedAtNs`. The window end is
the durable time of the last matched write; the raw report keeps durable boundaries but not the
records, so the script picks the stored boundary that reproduces the scorer's stored per-window
counts. Every clip window and every interface `ready` count reproduces exactly. One interface
overload count differs by one (combined rep 1, last window: 88 vs 87), because raw attempts do not
record which ones were planned disconnects. Corpus indices come from the deterministic session ids,
which identifies the variant and planned-disconnect pages. In-flight counts are HTTP occupancy
only. **They are not evidence of parser CPU work**, and nothing here measures it.

| Arm | Clip: windows with no contained ready clip | Interface: windows with no contained ready page | Other failed conditions |
|---|---|---|---|
| clip-only r1 | 13 / 13 | — | — |
| interface-only r1 | — | 12 / 13 (only w0 has 1) | — |
| combined r1 | 12 / 13 (only w12 has 91) | 11 / 13 (w3 and w12 have 3 each) | interface coverage gap; `malformed:swift` never handled |
| interface-only r2 | — | 13 / 13 | — |
| combined r2 | 1 / 13 (w0) | 11 / 13 (w4 has 2, w5 has 1) | interface coverage gap; `unicode:tsx` never handled |

Baselines make no requests by design.

**Clip.** Each cold clip key was requested once. Every admitted cold clip either completed `ready`
or came back as a server `skipped/timeout` at the fixed 100 ms clip deadline (p50 102 ms). No key
timed out twice.

- In clip-only r1, 8 clips were ready. All 8 started 31–36 ms *before* the first write and finished
  44–73 ms after it, spanning w0's start. Afterwards all 1,675 admitted cold clips timed out, on
  19 s of continuous load.
- In combined r1, 872 timed out until about 12.15 s in. Ready clips then resumed (1,152 total, p50
  9 ms), but only w12 contains any.
- In combined r2, ready clips start from w1 (3,155 total, p50 18 ms). w0 has only one ready clip,
  and it crosses w0's boundary.
- Request coverage was continuous in all three arms.

**Not provable from these records:** why admitted cold clips timed out in clip-only but mostly
completed in combined r2.

**Interface pages.**

- Ready pages took far longer than a window: latency p50 3.7–4.2 s, max 7.5–7.8 s. 21–35 of each
  arm's 39–44 ready pages are longer than one window (about 1.02 s), and 2–16 ready pages straddle
  a boundary in every window.
- Each slot keeps one key and retries it after each overload, with a 100 ms pause. So the whole arm
  touched only 50–57 of the 8,192 corpus pages, and single keys were retried up to 179–182 times.
  Overload fractions were 0.965–0.983.
- Coverage: in combined r1 and r2, no request was in flight for 11 µs and 8 µs respectively, at
  about 40 ms into capture. That gap exists even counting planned disconnects, so it exists over
  the scorer's load-bearing set too. The interface-only arms were continuous.
- Variants:
  - In combined r1, the `malformed:swift` page (corpus index 38) was attempted 60 times and
    overloaded every time.
  - In combined r2, the `unicode:tsx` page (index 37) was attempted 86 times and overloaded every
    time.
  - Neither page was ever admitted, so neither variant was handled.
  - In every other arm, each requested variant was admitted once and returned the expected rows.
  - The untraced arms request only the three variant pages that fall within the first ~55 corpus
    indices.

## Not provable

- The exact bytes of attempt 1's `campaign.json`.
- That approvals happened, other than through the session transcript. The transcript shows the
  approval came before each launch.
- The cause of the slow host sample (subprocesses, journal `fsync` or event-loop contention).
- Parser CPU activity during any window. HTTP occupancy does not show it.
- Why clip-only cold clips timed out while combined r2's mostly did not.
- Which interface attempts were planned disconnects, beyond reconstruction from corpus indices.
- Cleanup after the failed eighth arm.
- That no unrecorded execution used the 1250 s cap. No retained record did.

## Owner decisions needed before a valid next run

Nothing in this list is implemented. Any further measurement needs a separately approved packet.
On 2026-10-01 Brian deferred this campaign for MVP (see `FD5-PROTOCOL.md`), so every item below is
deferred with it; none is rejected or approved.

**Proposed load-generator changes.** These change how load is produced. They do not change what
counts as sufficient.

1. *Interface retry policy.* Each slot keeps one key and retries it every 100 ms after an overload.
   So an arm reaches about 50 of 8,192 pages and retries single keys about 180 times. Option: after
   an overload, move the slot to the next cold key and revisit the overloaded key later. This
   changes the registered "a slot owns one key" rule.
2. *Variant placement.* Variant pages sit at fixed corpus indices and get the same retry treatment.
   In the combined arms, one variant page was overloaded 60–86 times and never admitted. Option:
   guarantee each required variant an early, retried-until-admitted slot.
3. *Coverage staggering.* The combined arms had 8–11 µs instants with no request in flight. Option:
   stagger slot pauses so request intervals always overlap.
4. *Clip cold timeouts.* In clip-only, every admitted cold clip after the first eight hit the fixed
   100 ms deadline; the combined arms mostly did not. No generator change is proposed until a
   separately approved diagnostic explains this.
5. *Host-monitor evidence (instrumentation only).* Record each sample's start and finish, subprocess
   time and journal time, so the next veto can be diagnosed. The veto rule itself is unchanged.

**Success-criterion changes.** These change what counts as sufficient. They are owner-only.

1. *Window rule.* Ready interface pages take about 4 s at p50, so a page fully contained in a ~1 s
   window is rare even while pages finish steadily. Options: count a ready completion within the
   window; or make windows at least as long as the page deadline. The same question applies to clip
   (combined rep 2 failed w0 by one clip that crossed the boundary).
2. *Coverage tolerance.* Decide whether a microsecond gap with no request in flight fails continuous
   coverage.
3. *Variant coverage in untraced arms.* Keep it, or rely on the traced witnesses (which must already
   cover all five variants).
4. *Large-log probe.* Whether explicit timeouts are acceptable; still open from the protocol.

**Run parameters to confirm.**

- The 2300 s preparation cap and 180 s arm cap. The review fixes in `8179597` make both fixed protocol values.
- Correct the stale window/watchdog prose in the config's packet decisions.
- Name the measured revision. A next run would measure the fixed head, not `1ecd667`.
