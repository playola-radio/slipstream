# Testing conventions

Modeled on Playola's `server/src/lib` tests: real dependencies at the boundary,
one small injected seam where determinism matters, and readable nested specs.

## Framework

- **`node:test` + `node:assert/strict`.** No third-party test dependencies.
  Node 24 runs TypeScript natively, so there is no build step and tests import
  `.ts` files directly.
- Run with `npm test` (`node --test --test-concurrency=1 'src/**/*.test.ts'`).
  Concurrency is pinned to 1 on purpose — see "Why serial" below.

## Layout

- Tests are colocated: `src/foo.ts` is tested by `src/foo.test.ts`.
- Structure is `describe(unit) → describe(function/behavior) → it(scenario)`.
  The `it` name states the scenario and the expected outcome as a sentence, so a
  failure reads like a claim that was falsified.
- Shared fixtures and harnesses live in `src/test/helpers.ts`. Tests import from
  there rather than re-deriving temp dirs, stores, or log readers.

## Where we mock

The short version: **mock only at external boundaries, and we have almost none.**

- **The filesystem is exercised for real.** Capture is a filesystem observer;
  its correctness *is* its behavior against real files, FSEvents, temp dirs,
  symlinks, permission bits, and atomic renames. This is the direct analog of
  Playola running its lib tests against a real Postgres rather than a mocked
  query builder. Every `with*` helper provisions a throwaway temp worktree and a
  throwaway blob store and removes them afterward.
- **The one injected seam is the engine's `Reader`.** The engine's job is
  per-path serialization, coalescing, and compare-against-committed logic — none
  of which should depend on FSEvents timing to test. So `createEngine` takes a
  `Reader` interface and is driven by direct `notify()` calls. Unit tests pass a
  `scriptedReader([...])` (or a hand-written gated `Reader`) to make ordering and
  coalescing deterministic. This is dependency injection at a real seam, not a
  stand-in for a collaborator we were too lazy to build.
- **Nothing else is mocked.** No fake blobs, no stubbed hashing, no simulated
  clock. `node:test`'s built-in `mock` is available if a future external
  boundary (e.g. a network sink) needs stubbing, but today there is none.

Rule of thumb: if you reach for a mock, first ask whether the thing you want to
fake is an *external* boundary. If it is internal (our CAS, our log, our
snapshot logic), use the real one — a bug there is a bug we want the test to
catch.

## Two coverage levels

- **Unit** (`cas`, `snapshot`, `reader`, `log`, `engine`, `loss`): fast, real
  dependencies except the engine's injected `Reader`. These pin down each
  component's contract.
- **Integration** (`session`): a full capture session over a real worktree,
  driven by real FSEvents. Because delivery is asynchronous, these tests wait on
  observed records via `waitForRecords`/`waitFor` (polling with a deadline)
  rather than a fixed sleep, and assert on the resulting JSONL — the public
  interface — not on internal state.

## Why serial (`--test-concurrency=1`)

Each integration test holds a live FSEvents subscription. Run in parallel,
multiple subscriptions under load starve each other's event delivery and a
delete/transition test can miss its deadline. Serial execution makes the suite
deterministic (~2s locally) at a negligible wall-clock cost for this size.

## Helpers (`src/test/helpers.ts`)

- `content(sha, size?)`, `absent` — snapshot builders.
- `withTempDir`, `withCas`, `withReader`, `withLog`, `withEngine`,
  `withSession` — provision real dependencies and guarantee cleanup.
- `scriptedReader(snapshots)` — the injected `Reader` seam for engine tests.
- `readRecords`, `waitForRecords`, `changesFor` — read and filter the JSONL log.
