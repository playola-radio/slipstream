# B2 measurement and parser crash recovery

Date: 2026-09-19.
**Status: IN PROGRESS. Native crash reproduced and WASM replacement implemented;
a new full measurement and numeric-bar ratification remain required. B2 is not
complete; the D3 gate has not passed.**

## Authorized recovery

Brian authorized changing the tree-sitter binding, including WASM, on 2026-09-19,
while preserving the capture design and budgets. A subprocess reproducer now
terminates/replaces a worker 20 times while it repeatedly parses/indexes a
1,000-line TypeScript function. With a 20 ms cancellation delay the native binding
aborts the subprocess with the same uncaught `Napi::Error`/SIGABRT. This establishes
worker cancellation during active extraction as a trigger; it does not isolate
which native call throws.

`clip.v3` replaces the native addon with pinned `web-tree-sitter` 0.25.10 and
`tree-sitter-wasms` 0.1.13. WASM initialization and grammar loading remain inside
the existing worker job's 100 ms deadline. Each parse has a 20 ms cooperative
progress callback; each tree and parser is freed after indexing. Capture, pool,
admission, input and output ceilings are unchanged. The cancellation regression
now passes, as do all 73 clip tests and typecheck; the full deterministic suite passes 637/637 tests. The two oversized selection
cases listed below also have regression tests and fixes.

Completed benchmark repetitions now emit a JSON line between arms, retaining
finished results if a later repetition fails. No logging was added inside a
measured capture interval.

## Historical native run

Revision measured: `fba33e8`. The following records the initial failed run and
stop disposition; it is not a result for the WASM implementation.

The predefined protocol is in `CLIP-LATENCY-PROTOCOL.md`. The full run used
`node src/clip-bench.ts` on Node 24.11.0, macOS arm64, Apple M1 Max (10 logical
CPUs). Other work was active on the host; starting load averages were
14.06 / 13.28 / 13.34. No review jobs were started alongside this run.

### Full-run failure

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

### Earlier smoke evidence (not the acceptance gate)

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

### Work retained at the initial stop

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
