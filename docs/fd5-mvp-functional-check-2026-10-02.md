# FD5 MVP functional check — 2026-10-02

**MVP functional acceptance: FAIL; heavy-load characterization deferred; D7 not established.**

On 2026-10-01 Brian replaced the four-arm FD5 campaign as the MVP gate with this small functional
check (see the owner decision in `IMPLEMENTATION_PLAN.md` and `FD5-PROTOCOL.md`). This is a
narrower check, not a passing FD5 result. No production limit changed: interface 10,000 ms, clip
100 ms, C=2, Q=8, W=8.

The automated part ran once, for 521 ms of active time (2026-10-02T15:42:08Z–15:42:09Z), with no
retries, harness changes or production changes. It found no reader or capture defect. The native UI
rows could not be observed in that attempt, so Brian directed a second, observed run of the native
app on the same store ([run 2](#run-2-native-app-observed-by-brian)).

The verdict is **FAIL** because of one known defect found in run 2. The native app stops responding
for several seconds while a function comparison loads, so you cannot use it or close the panel
during the request. The comparison results themselves are correct.

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
| Feed and clip use in the native app | PASS (Brian's report) | See [native UI](#native-ui) and [run 2](#run-2-native-app-observed-by-brian) |
| Native comparison display | PASS (run 2) | `run2-compare-panel.png`; `run2-reader-page.json` |
| Native UI usable while a comparison loads | **FAIL** (run 2) | The app does not respond for several seconds, until the comparison finishes |
| Cancel by closing the comparison while it loads | UNVERIFIED | The frozen UI prevents clicking Close during the request; see [cancellation and recovery](#cancellation-and-recovery) |
| Close and compare again (after loading) | PASS (run 2) | Brian's report |
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

The comparison display for session `fc6cb49c` was never observed: both screenshots received
showed an unrelated board. Run 2 below observed the display on a new session instead.

### Cancellation and recovery

The script aborted request R2 at 50 ms, but R2 had already completed with 200, so the abort path was
never exercised. HTTP cancellation was not observed. In run 2 the app freezes while the comparison loads, so
Close cannot be clicked during the request, and close-to-cancel remains unobserved.

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

## Run 2: native app, observed by Brian

Brian asked for a second run so the native UI rows could be observed. It used the same revisions and
the same kept store, with new log names; nothing earlier was overwritten.

| Item | Value |
|---|---|
| Session | `051f35d8-0e61-46c3-9ec4-e8088ecf6c8b`; baseline at seq 7 |
| Edits | `loud: boolean` added to TS `greet` (seq 10) and `loud: Bool` added to Swift `greet` (seq 9) |
| Reader page (B=7, A=10) | `run2-reader-page.json`: `ready`, complete; both greets `signatureChanged` with the added parameter; helpers and probe `identical` |
| Artifacts | `qa-daemon-run2.out/err`, `app-run2-*.log`, `run2-compare-panel.png`, `run2-session-picker.png` |

Brian's observations:

1. **Comparison display: PASS.** The panel showed "Recorded at #7 → Recorded at #12" and
   "2 detected changes". It listed `MvpGreet.swift` with `name: String` unchanged and `+ loud: Bool`,
   and `mvp-greet.ts` with `name: string` unchanged and `+ loud: boolean`. No unchanged declaration
   appeared.
2. **Feed and clip with the panel open: PASS.** Clicking the clip's changed line in the feed opened
   the agent composer while the comparison panel was open. Nothing was sent.
3. **UI usable during a comparison: FAIL.** Each comparison takes multiple seconds in the app. During
   that time the app does not respond, including to feed scrolling and Close, until the comparison
   finishes. The reader answers the same request in under 300 ms, so the delay is on the client side.
   The cause was not investigated in this check.
4. **Close, then compare again: PASS.** The same two changes came back without an error.

Other native-UI findings, not failures under the brief:

- The session picker labels every session with its worktree path only. Three captures of the same
  folder look identical, so the right one could only be picked from the reader's session order.
- The Swift name `greet(name:loud:)` wraps in the middle of the declaration card.

## Follow-up: the freeze is fixed (2026-10-03)

The cause was in the native app, not the daemon. Sampling the main thread (Debug and Release)
put about 94% of the busy time in SwiftUI's `ViewThatFits`. The comparison header nested one
`ViewThatFits` inside another, and each candidate held the AppKit search field and mode picker,
so the app measured them over and over.

Client PR #17 (merged as `99c6a5e`) flattens the header into one `ViewThatFits`. In a window
shaped like the app's, the first layout dropped from 2.3–2.7 s to about 0.1 s, and a resize
from 1.3–1.7 s to about 0.03 s. A layout-timing test fails on the old header and passes on the
new one.

Brian re-checked the fixed app (`0d4fe52`, Release, same kept store) and reported it "much
better". This was an informal re-check, not a re-run of this check:

- No main-thread sample of the fixed app was kept.
- Close-to-cancel during a load is still unobserved. Comparisons on this store finish in under
  300 ms, so the panel cannot be closed mid-request by hand.

The 2026-10-02 verdict above stands as recorded.

## What this does not establish

- D7 is not established.
- No production admission value is measured or approved.
- Behaviour under heavy load stays unproven.

The two failed campaign attempts and their audit remain the only heavy-load evidence, and both
failed. Characterizing heavy load, the proposed generator and success-criterion changes, and the
instrumentation changes are all deferred.
