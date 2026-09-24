# Stage T upstream prerequisites — design spec

**Status:** design complete; the four shaping decisions (DA-1…DA-4) and all T0 decisions
(D1…D11) are **RATIFIED by Brian 2026-09-23** — see Part 4. This document itself is a
design-only artifact and adds no production code. It has since been merged alongside the
T0.1 `display-fold.v1` implementation (`src/display-fold.ts`, `src/attribution-engine.ts`)
that the ratified design describes — see `IMPLEMENTATION_PLAN.md`'s Stage T status for
what has actually shipped. Architected via Codex consult against the `briankeane/vienna`
tree; captured and adjudicated here.

## Purpose

The native macOS watching client (`slipstream-client-swift`) has a ratified plan whose
P0 gate names two **upstream** prerequisites in this daemon. This document designs both,
grounded in the code that exists today, and lays out a dependency-ordered, QA-able PR
graph. It does not build them.

The two prerequisites, and the client decisions that create them:

1. **A versioned display-fold contract on the reader** (client **D-A**). The client
   reproduces the *display fold* natively and checks parity against a Node-from-pinned-
   daemon-source oracle. That is only safe if the reader publishes a fold-contract
   version, so a shape-preserving semantic change is detectable and the client can freeze
   (client **D-K**).
2. **An interface-projection endpoint** (client **D-C**, route (a)). Added/removed/
   signature-changed function declarations for a change, for **Swift + TypeScript**,
   behind a modular per-language contract.

These map onto the reshaped plan's **Stage T**: T0 (contracts), the S5.0 "versioned fold
contract", and T5a/T5b (interface projection).

## Non-goals (what this design deliberately does **not** add)

- **No new log events.** Both surfaces are reader-derived projections. The event
  schema + log + CAS remain the sole capture truth; the reader stays a thin view.
- **No persisted projection, index, or GC root.** Both compute on demand and cache
  disposably, like clips.
- **No parity endpoint.** Client **D-J** does parity by client-side truncation to a
  frozen H; nothing here serves it. Do not design a `?through=H` affordance.
- **`evaluateChange` and all scoring stay out** of the display contract and its oracle.
  The client consumes *published* attribution results; it never re-scores.
- **No capability/discovery endpoint** for version negotiation — the response header
  (Part 2) is sufficient and avoids a restart race between discovery and replay.

---

## Part 1 — Two map corrections

Relative to the client-plan code map, for the record:

- `GET /v1/sessions` carries `durable_seq` in **each response-body entry**, not a header.
  The `slipstream-durable-seq` header appears on finite `/events` reads (and the 409
  cursor-beyond-boundary response), not on `/v1/sessions`.
- The function parser is `src/clip-function-parser.ts` (loads
  `tree-sitter-wasms/out/tree-sitter-<name>.wasm`, `Language.load` at line 33).

---

## Part 2 — Prereq 1: versioned display-fold contract

### 2.1 Scope — all four display components under `display-fold.v1`

Today only **attribution** and **evidence** are real folds (`src/attribution.ts`);
coverage and gaps are event types with ad-hoc display. **Recommendation: bring all four
under one `display-fold.v1` contract** (decision **DA-1**). Versioning only two would
leave two honesty-critical components outside the compatibility guarantee, and the extra
scope is small:

| Component | Canonical fold rule |
|---|---|
| Attribution | Existing `foldAttributions`: canonical target seq; target precedes attribution; target exists in same source; highest **valid** attribution seq wins by full replacement. |
| Evidence | Existing `foldEvidence`: structured evidence identity, canonical variant signatures, earliest-seq dedup, conflict disclosure, deterministic ordering. |
| Coverage | Highest-seq record per `(source, harness)`, preserving issues. Missing entry = **unknown**; never synthesize successful coverage. |
| Gaps | Ordered published gap records, preserving `(source, seq)`, reason, scope, episode. **No inferred gaps, no automatic healing, no completeness score.** |

The contract specifies valid input, exact decimal-seq handling, string equality/order,
canonical output, and unsupported-event behavior. Duplicate transport delivery must not
duplicate a gap; two conflicting records with the same identity are **corruption**, not
last-write-wins.

