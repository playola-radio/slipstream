# FD5 admission measurement — failed preliminary runs

**Status: no D7 production values approved. PR #44 stays draft.** Neither run
satisfies FD5 or establishes capture safety or acceptable timeout rates. The
first ran on 2026-09-28 from the FD4 reader branch, with a test-only
400 ms interface deadline. Clip retained its 100 ms deadline. The shared
provisional capacity and queue were C=2, Q=8, W=8.

The benchmark used a newly created disposable store, 8,192 historical clip
inputs and 4,096 historical interface inputs, real watcher capture, 100
scheduled plus 100 burst writes per arm, and three rotations of baseline,
clip-only, interface-only and combined arms. Every interface request selected
one recorded file and one language (TS, TSX or Swift), with `limit=1`. Raw HTTP
response traces and arm reports are retained in the workspace's ignored
`.context/fd5-full-400.json`; they contain no reader token.

| Gate | Result |
|---|---|
| Capture writes | 2,400/2,400 observed; zero missing |
| B2 paired capture bar (p50/p99 <= 1.20x, throughput >= 0.95x) | 3/9 loaded arms passed; six failed scheduled-latency p99 |
| Clip-only sustained cold-load sufficiency | 0/3 passed; some time windows lacked a completed cold parse or overload |
| Combined clip-load sufficiency | 3/3 passed |
| Interface-only load sufficiency | 3/3 passed |
| Combined interface-load sufficiency | 1/3 passed; two runs had time windows without a ready parse and overload |

The failed scheduled-latency p99 ratios versus each repetition's baseline were:
clip-only 1.381x and combined 2.084x (repetition 1); interface-only 1.349x,
combined 1.306x and clip-only 1.222x (repetition 2); combined 1.304x
(repetition 3). No missing write was omitted from the percentiles.

Among **admitted** Swift interface requests, timeout rates were 113/152
(74.3%), 132/156 (84.6%) and 124/153 (81.0%) in interface-only; 137/140
(97.9%), 135/139 (97.1%) and 136/139 (97.8%) in combined. These count both
whole-page `skipped/timeout` and `partial` pages with a file-level timeout;
overloaded requests are excluded from the admitted denominator. TS/TSX also
timed out under combined load. Overloaded pages were counted separately and
never treated as completed comparisons.

**Limits of this run.** The Mac was shared: sampled one-minute load averages
ranged roughly 10.5–16.6, and free memory at arm boundaries ranged 0.4–3.1
GiB. This could explain the unexpectedly weak clip-only result compared with
the earlier ratified B2 run, so these numbers cannot select a production D.
The prototype has not yet covered malformed/Unicode and near-limit source,
cancellation churn, worker-retirement overlap, a large-log scan sample, or
post-shutdown child cleanup. The raw report is diagnostic evidence, not a
registered FD5 acceptance pass.

The four-arm benchmark that produced this report (`tools/fd5-bench.ts`), the
bounded diagnostic driver (`tools/fd5-diag*.ts`), the scorer
(`tools/fd5-score.ts`), the tracing observer (`tools/fd5-trace.ts`), and their
configuration (`tools/fd5-diagnostic-config.json`,
`tools/fd5-provisional-config.json`) are committed on this branch, each with
its own test file. Committing the tooling is not the same as passing FD5's
repository review gates: the scorer's timeout-rate definition and the
deadline/`C`/`Q`/`W` values it measures against have not been reviewed or
approved by Brian, and no run through this tooling is a registered FD5
acceptance pass.

Independent challenge review also identified unresolved risks: TypeScript
worker cancellation can make subsequent requests cold; a long recorded-log
scan can consume the entire page deadline; repeated deadlines while examining
hidden identical files can leave the cursor unchanged; and a timeout during
page look-ahead can return a page without a timeout marker. It also flagged
clip queue pressure under combined load and a rejected grammar-load promise
that remains cached in a TypeScript worker. The first four intersect the
approved range/deadline contract and require review before changing page
semantics. None is treated as a passed FD5 gate.

Per the repository's measurement rule, stop here with the failed gate recorded.
The next measurement needs a quiet host and the remaining FD5 cases before
Brian can approve C/Q/W/D and acceptable rates. The production reader still
uses the provisional 100 ms deadline for both workloads.

## Second run during the requested quiet window

The same four-arm prototype ran again on 2026-09-28 at test-only interface
`D=400 ms`, clip `D=100 ms`, and shared `C=2/Q=8/W=8`. It created a **new**
benchmark-owned disposable store; the raw 12-arm report is in the ignored
`.context/fd5-full-quiet-400.json`. The host was quieter at points, but sampled
one-minute load averages at arm boundaries still ranged from 6.2 to 14.7 on
the 10-logical-CPU Mac. The harness's missing FD5 cases and review gates listed
above remain missing.

| Gate | Second-run result |
|---|---|
| Capture writes | 2,400/2,400 observed; zero missing |
| B2 paired capture bar | 8/9 loaded arms passed; interface-only repetition 3 failed scheduled-latency p99 at **1.34×** its baseline (limit 1.20×) |
| Clip-only cold-load sufficiency | 0/3 passed; each had a time window without both a completed cold parse and overload |
| Interface-only load sufficiency | 2/3 passed; repetition 2 hit the 100,000-request attempt cap |
| Combined load sufficiency | 3/3 passed for clips and interfaces |

Admitted Swift interface timeout counts were 125/152, 115/148 and 132/154 in
interface-only arms (82.2%, 77.7%, 85.7%), and 135/138, 139/143 and 133/137
in combined arms (97.8%, 97.2%, 97.1%). Overloaded requests are excluded from
these denominators. No acceptable timeout-rate threshold has been approved.

The improved capture ratios show that host conditions matter, but the failed
capture arm, insufficient clip-only load, request-attempt cap and high Swift
timeout rates prevent a D7 decision. Do not select new production values or
claim FD5 complete from either run. Per the measurement rule, record the
failure and stop; Brian must decide the next measurement or design direction.
