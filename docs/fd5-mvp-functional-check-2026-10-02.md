# FD5 MVP functional check — 2026-10-02

**MVP functional acceptance: UNVERIFIED; heavy-load characterization deferred; D7 not established.**

On 2026-10-01 Brian replaced the four-arm FD5 campaign as the MVP gate with this small functional
check (see the owner decision in `IMPLEMENTATION_PLAN.md` and `FD5-PROTOCOL.md`). This is a
narrower check, not a passing FD5 result. No production limit changed: interface 10,000 ms, clip
100 ms, C=2, Q=8, W=8.

The check made one attempt with no retries, harness changes or production changes. The automated
part ran for 521 ms of active time (2026-10-02T15:42:08Z–15:42:09Z). It found no product defect.
The overall verdict is UNVERIFIED because nobody observed the native UI rows or the cancellation
row (see below). It is not PASS.

## Setup

| Item | Value |
|---|---|
| Daemon | `9856c11d102e23662511b9d2f107ce00c856ea68` (develop, FD4 merge #44) |
| Client | `64b8481a00b3a4baff1211b96b2d743a451098a8` (client develop, FS3 merge #16) |
| Store | Disposable `qa-daemon --keep` root; never the user's `~/.slipstream` |
| Session | `fc6cb49c-e72b-48b5-bb7c-9851dd9fbcc0`; baseline at seq 7 |

Both revisions were exported with `git archive`, so `qa-env.json` reports
`daemon_commit: unknown, dirty: true`; `REVISIONS.txt` records the real ones. A separate seeding
session (`a1da8432-…`) created the fixture files after an empty baseline, so in that session every
function correctly shows as *added*.

The fixtures hold one TS and one Swift `greet` whose parameter type changes (`number`→`string`,
`Int`→`String`), an unchanged `add` in each language, and a `probe` function edited during the
check.

## Evidence

Kept outside the repository (it contains captured source bytes) in `~/fd5-mvp-20261002/`:

- **Single-attempt script and its output:** `mvp-check.mjs`, `mvp-check.out`, `mvp-check-result.json`
- **Reader summary given to the app test:** `mvp-reader-summary.json`
- **Native model tests:** `native-model-tests.log`, plus its `.xcresult` path
- **Reader page as the app would request it (B=7, A=16):** `post-ui-reader-page-7-16.json`
- **Clip body for seq 10:** `post-exercise-clip-10.json`
- **Daemon output:** `qa-daemon*.out/err`
- **Revisions and build log:** `REVISIONS.txt`, `client-build.log`

## Results

| Check | Verdict | Evidence |
|---|---|---|
| TS/Swift comparison at frozen cutoffs (B=7, A=10) | PASS | See [comparison detail](#comparison-detail) |
| App model matches the independent reader | PASS, with a harness caveat | See [app model vs reader](#app-model-vs-reader) |
| Capture continues while a comparison is pending | PASS (literal criterion) | See [continued capture](#continued-capture) |
| Normal clip use | PASS | `mvp-check-result.json` `clips`; `post-exercise-clip-10.json` |
| Feed and clip use in the native app | PASS (Brian's report) | See [native UI](#native-ui) |
| Native comparison display for session `fc6cb49c` | UNVERIFIED | Both screenshots received were an unrelated board, not the panel |
| Native UI responsive while a comparison loads | UNVERIFIED | Loads finish in under 300 ms here, so there was nothing to observe |
| Cancel by closing or changing the comparison | UNVERIFIED | See [cancellation and recovery](#cancellation-and-recovery) |
| A new comparison completes after the cancel attempt | PASS | See [cancellation and recovery](#cancellation-and-recovery) |
| Capture is healthy after the cancel attempt | PASS | Probe edit 2 durable at seq 12 with the expected sha `546c9680…` |
| Stale responses are discarded | PASS (existing automated test) | See [stale responses](#stale-responses) |
| Restart, blob loss and 410 | Reused FS3 evidence (reader side only) | See [reused FS3 evidence](#reused-fs3-evidence-and-a-correction) |

### Comparison detail

`mvp-check-result.json` `comparison`. The reader returned `ready`, complete, with one
`signatureChanged` row per greet file:

- **TS file:** `number`→`string`. Before/after snapshot sha `936e07f2…` / `e09c2e10…`, spans
  0–68 / 0–60.
- **Swift file:** `Int`→`String`. Before/after snapshot sha `4101df33…` / `059bba24…`, spans
  0–48 / 0–43.

Every hash equals the sha256 of the bytes that were written. The span text is exactly each `greet`
declaration.

The script recorded one fault: it expected only the two greet paths. With `include_identical=true`
the reader also returns the unchanged files (helpers and probe) as `identical` with no changes.
That fault is the script's wrong expectation, not a product defect.

### App model vs reader

`native-model-tests.log`, `LiveFunctionAcceptanceTests.liveAppModelMatchesIndependentAuthenticatedConsumer`.

This live app-model test ran against the store and recorded one issue at `:82`. The app model holds
three more paths than `mvp-reader-summary.json`, which lists only the two fixture paths. Those three
paths (`MvpHelpers.swift`, `mvp-helpers.ts`, `mvp-probe.ts`) are exactly the files the reader itself
returned as `identical`.

Everything else the test checks passed:

- complete and ready;
- 2 detected changes;
- 0 files not compared;
- session, B and A for each file;
- before and after sha256;
- byte ranges.

The test is reported here as failed, not hidden; the cause is the script's summary, not the app.

### Continued capture

`mvp-check-result.json` `continuedCapture`. The timeline of the attempt:

| Time | Event |
|---|---|
| 79 ms | Comparison request R1 started |
| 231 ms | Probe edit written; R1 still pending |
| 262 ms | R1 settled |
| 339 ms | Probe edit observed durable at seq 11 with the expected sha `bd51d333…` |

The edit was made during the pending request and became durable with the expected hash. The check
did not show the edit becoming durable *before* the comparison finished, because comparisons finish
in under 300 ms on this load.

### Native UI

Brian operated the native app; I had no screen-capture or accessibility access, and changing that
is out of scope.

He reported that the feed responded. He also saw a compare panel with two greets, two adds and one
probe. That panel was for the seeding session, where every function is newly added, so it is
correct for that session.

The comparison display for session `fc6cb49c` is still unobserved. The expected display is three
signature changes: TS `greet`, Swift `greet` and `probe`. The two `add` functions are hidden unless
"Show unchanged branches" is on. `post-ui-reader-page-7-16.json` holds the reader page the app
would request.

### Cancellation and recovery

The script aborted request R2 at 50 ms, but R2 had already completed with 200, so the abort path was
never exercised. HTTP cancellation and close-to-cancel in the app were not observed.

Existing automated coverage passed in `native-model-tests.log`:
`SlipstreamViewerTests/Views/Pages/FunctionChangesPage/FunctionChangesLiveTests.swift:248`,
`cancellationPreventsLatePageFromPublishing`, at client `64b8481`.

The new comparison after the cancel attempt (R3, B=7, A=11) completed `ready`. It showed
`signatureChanged` for both greets and for `probe`, the helpers as `identical`, and a probe sha that
matches.

### Stale responses

Covered by an existing automated test, which passed in `native-model-tests.log`:
`SlipstreamViewerTests/Views/Pages/ChangeStreamPage/ChangeStreamPageTests.swift:347`,
`staleCardLoadIsDiscardedAfterSessionSwitch`, at client `64b8481`. The
`cancellationPreventsLatePageFromPublishing` test (above) also passed.

### Clip behaviour

The clips for seq 10 (TS greet edit) and seq 11 (probe edit) both returned 200 with `clip.v3`
status `fallback` and reason `no-enclosing-function`. Both edits sit on a single line that is the
whole declaration, so this is the expected result.

### Reused FS3 evidence, and a correction

This is reused evidence from the FS3 client workspace, `slipstream-client-swift/fs3/.context/`,
and was not re-run here:

- `fs3-live-http.json`
- `fs3-restart-evidence.json`
- `fs3-live-after-loss.json`
- `fs3-tombstone-gc.json`

It covers the reader side of restart, blob loss and 410.

**Correction:** the matching native logs show the app-side live test **skipped**:

- `fs3-live-native.log`
- `fs3-live-after-restart-native.log`
- `fs3-live-blob-loss-native.log`

Each one says `Suite LiveFunctionAcceptanceTests skipped: "Set SLIPSTREAM_FS3_ACCEPTANCE …"`.
xcodebuild only passes the variables to the test runner with a `TEST_RUNNER_` prefix. Those logs are
not evidence that the app handled restart, blob loss or 410. This check did not re-test those
cases in the app.

## Manual steps to close the UNVERIFIED UI rows

The store is kept. Start the daemon and the app with new log names so the earlier logs are
preserved:

```sh
cd ~/fd5-mvp-20261002/daemon-9856c11 && node tools/qa-daemon.ts --root ~/fd5-mvp-20261002/qa2 --reuse --keep \
  > ~/fd5-mvp-20261002/qa-daemon-manual.out 2> ~/fd5-mvp-20261002/qa-daemon-manual.err &
cd ~/fd5-mvp-20261002 && SLIPSTREAM_STORE=$PWD/qa2/store \
  client-dd/Build/Products/Debug/SlipstreamViewer.app/Contents/MacOS/SlipstreamViewer
```

Restarting opens a new capture session as well. Select session `fc6cb49c…` (the one with the greet
edits, not the seeding one), then:

1. Click **Compare functions**. You should see three signature changes: `greet` in
   `mvp-greet.ts` (`number`→`string`), `greet` in `MvpGreet.swift` (`Int`→`String`) and `probe`.
   Neither `add` should appear until "Show unchanged branches" is turned on.
2. While the panel is open, scroll the feed and open a clip to confirm the UI stays usable.
3. Click **Close**, then **Compare functions** again. The same result should load without an
   error.

Quit the app and press Ctrl-C in the daemon terminal when done. Each row stays UNVERIFIED until it
is reported.

## What this does not establish

- D7 is not established.
- No production admission value is measured or approved.
- Behaviour under heavy load stays unproven.

The two failed campaign attempts and their audit remain the only heavy-load evidence, and both
failed. Characterizing heavy load, the proposed generator and success-criterion changes, and the
instrumentation changes are all deferred.