**Scope boundary (must be stated, not implied):** `display-fold.v1` does **not** version
baseline / inventory / task-grouping semantics. Those are Stage T's T2a. The contract
must either fold those canonical rules in before clients depend on them, or explicitly
mark them as separately specified. **Do not advertise whole-session parity from a
four-component contract.**

### 2.2 Delivery — a response header

```
Slipstream-Fold-Contract: display-fold.v1
```

Set on successful finite `/events` responses **and** SSE responses (including an empty
finite replay). The client reads and validates it **before applying any events**.

| Option | Verdict |
|---|---|
| **Response header** | **Chosen.** Preserves raw NDJSON + SSE envelopes; binds the interpretation id to the actual response. |
| Body field | Would wrap NDJSON / modify durable envelopes / add synthetic SSE control records. Unnecessary risk. |
| `/v1/schemas/folds/:version` | Can *describe* a known contract but cannot say which contract governs a given response; JSON Schema can't capture fold semantics. |
| Capability endpoint | Adds a discovery request + a restart race between discovery and replay. |

Ship `DISPLAY-FOLD.md`, versioned fixtures, and a machine-readable manifest in the source
distribution. A runtime contract-document route can come later if a consumer needs it;
it is not required for compatibility detection.

Backward-compat: existing clients ignore the header; bodies, frame IDs, reconnect params
are unchanged. New clients treat a **missing** header as *unsupported*, never implicitly
v1.

### 2.3 "Tied to history" — response-bound interpretation

**Recommendation (decision DA-2): response-bound interpretation of immutable history**,
not a producer-version stamp on each event. For finite replay, the interpretation is
identified by:

```
(session, event prefix through H, fold-contract version)
```

where `H` is the existing finite-replay high-water. The header says *"use these published
fold rules to interpret this history."* It does **not** claim every event was originally
produced by that daemon version — mirroring the clip precedent (current algorithms
interpret old immutable inputs).

Reconnect behavior:

- **Same contract** → resume from the applied cursor.
- **Different, unsupported** → freeze derived rendering (client D-K).
- **Different, supported** → discard and rebuild derived state from the beginning under
  the new contract before declaring it current. Never append a v2 suffix onto a v1 fold.
- An SSE response has **one** contract for its lifetime; a restart makes a new response
  and another compatibility check.

**Ratified in DA-2.** The alternative — preserving the interpretation selected *at capture
time* forever — requires durable contract provenance and historical dispatch, a
substantially larger upstream scope that a response header cannot provide. A new contract
must define how it interprets supported historical event versions; unsupported inputs
stay visibly unsupported. Never silently relabel incompatible historical semantics.

### 2.4 Release discipline — behavior **and** source-change gates

A fixture-hash gate alone is insufficient (behavior can change outside the corpus). Use
all five:

1. **Immutable released manifests:** contract id, canonical-output format, supported
   event versions, fixture corpus, implementation fingerprint.
2. **Hand-specified expected states:** Node runs the authoritative display exports and
   compares canonical results; Swift consumes the same corpus.
3. **Conservative CI change gate:** any change to display implementations or their
   behavior-affecting dependencies requires a new contract version. Fingerprint the
   explicit display dependency set; exclude scoring-only code where possible.
4. **Baseline comparison:** reject editing an already-released manifest / expected-output
   set in place to make tests pass — add a new version instead.
5. **Differential fixtures:** rejection cases, prefix boundaries, evidence conflicts,
   Unicode identity/order, coverage-absence, gaps — not just happy-path snapshots.

Conservative fingerprinting may bump the version for a harmless refactor. That is the
accepted cost of removing a subjective "this edit probably changes nothing" escape hatch.

**Honesty statement (unchanged from the client plan):** this is *release enforcement, not
a mathematical proof*. Dependency omissions, inadequate fixtures, and bypassed CI are
residual risks. Runtime version checking detects a **declared** incompatibility; it cannot
independently discover an **undeclared** semantic change.

---

## Part 3 — Prereq 2: interface-projection endpoint (T5a + T5b)

### 3.1 Endpoint + schema

