# B2 measurement: blocked by native parser process abort

Date: 2026-09-19. Revision measured: `fba33e8`.
**Status: BLOCKED. B2 is not complete; the D3 gate has not passed.**

The predefined protocol is in `CLIP-LATENCY-PROTOCOL.md`. The full run used
`node src/clip-bench.ts` on Node 24.11.0, macOS arm64, Apple M1 Max (10 logical
CPUs). Other work was active on the host; starting load averages were
14.06 / 13.28 / 13.34. No review jobs were started alongside this run.

## Full-run failure

The process aborted with exit code **134** during saturation:

```text
libc++abi: terminating due to uncaught exception of type Napi::Error
```

The macOS crash report records `SIGABRT`, faulting thread 14, and three
`tree-sitter.node` frames immediately below the C++ throw/termination frames.
This identifies the native parser addon as the crash site. The precise triggering
call is not yet isolated; worker cancellation or a particular syntax-node access
must not be asserted as the cause without a reproducer.

The persisted synthetic test artifacts contain 200 `file.changed` records in
each of the first four live sessions, then 99 in the fifth. The harness runs
three baseline repetitions followed by three saturation repetitions: the crash
therefore occurred in the second saturation repetition. This is a count of
committed records, **not** a recovered write-to-durable latency measurement.

The harness emits its aggregate JSON only after all repetitions. The abort lost
the in-memory durable timestamps and partially collected reports; stdout is
empty. Full-protocol p50/p99, throughput and skipped totals are **unavailable**.
They cannot be reconstructed from event timestamps, which mean observation time.
No numeric latency bar was proposed or ratified, and no passing verdict is claimed.

A native abort in a worker thread kills the capture process too. The existing
worker isolation and 100 ms deadline therefore did not contain this parser
failure. Per the project's measurement stop rule, implementation stops here;
there is no automatic parser replacement, budget increase, capture-source change,
or success-criterion revision.

## Earlier smoke evidence (not the acceptance gate)

The smoke run used four scheduled writes and a ten-file burst, one repetition
per arm. Both arms captured 14/14 expected writes, with zero missing samples.

| Metric | Baseline | Saturation |
| --- | ---: | ---: |
| Combined durable latency p50 | 333.45 ms | 370.38 ms |
| Combined durable latency p99 | 444.62 ms | 475.07 ms |
| Scheduled p50 / p99 (n=4) | 112.34 / 391.41 ms | 132.76 / 468.77 ms |
| Burst p50 / p99 (n=10) | 350.39 / 444.62 ms | 382.14 / 475.07 ms |
| Capture throughput | 17.15 changes/s | 16.26 changes/s |

Saturation maintained 16 HTTP slots and requested 1,028 unique content keys.
Responses: 102 ready, 1 fallback, 925 skipped; reasons included 922 overloads
and 4 timeouts (one timeout returned fallback). There were no request errors or
corpus exhaustion; 29 ready request intervals overlapped live capture. Clip
request p50/p99 was 12.31/388.46 ms, including HTTP and queue waiting.

These smoke samples establish integration and load overlap only. They are too
small and do not meet the three-repetition full protocol; they cannot ratify D3.

## Work retained and remaining

- `clip.v2` extraction, language-aware inputs/cache, schema, documentation and
  tests are committed in `3cf56d4`; the measurement harness is in `fba33e8`.
- Typecheck and 631 deterministic tests passed before the full run. Those checks
  did not exercise enough sustained load to reveal the native process abort.
- Two additional selection cases need regression tests and review: a bounded
  function hidden by an oversized fallback-context line, and a bounded fallback
  hidden by an oversized function-header line. Neither has been silently fixed
  while measuring the committed revision.
- Final adversarial review, challenge, Excess Audit, a valid full measurement,
  numeric-bar ratification, PR creation and review fixing remain outstanding.

Raw benchmark output/error and host metadata are retained under `.context/`;
the smoke result is `/tmp/slipstream-clip-bench-smoke.json`. The local macOS crash
report is `~/Library/Logs/DiagnosticReports/node-2026-09-19-155040.ips`.
Synthetic temporary artifacts left by the abort are retained for diagnosis.
No captured logs or blobs are committed.
