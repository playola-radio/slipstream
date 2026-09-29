# FD5 bounded diagnostic interface scoring v2

This document describes the diagnostic harness only. It does not change the public
interface reader, production admission settings, D7 decision, or the registered
FD5 campaign.

The checked-in `fd5-diagnostic-config.json` uses protocol
`fd5-bounded-diagnostic.v2-proposal` and interface scorer
`terminal200-first180-v2`. Its approval fields remain unset. A new measurement
window and execution approval are required before any run. Prior reports must
match the current head, config hash, and scorer version; a v1 report cannot
authorize the next v2 mode. The original 2026-09-29 overhead report remains a
failed v1 report. Reinterpreting its data is diagnostic only because its cohort
was not declared before execution.

For each overhead interface arm, the harness records the same first 180 corpus
source identities before any arm starts. Corpus order yields ten identities in
each of the 18 language (TypeScript, TSX, Swift), source size (tiny,
representative), and page size (1, 4, 16) cells. The source key and full
expected request identity determine membership. Response status and duration
cannot change it. Every arm must produce exactly one terminal observation per
identity. Missing identities, duplicates, mismatched source identities, HTTP
errors, client errors, missing terminal duration, malformed responses, and an
arm that ends before all 180 requests are invalid. The report records the exact
shortfall. Limits and arm duration do not expand to make up a shortfall.

The gate compares nearest-rank p50, p95, and p99 of elapsed client HTTP response
duration for all 180 terminal HTTP 200 responses, including ready, partial, and
skipped pages. Limits remain 1.05, 1.10, and 1.20. The ready count uses the
same fixed population and retains the 0.95 on/off minimum. An off arm with zero
ready results is invalid; an on arm with zero ready results against a positive
off count fails normally. Capture latency, throughput, clip request scoring,
host controls, request caps, corpus caps, and worker behavior remain unchanged.

The report retains every request outside the cohort and summarizes full-arm
outcomes and HTTP durations. It also records every planned source's outcome,
reason, timing and per-cell summary, plus same-key off/on transitions and timing
contrasts. Ten observations per cell are descriptive; they are not independent
tail gates. The old pooled ready-only latency is labelled as a legacy
diagnostic and cannot set the v2 interface verdict. Extra requests may differ
between arms and never affect cohort membership; equal additional load is not
assumed.

HTTP response duration is measured for a completed HTTP 200 response even when
the page reports timeout or cancellation. Completion time for interrupted
useful work is unknown and is reported as unfinished. Parse, unsupported, and
unavailable outcomes are explicit failures, not censored successful timings.
No completion-time percentile or censored percentile estimator is used.