```
GET /v1/sessions/:id/changes/:seq/interfaces
GET /v1/schemas/projections/interface.v1
```

Mirror the clip endpoint: same auth, durable-boundary validation, tombstones, and HTTP
errors — `200` (any disposition, including unavailable/overloaded), `404` (unknown
session/change, beyond durable boundary, non-change record), `410` (removed session),
`500` (corrupt durable record).

Response fields:

| Field | Meaning |
|---|---|
| `change_seq` | Originating committed change (response-only, **not** a cache key). |
| `projection_version` | `interface.v1` — envelope + shared comparison rules. |
| `language` | Selected language/dialect from the recorded path. |
| `language_version` | Grammar + extraction + normalization + matching semantics for that language. |
| `status` | `ready \| incomplete \| unsupported \| skipped \| unavailable`. |
| `fallback_reason` | Required on any non-`ready` result; machine-readable. |
| `coverage.before` / `coverage.after` | Complete-within-scope / absent / incomplete / unsupported / unavailable, with reasons. |
| `changes` | Added / removed / signature-changed declarations. |

Both `projection_version` and `language_version` are compatibility inputs under client
D-K. A language-module change must not silently change results under an unchanged
`language_version`.

A change row:

- `kind`: `added | removed | signatureChanged`
- `identity`: structured, language-defined declaration identity — **a matching key under
  a documented algorithm, not proof of rename continuity**. Identity is local to the
  originating change and the projection versions.
- `before` / `after`: declaration record or `null`.
- Each declaration: kind, qualified display name, normalized signature, **raw-byte source
  span**.

`ready` with an empty `changes` array means *no changes within the declared extraction
scope* — never behavioral equivalence.

**Pending stays client-side.** The endpoint is bounded request/response. Do not add
persisted jobs, polling handles, or an async protocol just to say "pending."

**Span hazard:** use exact raw-byte spans with an explicit UTF-16↔UTF-8 conversion
strategy. The clip parser sidesteps this with line-based spans; declaration signatures do
not get to.

### 3.2 `LanguageProjection` — one module owns each language

```
metadata:
  language / dialects, language_version, grammar provenance, extraction scope
extract(immutable UTF-8 input, deterministic limits):
  declarations + coverage + diagnostics
compare(before extraction, after extraction):
  changes + comparison coverage
```

Each **module** owns: declaration kinds + qualified scope; identity + overload
disambiguation; signature normalization; matching + ambiguity handling; parse-error
interpretation + unsupported constructs; stable ordering.

The **shared service** owns: blob resolution, workers, admission, deadlines, caching,
response stamping, HTTP.

A third language adds **one module + registration + fixtures**. It must not add language
branches to HTTP routing or worker scheduling, and language identifiers must **not** be a
schema enum that needs redesign per module.

**Ratified conservative v1 semantics (DA-3):**

- Syntactic function interfaces, **not** typechecked public API.
- No cross-file matching, no inferred rename detection.
- Body-only edits do **not** produce signature changes.
- Ambiguous overload correspondence is **disclosed**, not guessed.
- If either side's extraction is **incomplete → return `incomplete` and emit no change
  rows** (rather than risk false additions/removals). Reliable partial rows can be a
  later, separately specified capability.

The last point is ratified: it trades useful partial output for a much smaller, honest
matching contract.

### 3.3 Swift grammar — credible candidate, compatibility unproven

Candidate: **`alex-pinkus/tree-sitter-swift`** (documents WebAssembly use; listed as a
dependency by `cursorless-dev/tree-sitter-wasms`). This is a *plausible path*, not proven
compatibility with this checkout's pins (`web-tree-sitter@0.25.10`,
`tree-sitter-wasms@0.1.13`; deps aren't even installed in the worktree).

The **first Swift slice is a feasibility PR** that must demonstrate, with the exact pinned
artifact: load with the existing runtime; parse representative + malformed Swift; Unicode
span correctness; worker cancellation + cold-start cost; grammar revision + build
provenance + license. If the bundled artifact fails, build a pinned WASM with a compatible
Tree-sitter toolchain — do **not** casually switch to a native binding or a Swift
subprocess.

