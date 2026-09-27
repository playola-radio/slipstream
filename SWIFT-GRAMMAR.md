# Swift grammar feasibility (T5a.3)

This documents whether the daemon's existing Tree-sitter WASM runtime can load
and parse Swift, report diagnostics with correct byte spans, and be cancelled.
It is a **feasibility finding**, not a production wiring. It makes **no
declaration-extraction and no comparison claim** — those are T5a.4. Nothing here
changes what the daemon launches by default.

The later FD2 extraction built on this feasibility work is documented in
`SWIFT-INTERFACE.md`; the measurements and isolation findings below remain
the basis for its grammar boundary.

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
is safe — nothing initializes eagerly, not even resolving the artifact path (a
missing install surfaces as the host's exit-2 artifact failure, never an uncaught
throw during import).

The boundary is **enforced, not merely conventional**: `loadSwiftLanguage`
refuses to run unless the process was launched with `--liftoff-only`
(inherited by worker threads), throwing `SwiftArtifactError` instead of aborting
the host a second later. The only escape is the `SLIPSTREAM_SWIFT_ALLOW_UNISOLATED`
env var, which *only* the OOM negative control sets so it can reach the load and
prove the default launch really does abort.

This is proven, not asserted: the `survive` operation parses and then stays alive
past the observed crash window under `--liftoff-only` (passes), and the same
operation on a **default launch** aborts (negative control — observed
`SIGTRAP`). Both run in `tools/swift-parse.test.ts` and the T5a.3 acceptance
check.

> **This is a feasibility finding, not a default-launch compatibility claim.**
> Whether production wires Swift in-process, keeps the isolated child, or does
> something else is **T5b.2's** decision, informed by this finding.

**Platform scope (honest).** The delayed abort was observed on **darwin (arm64,
Node 24.11.0)**. On **ubuntu CI** the same parse under a *default* launch does
**not** abort within the 15 s window — it loads and survives, exactly as the
`--liftoff-only` run does. So the OOM is a darwin-specific phenomenon as far as
this PR has measured, and the negative-control test that asserts the abort is
gated to darwin. The `--liftoff-only` isolation and the load guard are kept
uniform across platforms as a conservative, darwin-motivated precaution; whether
Linux needs them at all is uncharacterized here and left to T5b.2.

## Cancellation

A parse runs inside a terminable `worker_thread`. A synchronous parse cannot be
interrupted from inside, so cancellation is `worker.terminate()` (a hard kill).

Because the parse is synchronous, the worker can only post `started` *just
before* it blocks — that alone does not prove an in-flight interruption (the
parse could have finished before the terminate landed). So the `cancel-demo`
operation additionally **confirms the parse was still unfinished when the worker
was terminated** via a **shared-memory flag**: the worker stores `1` into a
`SharedArrayBuffer` the instant the parse returns, before posting `done` and
before any teardown. The host gives the parse a beat, hard-terminates the worker,
and reads the flag **after `terminate()` has resolved** (i.e. after the thread
has exited): `inProgressAtCancel = !finished`. Sampling at the teardown boundary,
rather than before the terminate, is what makes this honest — a parse that
completes while the host is descheduled has already stored its flag by the time
the thread exits, so it is observed as finished, never mis-reported as
interrupted. If a pathological input finished too fast to interrupt, the flag is
set and `inProgressAtCancel` is false, so the acceptance check **fails honestly**
rather than claiming a cancellation that did not happen. It then measures the
termination time and parses clean input to completion in a fresh worker,
demonstrating the runtime recovers.

**One irreducible window remains, and we do not claim otherwise.** A parse that
*returns* but is killed in the few instructions before its very next statement
(the flag store) executes would read as `inProgressAtCancel:true`. This window is
inherent to a non-interruptible synchronous parse — no sampling scheme can make
completion, flag publication, and termination a single indivisible step — and is
sub-instruction against a multi-second pathological parse. The claim is therefore
scoped precisely to what the flag proves: *the completion flag was still unset
once the worker had been torn down*, not a guarantee about the exact instant the
kill landed.

Observed: a 200k-block pathological parse is still running when terminated;
`worker.terminate()` returns in ~2 ms; the replacement parse is clean. Proven in
`tools/swift-parse.test.ts` and the acceptance check.

## Measurements (darwin arm64, Node 24.11.0, `--liftoff-only`)

Baseline-only WASM (`--liftoff-only`), so these are the **floor** for parse
throughput, not what an optimizing tier would reach. Reproduce with:

```
node tools/projection-check.ts swift-measure
```

which loads the grammar once and parses three representative sources of
increasing size, reporting cold (first) and warm (repeat) parse time for each.
Runtime init + `Language.load` is ~10 ms. Representative single-run numbers:

| Source | Bytes | Cold (first parse) | Warm (repeat) |
|---|---|---|---|
| small (a one-line function) | 51 | ~13 ms* | ~0.2 ms |
| medium (a struct, 40 methods) | ~2.0 KB | ~4 ms | ~1.6 ms |
| large (4,000 functions) | ~283 KB | ~214 ms | ~205 ms |

\* The *small* cold number is inflated by the process-wide first-parse JIT
warmup (it is the first `parseSwiftSource` call in the process); *medium* and
*large* cold numbers are lower per byte because that one-time warmup is already
paid. End-to-end, a full checker invocation
(`node tools/projection-check.ts swift-parse …` — parent process + spawn the
isolated child + init + load + one parse + exit) is ~210 ms of wall clock.

Again: **measurements, not budgets** (D7). They vary run to run; the sizes are
fixed by construction so the sweep is reproducible.

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
node tools/projection-check.ts swift-measure
```

`swift-parse` prints one JSON report: artifact provenance, root type, `clean`,
ERROR/MISSING diagnostics with UTF-8 byte spans, and timings. Exit codes: **0**
clean, **1** the parse has ERROR/MISSING nodes (report still printed), **2** bad
input or an artifact/host failure (diagnostic on stderr, no report).

`swift-measure` prints the cold/warm size sweep above (small/medium/large). Exit
**0** when all parse clean, **1** if a source parsed with ERROR/MISSING nodes
(report still printed), **2** on an artifact/host failure.

## Acceptance

`node tools/projection-check.ts acceptance --pr T5a.3` (darwin only) proves all of
the above live against the pinned artifact in five assertions: load + sha + ABI +
licenses, UTF-8 byte spans, the full corpus cross-check with the known-gap
manifest, mid-flight cancellation (with the completion-race confirmation above),
and OOM survival whose negative control must abort with a V8 fatal signal — a
deadline kill or a clean exit-2 is rejected as not-proof. The corpus oracle
slices every diagnostic span with a **fatal** UTF-8 decode, so a span that splits
a codepoint fails loudly instead of laundering into a U+FFFD match.
