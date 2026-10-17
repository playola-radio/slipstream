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