**TypeScript may land first. Swift is a required follow-up dependency for completion
(decision DA-4) — not an optional feature, and TypeScript-only does not satisfy the
ratified "Swift + TypeScript" criterion.**

### 3.4 Workers, cache, retention

Reuse the clip service's established *behavior* (not its bounded clip output):

- Resolve **whole immutable before/after blobs**, subject to explicit input limits.
- Parse + match in **terminable workers**.
- Bound active work, queue length, coalesced waiters, input bytes, output size; include
  queue wait in the stated request deadline.
- Cache by **snapshot tags + language + both projection versions**; **exclude
  `change_seq`** from the key. Never cache timeout / overload / worker-error /
  availability-dependent outcomes. Revalidate retained blobs before returning cached
  content; preserve removal semantics.
- No persistent index, no new GC root, no projection event.

**Two bounded pools can still jointly starve capture.** Add a small **shared admission
budget** across clip + interface computation (keep their compute protocols separate; do
not build a general job framework). Measure both workloads together before claiming
capture is unaffected. Do not inherit clip numeric budgets without measurement, and do
not relax existing clip ceilings to fit Swift. **Interface budgets + acceptable timeout
rates need Brian's approval.**

---

## Part 4 — T0 gate: decisions for Brian

### The four decisions that shape this spec — RATIFIED 2026-09-22

- **DA-1 — Fold scope. RESOLVED → all four.** All four components (attribution, evidence,
  coverage, gaps) are versioned under one `display-fold.v1`. Coverage/gaps are not left
  outside the compatibility guarantee.
- **DA-2 — History binding. RESOLVED → response-bound.** The contract version means
  "interpret *this* history (`session`, events through `H`) with *these* published fold
  rules," mirroring the clip precedent. Capture-time-preserved interpretation — which
  would require durable contract provenance + historical dispatch in the daemon — is
  explicitly **out of scope**. A new contract must define how it reads supported
  historical event versions; unsupported inputs stay visibly unsupported.
- **DA-3 — Interface v1 partial policy. RESOLVED → no rows.** When extraction is
  incomplete on either side, the endpoint returns `incomplete` and emits **no** change
  rows. Reliable partial rows are a later, separately-specified capability, not v1.
- **DA-4 — Swift sequencing. RESOLVED → Swift required.** TypeScript may land first;
  Swift is a **required follow-up dependency for completion**, not optional. TS-only does
  **not** satisfy the ratified "Swift + TypeScript" criterion.

### Ratified T0 decisions (2026-09-23)

The following records Brian's ratified choices. These are decisions for implementation,
not claims that the corresponding interfaces already exist.

#### D1 — Fold boundary. RESOLVED → A

`display-fold.v1` covers exactly attribution, evidence, coverage, and gaps. Baselines /
inventory and task grouping belong to T2a under a separately specified future contract;
four-component parity must never be described as whole-session parity.

**Rationale:** the four display components can be versioned now without inventing T2a
inventory or grouping semantics. **Example:** a session containing only a baseline for
`a.ts` (`function f(){}`) and a task folds to:

```json
{"attributions":[],"evidence":[],"coverage":[],"gaps":[]}
```

#### D2 — Declaration scope. RESOLVED → A+

Include named syntactic functions at every visibility level: TypeScript function
declarations, overload signatures, methods, named function-valued bindings (including
TSX `const Card = (...) => ...`); Swift `func`s, methods, extension members, and protocol
requirements. Include TypeScript constructors and Swift `init`. Traverse every `#if`
branch and record syntactic guards in identity (for example `["DEBUG"]` and
`["!(DEBUG)"]`), never evaluate build settings. Exclude anonymous callbacks, local /
nested declarations, accessors (`get` / `set`), subscripts, and generated declarations;
each language module's metadata states that exclusion list.

**Rationale:** the interface is a syntactic outline, not a restricted public-API view.
**Examples:** `export const Card = (p: {title: string}) => <h1>{p.title}</h1>;` produces
`[add(K(Card), A(Card))]`; `protocol P { func read(_ x: Int) -> String }` plus
`extension Box { func read(_ x: Int) -> String { "" } }` produces additions for
`P.read` and `Box.read`; the two `trace` declarations in `#if DEBUG` / `#else` both
produce additions with guards `["DEBUG"]` and `["!(DEBUG)"]`.

