# FD5 Admission Measurement Implementation Plan

> **For agentic workers:** Execute the tasks in order with test-driven development and the repository's review gates.

**Goal:** Measure and approve reader admission settings that serve both languages without starving capture.

**Architecture:** Keep one shared capacity and queue. Give interface requests an internal deadline override, leaving clip at 100 ms. Extend the existing B2 benchmark and its scorer to four arms, then verify the chosen production settings through a separate authenticated QA daemon.

**Tech Stack:** Node 24, TypeScript, node:test, real watcher, worker threads, isolated Swift child, HTTP reader.

---

### Task 1: Internal deadline seam

- [ ] Add a failing admission test for an interface request with a longer deadline sharing a budget with a clip request that times out at 100 ms, including queue wait.
- [ ] Add optional internal request deadline and keep the default D unchanged.
- [ ] Add a failing reader/service test for a test-only interface deadline; wire it through without HTTP input.
- [ ] Run all pre-existing admission, clip, and interface tests, then typecheck and commit.

### Task 2: Four-arm benchmark

- [ ] Add scorer tests for per-language and per-workload status counts, missing capture, continuous load, and insufficient evidence.
- [ ] Extend the B2 corpus to TS, TSX, and Swift interface ranges with malformed and Unicode cases.
- [ ] Extend load generation to baseline, clip-only, interface-only, and combined while retaining bounded concurrency and monotonic capture timing.
- [ ] Add cancellation churn, worker retirement and process cleanup observations, cold/uncached/cache-hit samples, and a large-log range sample.
- [ ] Register the combined-load check, run smoke and full protocol, record raw data and host conditions, then commit.

### Task 3: Decision and production value

- [ ] Present paired capture results and measured timeout/overload rates by language and workload; obtain Brian's D7 numeric and acceptable-rate approval.
- [ ] Apply the approved production values only, rerun the full four-arm protocol and independent authenticated live daemon.
- [ ] Run contract validator and negative control, typecheck, source/tool/OS tests, cumulative QA, fold check, and correctness/challenge/excess reviews.
- [ ] Fix findings, update PR evidence and status, and mark PR ready only if every gate passes.
