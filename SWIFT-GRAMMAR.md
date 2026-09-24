# Swift grammar feasibility (T5a.3)

This documents whether the daemon's existing Tree-sitter WASM runtime can load
and parse Swift, report diagnostics with correct byte spans, and be cancelled.
It is a **feasibility finding**, not a production wiring. It makes **no
declaration-extraction and no comparison claim** — those are T5a.4. Nothing here
changes what the daemon launches by default.

Every number below is a **measurement on one machine**, not a budget. Budgets
require explicit sign-off (D7); none are set here.

## The artifact

| | |
|---|---|
| WASM | `tree-sitter-swift.wasm`, shipped by `tree-sitter-wasms@0.1.13` (`out/tree-sitter-swift.wasm`) |
| sha256 | `41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7` |
| Grammar | [`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift), npm `tree-sitter-swift` |
| Grammar version | `^0.4.0` (a range — see "Provenance" below) |
| Grammar license | MIT |
| Wrapper | `tree-sitter-wasms@0.1.13` |
| Wrapper license | Unlicense |
| Runtime | `web-tree-sitter@0.25.10` (the same runtime the clip parser already uses) |
| Grammar ABI | 13 (runtime supports 13–15) |

Pins are **unchanged** by this work. The sha256 is verified loudly on every
load (`verifyArtifactHash`); a mismatch throws `SwiftArtifactError` rather than
falling back. The ABI is checked both against the runtime's supported range and
against the exact pinned version (`checkAbi`).

### Provenance honesty

The exact grammar revision baked into the WASM is **not recoverable** from the
artifact, so provenance reports `revision: "unknown"`. The `^0.4.0` range is the
wrapper's declared dependency, not a proof of which commit was compiled. **The
sha256 is the real pin.** The grammar (MIT) and wrapper (Unlicense) licenses are
kept distinct and never conflated — see `THIRD-PARTY-NOTICES.md`.

## Byte spans: the UTF-16 hazard

web-tree-sitter with **string** input returns node `startIndex`/`endIndex` in
**UTF-16 code units**, not UTF-8 bytes. Empirically confirmed: an astral emoji
before `func` reports `startIndex 13` while the byte offset is `15`. Slipstream's
contract is UTF-8 byte half-open spans (D10), so `parseSwiftSource` converts
every span through `src/swift-spans.ts`:

- A single code-point pass builds a UTF-16-index → byte-offset table.
- Astral characters occupy two UTF-16 units; the surrogate-interior index is
  marked invalid, and asking for it throws `SurrogateBoundaryError` rather than
  silently returning a wrong offset.
- The converter is pure (no WASM) and unit-tested against hand-derived byte
  offsets for ASCII, astral emoji, combining marks, CJK, CRLF, and a leading BOM.

Feeding the parser a UTF-8 callback does **not** avoid this: the binding's input
callback is also UTF-16LE, so the indices are UTF-16 regardless.

## The V8 out-of-memory, and the `--liftoff-only` mitigation

Loading and parsing the ~3 MB Swift grammar **deterministically aborts a default
Node process** a second or two *after* a correct parse has already returned, with:

```
Fatal process out of memory: Zone
```

The abort happens on a **background thread inside V8's optimizing WASM compiler**
(turboshaft: `ExecuteTurboshaftWasmCompilation` → `BackgroundCompileJob::Run`),
not on the parse path. The parse result is correct; the process just dies shortly
after.

The only mitigation found is launching the process with **`node --liftoff-only`**
(single-tier baseline WASM, no optimizing tier-up). Worker threads inherit the
flag. `execArgv`, `NODE_OPTIONS`, and runtime `v8.setFlagsFromString` were all
ineffective or rejected — the flag must be set at process launch.

**Consequence for this PR — Option C.** All Swift loading and parsing is confined
to a dedicated `node --liftoff-only` child process
(`tools/swift-parse-host.ts`). The checker, the test runner, the acceptance
runner, and the daemon spawn that child and never load the grammar themselves, so
a stray parse can never take them down. Merely *importing* `src/swift-grammar.ts`
is safe — nothing initializes eagerly.

This is proven, not asserted: the `survive` operation parses and then stays alive
past the observed crash window under `--liftoff-only` (passes), and the same
operation on a **default launch** aborts (negative control — observed
`SIGTRAP`). Both run in `tools/swift-parse.test.ts` and the T5a.3 acceptance
check.

> **This is a feasibility finding, not a default-launch compatibility claim.**
> Whether production wires Swift in-process, keeps the isolated child, or does
> something else is **T5b.2's** decision, informed by this finding.

## Cancellation

A parse runs inside a terminable `worker_thread`. A synchronous parse cannot be
interrupted from inside, so cancellation is `worker.terminate()` (a hard kill).
The `cancel-demo` operation starts a pathological parse, proves it is under way,
terminates it mid-flight, then parses clean input to completion in a fresh
worker — demonstrating the runtime recovers. Proven in `tools/swift-parse.test.ts`
and the acceptance check.

## Measurements (darwin arm64, Node 24.11.0, `--liftoff-only`)

Baseline-only WASM (`--liftoff-only`), so these are the **floor** for parse
throughput, not what an optimizing tier would reach. Representative, stable
across runs:

| Phase | Time |
|---|---|
| Full child cold start (spawn → runtime init + grammar load → one parse → exit) | ~90 ms wall clock |
| Runtime init + `Language.load` (in-process, warm interpreter) | ~10 ms |
| First `parseSwiftSource` call (includes first-call warmup) | ~12 ms |
| Warm parse (same source, subsequent calls) | ~0.1–0.2 ms |

Again: **measurements, not budgets.**

## Corpus and known grammar gaps

`contracts/swift-syntax/v1/` holds 21 cases, each an `input.swift` plus a
byte-exact `expected.json`. Categories: the D2 declaration constructs, malformed
inputs (which must produce ERROR/MISSING), and Unicode edge cases.

**A gap is never hidden by dropping a fixture.** Valid Swift that parses with
ERROR nodes is kept in the corpus and disclosed as a known gap with its exact
diagnostic.

Known gap (as of this artifact):

| Fixture | Construct | Diagnostic |
|---|---|---|
| `preview-macro` | `#Preview { … }` | two `ERROR` nodes at byte span `[0,8)`, both slicing `#Preview` (a nested `ERROR` inside an `ERROR`) |

Every other D2 construct — including `@MainActor`, `async throws`, generics with
`where`, `#if DEBUG`/`#else`, and a SwiftUI `View` with a result-builder body —
parses clean under this artifact. The `#Preview` macro does not; both error nodes
are reported honestly rather than collapsed.

## Checker

```
node tools/projection-check.ts swift-parse --fixture <name>
node tools/projection-check.ts swift-parse --file <path|->
```

Prints one JSON report: artifact provenance, root type, `clean`, ERROR/MISSING
diagnostics with UTF-8 byte spans, and timings. Exit codes: **0** clean, **1**
the parse has ERROR/MISSING nodes (report still printed), **2** bad input or an
artifact/host failure (diagnostic on stderr, no report).

## Acceptance

`node tools/projection-check.ts acceptance --pr T5a.3` (darwin only) proves all of
the above live against the pinned artifact: load + sha + ABI + licenses, UTF-8
byte spans, the full corpus cross-check with the known-gap manifest, cancellation,
and OOM survival with its negative control.