#### D3 — Correspondence. RESOLVED → A

First match exact signatures. Then emit one `signatureChanged` only when exactly one
unmatched declaration remains on each side of the same kind / scope / name group. A
rename is removed plus added; a move within the same scope emits no rows; ambiguous
overloads return `incomplete`, `"ambiguous-correspondence"`, and no rows; duplicate
declarations return `incomplete`, `"duplicate-declaration"`, and no rows. No similarity
scoring is permitted.

**Rationale:** this yields useful signature changes without claiming identity that the
syntax cannot prove. **Examples:** `oldName` → `newName` is
`[remove(K(oldName),B), add(K(newName),A)]`; reordering `function a(){}` and
`function b(){}` is `[]`; two changed overloads for `f` are incomplete rather than paired.

#### D4 — Signature equality. RESOLVED → A

A signature is its written header syntax: defaults including values, annotations,
modifiers, generics, constraints, parameter names / Swift labels, and explicit return
types. Strip trivia and bodies. A default `1` → `2` and a Swift label `from` → `at` are
`signatureChanged`; body-only edits, inferred-return changes, and formatting-only edits
emit no rows.

**Rationale:** preserve what the author wrote without evaluating code or inferring types.
**Examples:** `function f(x:number = 1):number` → `function f(x:number = 2):number`
emits `[change(K(f),B,A)]`; `function value() { return 1; }` →
`function value() { return "one"; }` emits `[]`.

#### D5 — Completeness. RESOLVED → A

Completeness is whole-file syntactic completeness: any ERROR or missing node produces
`incomplete` with `"before-parse-error"` or `"after-parse-error"` and no rows. An absent
before-file produces additions; a missing CAS blob is `unavailable`,
`"before-blob-missing"`; an empty successfully parsed before-file is ready with additions.

**Rationale:** an unrelated parse error can conceal an eligible declaration, so partial
rows would overstate certainty. **Examples:** `function f(x: {` before a valid after-file
is `incomplete`, `"before-parse-error"`, `[]`; an explicitly absent or empty before-file
and valid `function f(){}` after-file produces an added `f` (except a missing blob, which
is unavailable).

#### D6 — Versioning. RESOLVED → A

Each language has a conservative implementation fingerprint covering its grammar artifact,
extraction, normalization, correspondence, ordering, offset mapping, and limits. Any
change bumps that language's version (for example `typescript.v2`); TypeScript and Swift
version independently. Shared envelope changes bump `projection_version`, and clients
match exact tuples.

**Rationale:** a conservative bump is preferable to silently changing a client-visible
projection. **Example:** a parser refactor that leaves
`function f():number { return 1; }` → `return 2;` with no rows still changes reported
`typescript.v1` to `typescript.v2`, while `interface.v1` remains unchanged.

#### D7 — Admission measurements. RESOLVED → A

Ratify the measurement method now, and the numbers later. Clip and interface work share
one bounded admission budget: concurrency `C`, queue `Q`, waiter bound `W`, and deadline
`D`, where `D` includes queue wait. Do not copy the clip service's deadline-starts-in-
`runTask` behavior. Measure baseline, clip-only, interface-only, and combined arms over
representative TS / TSX / Swift sizes plus malformed and Unicode inputs, cold and warm
runs. Report thresholds per language; crashes and missing data are failures and are never
discarded. Brian approves numbers at T5b.1 from measurements after T5a.2 and T5a.4 exist.

**Rationale:** shared work must be measured under the combined load that could affect
capture. **Examples:** admitted `f(number)` → `f(string)` returns `ready` with
`[change(K(f),B,A)]`; a full queue returns HTTP 200, `skipped`, `"overloaded"`, `[]`; an
expired queued or running request returns HTTP 200, `skipped`, `"timeout"`, `[]`.

#### D8 — Fold ground rules. RESOLVED → A

