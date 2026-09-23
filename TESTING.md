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

## Live QA harness (`npm run qa:daemon` / `npm run qa:check`)

This is **live-daemon acceptance**, complementary to — not a replacement for —
`npm test`, `npm run test:os`, and `npm run typecheck`. Where the unit tiers prove
capture correctness against real bytes, the QA harness proves the *whole public
path* end to end: a real daemon, the runtime-descriptor bootstrap, and the HTTP
reader (finite + SSE), exactly as an external client (e.g. the macOS viewer)
would consume them. It consumes only the public reader API and the descriptor —
never a daemon back channel — and it never changes daemon/reader behavior.

### `npm run qa:daemon` — a one-command local Slipstream

Starts a real in-process daemon under an **owner-only sandbox root** (default
`~/.slipstream-qa/local`, with sibling `store/` and `worktree/`), attaches the
sandbox worktree with a synthetic identity (harness `qa`, session `qa:<run-id>`),
discovers the reader's URL + token from `<store>/runtime/*.json`, optionally seeds
a scenario of real files, and prints paste-ready curl commands. It writes an
owner-only `<root>/qa-env.json` (`{format:"slipstream-qa.v1", state, run_id,
daemon_commit, store, worktree, descriptor_path, url, token, session_id,
ready_through_seq, scenario}`) — QA bookkeeping, not a substitute for the
descriptor bootstrap.

```
npm run qa:daemon -- --scenario T-QA     # seed a real create+modify, then idle for curling
npm run qa:daemon -- --root ./sandbox    # override the root
npm run qa:daemon -- --keep              # retain the root after Ctrl-C
npm run qa:daemon -- --reuse             # reuse a harness-owned root; new session, retained history
```

Flags: `--root <dir>`, `--scenario <name>`, `--keep`, `--reuse`. Default mode
requires a **fresh** root and removes it on Ctrl-C / SIGTERM; `--keep` and
`--reuse` retain it, and a failed shutdown always retains it and reports why.

Safety (mirrors the daemon's own posture): an ownership marker in the root,
canonical-path checks that **refuse `~/.slipstream` and any overlapping path**, and
a control-socket liveness probe that refuses a root whose daemon is live or whose
ownership is ambiguous. The harness never deletes anything it did not create.

**Point the macOS client at it:** use the printed `store` path — the client
bootstraps from `<store>/runtime/*.json` the same way the harness does. For
example, after `npm run qa:daemon`, the descriptor is the newest JSON under
`<root>/store/runtime/`, and the reader lives at the printed URL.

### `npm run qa:check` — acceptance runner

Runs registered acceptance modules against a live daemon and prints exactly one
JSON report to stdout (`slipstream-qa-report.v1`); all progress goes to stderr and
**the bearer token is never printed**.

```
npm run qa:check -- --all                       # run every registered check
npm run qa:check -- --pr T-QA                    # run one check
npm run qa:check -- --pr T-QA --env <qa-env.json> # run against an already-running qa:daemon
```

Without `--env`, the runner starts its own isolated daemon from the current
checkout. With `--env`, it runs against the daemon that wrote that env file and
**rejects it if `daemon_commit` differs from the checked-out HEAD**. Exit codes:
`0` all assertions passed, `1` a check ran and failed (assertion / durability
deadline / cleanup), `2` bad args / missing check / wrong platform / stale daemon
revision, `130` interrupted. A skipped check never counts as passing.

### Acceptance-module contract

A module lives at `tools/qa/acceptance/<ID>.ts` and exports an object with `id`, an
optional seed `scenario`, an optional `requiresPlatform`, and
`run({worktree, sessionId, reader, signal}): Promise<{assertions: Array<{id, claim,
evidence}>}>`. The runner owns lifecycle (start/attach/deadlines/printing); `run`
only writes real files into `worktree`, awaits their exact public observation via
`tools/qa-support.ts`, and throws on any failed claim. Register it in
`tools/qa/acceptance/registry.ts`.

**How "ready" is proven (the durability core, `awaitObservedChange`):** after a
real write, the harness awaits a public `file.changed` record matching the
worktree-relative path, `observation: "watcher"`, and the expected before/after
snapshot tags; requires that record's seq ≤ the finite response's
`slipstream-durable-seq`; and independently re-computes the SHA-256 and fetches the
served blob to compare exact bytes. A rising high-water alone proves nothing; a
timeout FAILS. The `T-QA` negative-control assertion exercises exactly this: an
intentionally wrong expected hash must hit the deadline rather than report ready.

### Cleanup

`qa:daemon` removes its owned root on a clean default shutdown (retained under
`--keep`/`--reuse` or on a failed shutdown). `qa:check` spawns each daemon under a
throwaway temp root and tears it down after the run, including on failure.

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
