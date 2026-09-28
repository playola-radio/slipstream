# FD5 admission measurement — failed preliminary run

**Status: no D7 production values approved. PR #44 stays draft.** This run does
not satisfy FD5 and must not be used to claim capture safety or acceptable
timeout rates. It ran on 2026-09-28 from the FD4 reader branch, with a test-only
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

Per the repository's measurement rule, stop here with the failed gate recorded.
The next measurement needs a quiet host and the remaining FD5 cases before
Brian can approve C/Q/W/D and acceptable rates. The production reader still
uses the provisional 100 ms deadline for both workloads.