Canonical fold output is plain JSON with sorted arrays and decimal-string sequences.
Strings compare exactly, without Unicode normalization, ordered by UTF-16 code units.
Deduplicate identical transport records; conflicting records with the same `(source, seq)`
identity are corruption, never newest-wins. Distinguish unknown from unsupported event
versions; fold evidence per source and preserve its source; accept numeric timestamps only
within the safe-integer range. Every released contract version has an immutable manifest
and CI rejects edits to it. On every new SSE response, a missing or invalid
`Slipstream-Fold-Contract` header stops application, retains the cursor, marks derived
state stale / unsupported, and never inherits the previous response's header.

**Rationale:** canonical interpretation must be deterministic and response-bound across
Node and Swift. **Examples:** identical duplicate delivery yields one gap, while a
different record for the same `(source, seq)` is corruption; composed and decomposed
Unicode strings remain distinct; a reconnect with no valid header applies no events.

#### D9 — Fold fingerprint boundary. RESOLVED → A

T0.1 moves scoring code out of `src/attribution.ts` so the fold fingerprint covers display
code only; the full pre-existing test suite must pass for that move.

**Rationale:** scoring is explicitly outside the display contract, so it must not cause
unrelated fold-version churn. **Example:** changing scoring after the move does not alter
the display-code fingerprint; changing `foldAttributions` does.

#### D10 — Interface envelope. RESOLVED → A

Status precedence is fixed: genuine extraction incompleteness wins first and returns
`incomplete` with no rows; then comparison ambiguity returns `incomplete` with no rows;
then unavailable; then unsupported; then admission rejection or cancellation returns
`skipped`. Add coverage side `notEvaluated` for admission-rejected or cancelled work.
Use `language_version:null` when no language module exists. Spans are whole-declaration,
UTF-8-byte, half-open ranges. Order rows removed, then signatureChanged, then added.

**Rationale:** a disposition must never imply a successful extraction or comparison that
did not occur. **Examples:** malformed before input is `incomplete`,
`"before-parse-error"`, `[]` even if another problem is present; ambiguous complete
overloads are `incomplete`, `"ambiguous-correspondence"`, `[]`; an overloaded request has
`coverage.before` and `coverage.after` of `notEvaluated`.

#### D11 — PR graph. RESOLVED → A

Add T-QA first: the QA harness and one-command local daemon (`tools/qa-daemon.ts` plus
`tools/projection-check.ts` acceptance). Split T0 into a fold gate (D1, D8, D9) and an
interface gate (D2–D7, D10), so T0.1 depends only on the fold gate plus T-QA. T5b.1 code
may land early, but its budget approval depends on T5a.2 and T5a.4 measurements. Every
code PR ships an executable live-daemon acceptance check under
`tools/qa/acceptance/<ID>.ts`.

**Rationale:** the harness proves real daemon behavior before contracts depend on it, and
budget approval requires both real language implementations. **Examples:**
`npm run qa:daemon -- --scenario T-QA --keep` starts the local harness; `npm run qa:check
-- --pr T0.1` runs its registered acceptance; synthetic admission tests alone cannot
approve Swift budgets.

---

## Part 5 — Dependency-ordered PR graph

Each PR is small, TDD-sized, lands green, and is **independently QA-able**. QA handles use
one small `tools/projection-check.ts` utility (subcommands, synthetic fixtures,
inspectable JSON) plus authenticated `curl` for the HTTP PRs. The commands below are
*proposed* handles, not existing commands.

