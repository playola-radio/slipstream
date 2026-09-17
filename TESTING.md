# Testing conventions

Modeled on Playola's `server/src/lib` tests: real dependencies at the boundary,
one small injected seam where determinism matters, and readable nested specs.

## Framework

- **`node:test` + `node:assert/strict`.** No third-party test dependencies.
  Node 24 runs TypeScript natively, so there is no build step and tests import
  `.ts` files directly.
- Run the deterministic tier with `npm test` and the real-OS tier with
  `npm run test:os` — see "Two test tiers" below. Concurrency is pinned to 1 on
  purpose — see "Why serial" below.

## Layout

- Tests are colocated: `src/foo.ts` is tested by `src/foo.test.ts`. Real-OS
  probes use the `src/foo.os.test.ts` suffix so the deterministic tier's glob
  excludes them (`src/**/!(*.os).test.ts`).
- Structure is `describe(unit) → describe(function/behavior) → it(scenario)`.
  The `it` name states the scenario and the expected outcome as a sentence, so a
  failure reads like a claim that was falsified.
- Shared fixtures and harnesses live in `src/test/helpers.ts`. Tests import from
  there rather than re-deriving temp dirs, stores, or log readers.

## Where we mock

The short version: **there is exactly one mocked boundary — the operating
system's filesystem *observation* — and it has a single, centralized fake.**

- **The OS-observation boundary is `Platform`** (`src/platform.ts`). It is the
  one surface whose behavior diverges by platform (FSEvents watches a subtree
  recursively; inotify installs per-directory watches at subscribe time and does
  not re-add them after a permission change) and whose timing is asynchronous.
  So it is the one surface worth a seam. Do not let unrelated OS calls accumulate
  in it — it is filesystem *observation* only.
- **Everything else is exercised for real.** Reading, enumerating, hashing into
  the CAS, and appending the log all run against real files in throwaway temp
  dirs. Capture's correctness *is* its behavior against real bytes, and a whole
  in-memory filesystem would be a second filesystem to maintain just to test a
  filesystem observer. This mirrors Playola running its lib tests against a real
  Postgres. Every `with*` helper provisions a throwaway worktree + blob store and
  removes them afterward.
- **One centralized fake: `createFakePlatform`** (`src/test/fake-platform.ts`).
  Non-boundary tests drive it rather than hand-rolling watcher stubs — one fake,
  owned next to the real `Platform`. It deliberately does **not** translate a
  filesystem mutation into an observation: tests mutate real files, then call
  `observe(path)` to deliver the notification explicitly. Auto-observing every
  write would encode "one notification per write" — the exact fidelity the real
  watcher cannot promise — and let a test certify a capture the OS would never
  deliver. That restraint is an honesty constraint, not an inconvenience.
- **The fake is kept honest by a contract** (`src/test/platform-contract.ts`).
  The same assertions run against both the real watcher (real-fs driver, in the
  real-OS tier) and the fake (controlled-observation driver, in the CI tier), so
  the fake cannot drift from the real boundary's path-resolution and exclusion
  semantics. The contract asserts only what both must satisfy; notification
  *sequences* (ordering, coalescing, metadata-change delivery) are platform
  capabilities, proven by the real-OS probes alone.
- **The engine's `Reader` is an internal injection seam** (not a mock of an
  external boundary). `createEngine` takes a `Reader` so per-path serialization
  and coalescing can be driven by direct `notify()` calls with a
  `scriptedReader([...])`, deterministically.
- **Nothing else is mocked.** No fake blobs, no stubbed hashing, no simulated
  clock.

Rule of thumb: if you reach for a mock, the answer is almost always the fake
`Platform`. Anything internal (CAS, log, reader, snapshot logic) uses the real
one — a bug there is a bug we want the test to catch.

## Two test tiers

- **Deterministic tier — `npm test`** (`src/**/!(*.os).test.ts`). Everything
  except the real-OS probes. Capture logic runs through `FakePlatform`, so it
  never depends on FSEvents timing or permission enforcement. This tier is what
  CI runs, and it runs honestly on both Ubuntu and macOS (portability proof).
- **Real-OS tier — `npm run test:os`** (`src/**/*.os.test.ts`). The claims the
  fake cannot prove: that real FSEvents actually delivers a change, that real
  permission transitions are observed, that rapid real writes still land the
  correct endpoint, and the real half of the `Platform` contract. Run on a
  developer Mac. Permission tests assume an **unprivileged** user (root bypasses
  mode bits); that is an environmental prerequisite, not a reason to soften an
  assertion. A failure here is a real capture gap on the supported platform and
  must not be papered over.

Both tiers wait on observed records via `waitForRecords`/`waitFor` (polling with
a deadline) rather than a fixed sleep, and assert on the resulting JSONL — the
public interface — not on internal state. `waitForRecords` **throws** on timeout;
a predicate that never holds is a real failure, never a silent pass.

## Why serial (`--test-concurrency=1`)

The real-OS tier holds live FSEvents subscriptions; run in parallel, multiple
subscriptions under load starve each other's event delivery and a
delete/transition test can miss its deadline. Serial execution keeps both tiers
deterministic at a negligible wall-clock cost for this size.

## Helpers (`src/test/helpers.ts`)

- `content(sha, size?)` — snapshot builder.
- `withTempDir`, `withCas`, `withReader`, `withLog`, `withEngine` — provision
  real dependencies and guarantee cleanup.
- `withFakeSession(setup, fn, opts?)` — a capture session driven by
  `FakePlatform`; `fn` receives `observe(path)` to deliver notifications
  explicitly. The deterministic-tier session harness. `opts.enumerate` scripts
  the baseline scan (e.g. simulate an unreadable directory without a chmod).
- `withSession(setup, fn, opts?)` — a capture session over **real** FSEvents; the
  real-OS-tier harness.
- `scriptedReader(snapshots)` — the injected `Reader` seam for engine tests.
- `readRecords`, `waitForRecords`, `changesFor` — read and filter the JSONL log.

Boundary fixtures:

- `createFakePlatform()` (`src/test/fake-platform.ts`) — the centralized fake of
  the observation boundary: `observe(path)` delivers a notification, `failWith(err)`
  drives an observation-source error. It resolves paths and applies the ignore
  list the way the real watcher does, so a test cannot rely on an observation the
  OS would never deliver.
- `describePlatformContract(label, makeHarness)` (`src/test/platform-contract.ts`)
  — the shared contract, run against both real and fake drivers.
