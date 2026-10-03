# FD5 MVP functional acceptance — 2026-10-03

**MVP functional acceptance: PASS; heavy-load characterization deferred; D7 not established.**

This is the orchestrator's disposition under Brian's 2026-10-01 acceptance-scope change (see the
owner decision in `IMPLEMENTATION_PLAN.md` and `FD5-PROTOCOL.md`). It is a separate result from the
2026-10-02 check, which remains **FAIL** for the native layout freeze present at that time
(`docs/fd5-mvp-functional-check-2026-10-02.md`). This result incorporates the merged freeze fix,
Brian's observed improvement, the layout regression test and focused post-fix client evidence. It
does not retroactively change the failed run, and it is not acceptance of performance under
arbitrary load.

## Revisions and scope

| Item | Value |
|---|---|
| Daemon tested | `35b792606e2e03978f57b90cd9eb4f9d03a8fb59` (PR #46 merge, includes FD4) |
| Product client base | `0bbec6fbda6afe6356ea4bc8d688a4ffd002fbce` (includes client PR #17 freeze fix and PR #18 session labels) |
| Live test revision | `494e3018a030e5f2da61062ba048e2318d2e4718` (client base plus acceptance-test changes) |
| Client PR #19 final head | `27892059c2522573cd9350de037de0468695cd62` |
| Client PR #19 merge | `1b49d84c4db98fe90b0ac01986270cc8039ddf8c` into client develop, 2026-10-03T16:40:08Z |

The merge was verified independently, and CI on the PR #19 head had already passed.

The diff `494e301..2789205` changes only `LiveFunctionAcceptanceTests.swift`. It adds mode
validation and setup documentation, lets unused inventory metadata be absent outside `ready` mode
while still requiring it for `ready`, and keeps duplicates in the inventory comparison. Product code
is unchanged, so no further live run is needed to accept the product evidence. No live execution is
claimed at `2789205`. The worker reports the full viewer suite as 207 passed on the final head; this
was not rerun independently.

## Evidence reviewed

Artifacts are kept outside the repository in `~/fd5-postfix-20261003/`. No bearer configuration is
copied into this record. The following are the evidence files used here, named relative to that
directory and pinned by SHA-256:

| File | SHA-256 |
|---|---|
| `RESULT.md` | `403ebb66af136183af89dacacf2f162ab359efa07caa86c6f82d501473ac40d9` |
| `summary.json` | `1dcb41e925a928ef5c21bd7a6df0695ec4d14073fd402698a049579ab0720747` |
| `app-ready-pre-restart.log` | `7bc398c441fe02c2c847fd28aef808ecbeb95d9523e6839ea4bec1ea3002a121` |
| `app-ready-post-restart.log` | `1760c4aab25275a806a3e60517eb3c1a2d46bb4d33e45f67588a0452a4709a00` |
| `app-blob-loss.log` | `6f242be33931da6cfcb77a6d2882c73f44001df72177478752c1bd87e6b623bf` |
| `app-session-removed.log` | `bdf7b2a5a43d03aeb8a6423eaa684957a7b2b863723af6aa4d6bd2c502f1a0de` |
| `model-tests.log` | `8a21989c9f03dad264ba0d197e506df922f816ea96105850ea8efc090ddfafee` |
| `viewer-full.log` | `bbcc57fa8369cd4d18a7794745529e7542ed24157217f6a36d1d38490963443b` |

- **Live invocations.** Each of the four invocations (ready before restart, ready after restart,
  blob loss, session removed) was counted independently: one test passed and two intentional skips.
  The suite as a whole was not skipped.
- **Deterministic model tests:** 4 passed.
- **Original full-suite log:** 206 passed; the three expected environment-gated live tests skipped.
- **`summary.json`:** four distinct returned paths, two identical files and two changed
  declarations; SHA-256 `1dcb41e925a928ef5c21bd7a6df0695ec4d14073fd402698a049579ab0720747`. The
  worker checked source hashes and UTF-8 spans against the written bytes independently. No hash or
  span mismatch was reported.

## What is accepted

- Correct live TypeScript and Swift comparisons, with provenance.
- Model-side restart through a new descriptor.
- A `partial` page after blob loss.
- Real `410` / session-removed behaviour.
- Deterministic cancellation that rejects a late page and reloads.
- The layout regression test (client PR #17).
- Brian's post-fix observation that the native app is responsive, reused from 2026-10-03.

The earlier valid capture and clip evidence stays referenced from the 2026-10-02 report. The
restart proof (a fresh test process) and the fake `401` refresh proof are separate results; neither
is claimed as an observed in-process live reconnect.

## What is not verified

- The native app's visual presentation of restart, blob loss and `410` was not observed. This stays
  explicitly unverified at the visual level. It does not block acceptance under the focused post-fix
  brief at
  `/Users/brian/conductor/workspaces/slipstream-client-swift/hangzhou-v2/.context/orchestrate-feature/function-changes/brief-mvp-postfix-client-check.md`
  (outside git). That brief requires a dated, commit-pinned result for the selected live and model
  rows, explicit PASS/FAIL/UNVERIFIED levels and counts, preservation of the 2026-10-02 FAIL, and no
  performance claim. For cancellation, it replaces the manual close-during-a-sub-300-ms-load race
  with the deterministic `cancellationPreventsLatePageFromPublishing` test: the late page is rejected
  and the comparison reloads successfully. The app-model live behaviour and earlier native
  responsiveness evidence meet those focused criteria.
- A manual sub-300 ms close-to-cancel and a post-fix main-thread profile were not required and were
  not captured.
- The header overflowing in a narrow window remains follow-up work.

## What this does not establish

- D7 is not established.
- No production admission value is measured or approved.
- Behaviour under heavy load stays unproven; heavy-load characterization is deferred.

No production limit changed: interface 10,000 ms, clip 100 ms, C=2, Q=8, W=8. No additional
experiment, benchmark, test campaign or production policy change was run or is required for this
acceptance. The 2026-10-02 FAIL, the two failed campaign attempts and their audit
(`docs/fd5-campaign-attempts-2026-10-01-audit.md`) are preserved unchanged.