| PR / gate | Depends | Red → Green | Independent human QA |
|---|---|---|---|
| **T-QA — QA harness + local daemon** | this design | Live capture/bootstrap/lifecycle acceptance absent → one-command daemon + acceptance pass | `npm run qa:daemon -- --scenario T-QA --keep`; `npm run qa:check -- --pr T-QA`. |
| **T0-fold — fold contract ratification (gate)** | this design | D1/D8/D9 → recorded fold decisions + example outputs | Review four-component, duplicate/conflict, Unicode, and reconnect examples. |
| **T0-interface — interface contract ratification (gate)** | this design | D2–D7/D10 → recorded interface decisions + example outputs | Review declaration, correspondence, completeness, status, and admission examples. |
| **T0.1 — display contract + oracle** | T-QA, T0-fold | Coverage/gap/prefix/rejection fixtures fail → four canonical components pass | `node tools/projection-check.ts fold --fixture revision-and-gap` prints normalized state + contract id. |
| **T0.2 — reader header + release gate** | T0.1 | Missing finite/SSE headers; unchanged-version mutation accepted → headers + CI rejection verified | Authenticated `curl -i` for empty replay and SSE; checker rejects a deliberately altered fold fixture. |
| **T5a.1 — response contract + comparison core** | T-QA, T0-interface | Synthetic declaration matching/status fixtures fail → approved matching + schema examples pass | Checker prints added/removed/changed, ambiguous, incomplete examples — no parser. |
| **T5a.2 — TypeScript language module** | T5a.1 | Whole-blob TS extraction fixtures fail → approved signatures + coverage | Checker compares synthetic TS before/after, incl. body-only edits + overloads. |
| **T5a.3 — Swift WASM feasibility** | T-QA, T0-interface | Exact artifact/runtime compatibility unproven → load, parse, cancellation demonstrated | Checker prints Swift syntax/diagnostics + the exact grammar artifact. No comparison claim yet. |
| **T5a.4 — Swift language module** | T5a.1, T5a.3 | Swift declaration fixtures fail → approved identity/signature/partial outcomes | Same interface checker as TS, selecting Swift. |
| **T5b.1 — shared bounded admission** | T-QA, T0-interface; budget approval after T5a.2 + T5a.4 measurements | Combined clip/interface demand exceeds bound → shared limit + shutdown tests pass; clip regression suite passes | Checker saturates synthetic jobs, prints admitted/overloaded + active-work max; approval records TS + Swift measurements. |
| **T5b.2 — interface worker/service** | T5a.2, T5b.1 | Timeout/missing-blob/cache-eviction/GC-hit fixtures fail → explicit dispositions | Checker runs the service over a temp synthetic store; demonstrates cache-hit-then-GC. |
| **T5b.3 — public endpoint + schema discovery** | T5b.2 | Route/auth/boundary/tombstone/schema tests fail → public API passes | Authenticated curl against a synthetic committed TS change; inspect success/unavailable/error. |
| **T5b.4 — Swift endpoint acceptance** | T5b.3, T5a.4 | Swift HTTP corpus fails → both required languages pass through the public endpoint | Same curl workflow with Swift changes; verify language version + incomplete states. |

T5b.4 may be an acceptance gate rather than a PR if registration already landed with the
module — do not manufacture a commit. Sequencing into the rest of Stage T: **T1 consumes
T0.2; T2 uses T0.1; T5c needs the complete interface endpoint; T6a is the combined-load/
parity acceptance gate.** None of this depends on finishing the TUI first.

---

## Part 6 — Honesty-risk audit & hard prohibitions

Where this design could go wrong, and the fences:

- **Never a second capture source.** Never consult the current worktree, compiler
  project, imports, or harness logs to fill missing content. Missing-before content is
  **not** an addition; failed-after parsing is **not** a removal.
- **Never emit events.** No filesystem-change or projection-result events from either
  surface.
- **Never overstate.** Syntax comparison never proves semantic/API equivalence. Equal `H`
  never guarantees equal projection availability (blob retention + transient outcomes are
  separate from durable-fold parity). A four-component fold contract never implies
  whole-session parity.
- **Never quietly weaken a criterion.** TypeScript-only does not satisfy Swift + TS.
  Relaxing a plan success criterion or an honesty constraint is *a decision not ours to
  make* — stop and ask Brian.

**Pushback captured:** the client needs *less* upstream machinery than a capability
service, a historical fold registry, or a persisted symbol index. A response header, a
small canonical fold module, and enforced release manifests cover the fold prerequisite
under the response-bound history interpretation. The interface endpoint is justified by
ratified route (a), but its **first version stays a bounded syntactic function-signature
comparison — not a semantic API-analysis system.**

---

*End of design. This document adds no production code itself. Part 4, including DA-1…DA-4
and D1…D11, is fully ratified.*
