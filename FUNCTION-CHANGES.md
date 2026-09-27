# Function input/output changes: design proposal

> **Status: PROPOSAL — this is not a contract.** Nothing below is served, pinned,
> or implemented. The JSON shapes are **proposals labelled as such**; clients must
> not pin them. The schema and its validated fixtures are written into this same
> PR only after Brian settles decisions F1–F6 (see [Decisions](#3-decisions-for-brian)).

This document proposes how the daemon reports what changed in functions'
inputs and outputs over a stretch of captured work. It is the design for the
"Function changes" view in the owner's design,
`design/features/function-change-tree/exports/2026-09-24/`, which lives in the
Swift client repository. The PNG, HTML and Pen exports there are the **visual
source of truth**. They do not by themselves grant any backend semantics.

It builds on `interface.v1` ([INTERFACE-PROJECTION.md](INTERFACE-PROJECTION.md)),
the ratified T0 decisions ([STAGE-T-PREREQS.md](STAGE-T-PREREQS.md)), the shared
admission budget ([ADMISSION.md](ADMISSION.md)) and the Swift grammar findings
([SWIFT-GRAMMAR.md](SWIFT-GRAMMAR.md)). It was architected through a Codex
`gpt-6-astra` consult on 2026-09-27, which Claude adjudicated.

**Headline.** The proposal is **`interface.v2`**, a bounded, read-only comparison
between two **recorded** points of one capture session. Each changed function
gets structured inputs, outputs and declared throws, together with per-file
coverage and source references.

- Syntax-only comparison of written headers ships first.
- Shared-type propagation, effects and behavioural prose are **reported as not
  analyzed**. They are never silently dropped, and support for them is never
  claimed until Brian approves their scope.
- Language analysis stays in the daemon.
- The client builds the tree and handles zoom and layout.

---

## 1. Capability map

Every visible element of the owner design is listed below. For each one, the
table gives the evidence that exists today, what is missing, and the slice that
would supply it (slices are defined in §6). The legend is:

- **Have**: derivable today from public events and blobs.
- **New**: needs this proposal.
- **Gated**: needs a decision in §3.
- **Elsewhere**: owned by another workstream or unassigned. It is listed so it
  is not silently dropped.

### 1.1 Inputs and outputs (first priority)

| Design element | Evidence today | Missing / slice |
|---|---|---|
| `setActivity ~`: `= userId: string`, `− active: boolean`, `+ state: ActivityState`, `− Promise<void>` / `+ Promise<User>` | **Have** the recorded before/after bytes. v1 compares only an opaque signature string. | **New.** Structured parameters and return, compared per component (FD1/FD2). This is the core of the feature. |
| `isSuspended +`: `+ user: User`, `+ boolean` | **Have** v1 addition semantics (D3). | **New.** Structured components of an added declaration (FD1/FD2). |
| `assertActive +`: `+ user: User`, `+ void` | Same. | Same. |
| `assertActive`: `+ Throws AccessError` | None. | **Split.** In Swift, a *declared* `throws(AccessError)` belongs to the written header, so FD2 covers it if the pinned grammar parses typed throws. TypeScript has no throws clause, so a throw found in the body is an **effect** (F4). The TS projection reports throws as `notExpressible`, never as "does not throw". |
| `createUser ~`: `= input: CreateUserInput`, `OUTPUT · Promise<User>` | **Have** the bytes. | The header is **unchanged**, so written-contract comparison yields no row. The card exists in the design only because the `User` type changed. That needs propagation (**Gated**, F3). |
| `canAccess ~`: `INPUT · user: User`, `= boolean` | Same. | Same as `createUser`: an unchanged header, so its card needs propagation (F3). |
| Nested rows `User.isActive − boolean + ActivityState` under `createUser`'s output and `canAccess`'s input | None. | **Gated**, F3 (type-declaration extraction plus cross-file reference). |
| `=` / `+` / `−` / `~` component markers | v1 has added / removed / signatureChanged at declaration level only. | **New.** Component operations `equal` / `added` / `removed` / `changed` (§4.5). |
| "Number = changed descendants" branch counts | Counts can be taken over change rows. | **New**, client-side. Count each changed declaration once, not each component row. Never count unknown or failed files as zero (§4.8). |

### 1.2 Shared types, effects and behaviour

| Design element | Evidence today | Missing / slice |
|---|---|---|
| `User ~` shared-type card: `SHARED FIELD · isActive − boolean + ActivityState`, "Shared type, not a function." | None. | **Gated**, F3 option B: per-file extraction of type-declaration fields. |
| `CONTRACTS AFFECTED`: `createUser → output`, `canAccess ← input` | None. | **Gated**, F3 option C: captured cross-file references, labelled as syntactic "mentions". |
| `5 functions · 1 shared type · 4 files` | Can be counted from function rows. | The functions and files counts can be derived under v2. The "shared type" count requires F3 ≥ B. Totals must say "loaded" until every page is loaded. |
| EFFECTS: `= Writes users`, `+ Emits activity.changed`, `? Indirect calls`, `? Listener effects`, `None detected` | None. | **Gated**, F4. A syntax extractor cannot establish database writes, event delivery or listener behaviour. Until F4 is settled, the effects row shows **"Effects not analyzed"**. "None detected" requires a detector that actually ran over a declared scope. |
| `canAccess` OUTPUT: `~ Now checks Active` | None. | **Gated**, F4. This is behavioural prose, not typing. |
| Footer: "Effects cover direct bodies only; none detected is not a guarantee." | Wording only. | Keep the wording for a future detector. Until then the footer describes the written-contract scope (F4). |

### 1.3 Tree, navigation and selection

| Design element | Evidence today | Missing / slice |
|---|---|---|
| Ownership tree `storefront → src → api / auth / services / types`, files, functions | **Have** recorded paths plus declaration scopes. | Client-side containment built from response paths (FS2). The lines mean directory/file/declaration **containment**, not calls, dependencies or authorship. |
| `Show unchanged branches`; `tests`, `config`, `hooks · utils` "Collapsed · unchanged" | **Have** baseline inventory of observed paths. | **New.** Listing of paths whose endpoints are identical (`include_identical`, §4.3). The wording follows F2. Branches are never invented from the illustration. |
| `Entire codebase ▾` scope and "Find file, function or type" search | Paths and names are available. | Client-side filtering over **loaded** pages, plus a `path_prefix` filter on the server. Search over types needs F3 ≥ B. A page-local search is never labelled exhaustive. The scope wording follows F2. |
| `+Added ~Changed −Removed` legend | — | Client-side (FS2). |
| Zoom, "Fit tree", "Zoom to selection" | — | Client-side only (FS2). |
| "Select a change to open source." | **Have** the snapshot SHA-256, the blob route and byte spans. | **New.** v2 returns endpoint snapshot references and per-side UTF-8 spans. Source opens through the existing authenticated blob route (FS3). |

### 1.4 Header, comparison and disabled design elements

| Design element | Evidence today | Missing / slice |
|---|---|---|
| `Compare: Before story → Working tree ▾` | **Have** durable sequence boundaries and recorded snapshots. | **Gated**, F1. "Story" is rejected vocabulary (IMPLEMENTATION_PLAN "Task, not story"). The after side is the recorded state at a sequence, **not** the live working tree. Proposed wording: "Recorded at #B → Recorded at #A". |
| Breadcrumb `acme / storefront` | The session-start event records the capture root. | **Elsewhere.** The client may show the root's basename. Organization and repository identity are not recorded, so `acme` must not be invented. |
| Branch `feat/activity-status` | Not recorded. | **Elsewhere, unassigned.** It must not be filled by querying the current Git state, because that would label a historical comparison with live state. Recording branch metadata at capture time would need its own decision. |
| `ST-128 Introduce account activity states` | `task.started.v1` records `task_id` and `title`. | **Elsewhere** (stream and task work). The title can come from the task declaration. The ticket ID is not recorded. |
| `1 of 2 tasks complete` | There is no task-ended event. | **Elsewhere, unassigned.** Task completion is not in the log, and this feature must not synthesize it. |
| `4 files changed +42 −11` | Recorded endpoint bytes. | **Elsewhere**, or a later slice. Range file counts come from v2. Line statistics are a separate text diff, and function counts must not stand in for them. |
| Tabs: Activity / Files / Function changes | Stream (Activity) exists. | Swift shell navigation is a **coordination point** with the stream worker (§6.4). |
| Disabled inspector `SELECTED CHANGE · FUNCTION`: `activity.ts : 8`, "Now returns the updated user.", "? Listener effects unresolved", "Open source diff ↗", "Review callers & subscribers ↗" | Disabled in Pen (`enabled:false`). | Not an initial requirement. It stays preserved in the design. The source reference could back "Open source diff" later. The prose needs F4. Callers and subscribers need F3 option C or beyond. Nothing is activated by inference. |
| Disabled leaf subtitles `OUTPUT · nested field`, `INPUT + OUTPUT`, `INPUT · OUTPUT · EFFECT` | Disabled. | Preserved. `INPUT + OUTPUT` is derivable from v2 component rows. `nested field` needs F3 and `EFFECT` needs F4. |
| Agent-connected indicator, account and settings | — | **Elsewhere** (setup work). Connection health is never derived from interface availability. |

**What the owner design shows that the recommended first version cannot.** Under
recommendations F3-A and F4-A, several parts of the illustrated tree do not
appear:

- the `createUser` and `canAccess` cards;
- the `User` card;
- every nested field row;
- every effect claim;
- "Now checks Active".

In their place the view shows the three header-level changes in the design:

- `setActivity ~`;
- `isSuspended +`;
- `assertActive +` (without `Throws` in TypeScript).

It also shows an explicit **"Shared types, effects and behaviour: not analyzed"**
banner. This is a scope reduction that Brian must accept or reject through F3
and F4. It is **not** a silent reduction. Reporting `createUser` or `canAccess`
as signature changes would be false, because their written headers did not
change.

---

## 2. Comparison boundary

### 2.1 What is compared

A comparison is always within **one capture session** (`session_id` = capture
scope, never authorship). It sits between two explicit, decimal-string
sequence cutoffs:

```
(session_id, before_seq = B, after_seq = A),   0 ≤ B ≤ A ≤ durable high-water H
```

The two values mean the following:

- `B = 0` means *the empty recorded prefix*. It does not mean "an empty
  repository".
- The client reads the current durable high-water `H` from the public stream and
  sends `A` explicitly.
- There is no moving `latest` value inside a paginated comparison.

The result compares **recorded endpoint states**. It is not an atomic filesystem
snapshot and not complete edit history. A baseline scan records files at
different moments. A cross-file comparison is therefore a map of recorded
states, not a coherent build checkout.

It is **never**:

- the live filesystem;
- the current Git HEAD;
- a "story" or task-start baseline, unless F1 makes that an explicitly named
  preset over recorded cutoffs.

The daemon has no Git reading ("Baseline is current bytes, not git HEAD").

### 2.2 Endpoint resolution, per path

For every path with a record through `A`:

1. **Before endpoint.** Take the latest `file.baselined.snapshot` or
   `file.changed.after` at or before `B`.
2. **After endpoint.** Take the latest such record at or before `A`.
3. **Never** replace an unavailable endpoint with older available bytes.
4. **Validate the chain.** A change's `before` must agree with its recorded
   predecessor. A contradiction is corruption and returns `500`, which matches
   recovery's existing check.
5. **Stamp provenance** for each endpoint: `record_seq`, `field`
   (`snapshot` / `before` / `after`) and the recorded snapshot tag
   (`content{sha256,size}` / `absent` / `unavailable{reason}`).

**First-change predecessor rule** (for ordinary additions after the baseline):

- **When it applies.** Three things must all hold:
  - the path has no record at or before `B`;
  - `capture.baseline.completed` is at or before `B`;
  - the first record for the path after `B` is a `file.changed`.
- **What it does.** That change's explicit `before` is used as the before
  endpoint. Its provenance stays that later record's `seq` with
  `field:"before"`, so the response never claims the before state was recorded
  by `B`.
- **When it does not apply.** A path with **no record at or before `B`** that
  the rule does not cover has an **unknown before boundary**. Two cases lead
  here:
  - the baseline was not complete at `B`;
  - the path's first record after `B` is itself a baseline snapshot. This
    includes every baselined path when `B = 0`.

  An unknown boundary is a **projection-derived** endpoint,
  `{ "kind": "unknownBoundary" }`. It has no `record_seq`, `field` or snapshot,
  because no such record exists. It is distinct from a recorded
  `unavailable{reason}` snapshot, and its coverage is
  `{ "state": "unavailable", "reason": "unknown-boundary" }`.
- **Incomplete inventory is not the same as an unknown boundary.** A path that
  *does* have a record at or before `B` uses that record, even if the baseline
  was still running at `B`. Incomplete inventory is disclosed separately
  (`inventory.baseline_completed_seq`).

**Equal endpoints.** Two endpoints are *equal* when both are `absent`, or both
are content with the same SHA-256. Recorded `unavailable` snapshots and unknown
boundaries are **never** equal to anything, including a matching reason.

### 2.3 How recorded conditions affect results

| Situation | Result |
|---|---|
| File added (explicit `absent` → content) | All eligible declarations are `added` after a successful extraction. Before coverage is `absent`. |
| File removed (content → explicit `absent`) | All eligible declarations are `removed`. After coverage is `absent`. `absent` means absent from the captured **regular-file** state: the reader records a path replaced by a symlink or another non-regular object as `absent` (`src/reader.ts:54`). The view says "no longer a captured file", never "deleted". |
| Empty file → populated | This is **not** an addition of the file. Before coverage is `complete` (it parsed as empty) and is reported differently from `absent`. |
| Added then removed inside the range | `absent` → `absent`: equal endpoints, so `identical` (§4.4). No language module is consulted. The intermediate edits remain in the event stream, and the view never says "nothing happened". |
| Edited and reverted | Endpoints are identical: `identical`, meaning no net written-interface change. |
| Rename or path move | A removal at the old path and an addition at the new path. No continuity is inferred. |
| **Capture gap** between B and A | Known endpoints are still compared. The gap's `seq`, reason and scope are returned in `gaps[]`. History between the endpoints is incomplete and labelled as such. |
| Gap before B | Returned too, because it qualifies what the before endpoint knows. |
| Restart reconciliation | Its recorded `after` is usable. The response keeps `observation:"reconciliation"` and `gap_ref`, and never claims the outage's intermediate edits were recovered. |
| Identical hashes on both sides of a gap | `identical` endpoint bytes. The gap is still reported; it is not "healed". |
| Snapshot `unavailable{oversize \| unreadable \| unstable \| io-error}` | That side is unavailable with the **original capture reason**. No additions or removals are inferred from it. |
| `baseline-unknown` (under a scope whose scan failed) | Prior existence and content are unknown. An `absent` side is never fabricated. |
| **Missing blob** (a referenced CAS object is gone) | That side is `unavailable`, `before-blob-missing` / `after-blob-missing`. The cause is not stated as GC unless that is separately established. |
| Before endpoint not establishable (§2.2) | `unavailable`, `before-unknown-boundary`. This is distinct from a missing blob. |
| Path never recorded through A | No file row is invented. The inventory makes no claim about such paths. |
| **Incomplete inventory**: baseline not complete at B, or `unknown_scopes` non-empty | The response returns `inventory.baseline_completed_seq` (or `null`) and `unknown_scopes`. "No detected changes" is qualified by that coverage. |
| Excluded by capture policy: the store directory, `.git`, symlinks (`src/session.ts:426`, `:991`) | Excluded targets are never read. The baseline walk records no event for a skipped symlink, which is a pre-existing disclosure gap, so the response states the policy exclusions as static metadata (`inventory.policy_exclusions`). A *previously captured* path that later becomes a symlink can still appear, as content → `absent` (see "File removed"). This proposal reports the gap but does not add capture events (that is a capture change, and not ours to make here). |

---

## 3. Decisions for Brian

Answer each with a letter, for example `F1 A · F2 A · F3 A · F4 A · F5 A · F6 A`.
Admission numbers are **not** a letter choice. Under D7 they are approved later,
from measurements (§5.3).

| # | Question | Options | Recommendation |
|---|---|---|---|
| **F1** | **Baseline anchor.** What does "Before" mean? | **A** explicit recorded cutoffs. The default is the session's `capture.baseline.completed` seq → the durable head the client chose, labelled "Recorded at #B → Recorded at #A". **B** A plus a task-start *preset* (B = the seq before a `task.started`), labelled "Recorded before task *title*". It must never read "before story", since task grouping is a hint, not authorship or completion. **C** a true "Before story" or Git baseline, which needs a story model and a new content source (Git reading), both outside the current design. | **A**, with B as a later, cheap client preset. C reverses "Task, not story" and the no-Git-reading position, so it needs its own design. |
| **F2** | **Inventory.** What does "Entire codebase" / "unchanged" claim? | **A** *observed files*: the scope is paths recorded in this session, with unknown scopes and policy exclusions disclosed. "Unchanged" becomes "No detected interface change in observed files". **B** a complete repository inventory, which needs a separate capture/inventory design. | **A**. Rename "Entire codebase" → "Observed files". |
| **F3** | **Shared-type propagation depth.** | **A** not analyzed initially (`shared_types:"notAnalyzed"`), kept as named follow-ups. **B** type-declaration changes: per-file extraction of named types' fields (the `User` card without links). Cost is about the same as function extraction. **C** B plus bounded *captured* cross-file **syntactic mentions**, depth 1: TS explicit relative imports between captured files; Swift same-name candidates across captured files, labelled "candidate". This reads captured bytes only, never the compiler project. It **interacts with DA-3 ("no cross-file matching") and the Part 6 wording "never consult … imports"**, so it needs Brian's explicit ruling that resolving captured imports is not a second source. **D** compiler-level resolution, which needs captured build configuration and toolchains; reading the live project would violate the captured-only boundary. | **A** for the first version. Approve **B** as the next slice after inputs/outputs. Decide C only after B, with measured scan cost. D is not recommended. |
| **F4** | **Effects and behavioural notes.** | **A** not analyzed initially; the view shows "Effects not analyzed". **B** later, direct-body **syntax evidence**: for example "calls `db.users.update`", "`throw new AccessError`", "calls `emit("activity.changed")`", each with a source span and declared limits. This never becomes "Writes users" or "Emits" as semantic fact. **C** the illustrated semantic claims and prose ("Writes users", "Now checks Active", "Now returns the updated user."), which need a separate evidence/uncertainty design. If sourced from an agent, they are an agent's claim, not a daemon finding. | **A** now. Next scope is **B**. C needs its own design. |
| **F5** | **Range failure policy.** If one file cannot be compared, what happens to the others? | **A** keep the ready files' rows. A failed file shows no rows and its reason, and the page status is `partial`. DA-3 ("incomplete ⇒ no rows") still holds **per file**. **B** any failure empties the whole range. | **A**. Under B, one oversize or `#Preview` file would blank the whole view. |
| **F6** | **Contract direction.** | **A** a new `interface.v2` range endpoint. The unbuilt v1 per-change endpoint plan (T5b.3) is superseded. The v1 core, schema and corpus stay as historical executable material. A single-change view is `B = change_seq − 1`, `A = change_seq`, plus `path_prefix`. **B** also ship a separate per-change `interface.v1` endpoint. | **A**. There is no compatibility debt, because the v1 endpoint never existed and no consumers exist (pre-release). |

Already settled, and **not** reopened here:

- D2 declaration scope; D3 correspondence; D4 written-header signature; D5
  whole-file completeness; D6 versioning; D8 ordering; D10 precedence.
- **DA-4**: Swift is required and TypeScript may land first. TypeScript alone
  never completes the feature.

### 3.1 Supported language subsets

The table below proposes what each language extractor covers. Both languages
**exclude** anonymous callbacks, local and nested declarations, accessors,
subscripts and macro-generated declarations. Each extractor publishes its
exclusions in its metadata.

| Construct | TypeScript / TSX (`typescript.v2`) | Swift (`swift.v1`) |
|---|---|---|
| Declarations | Named functions, overload signatures, methods, constructors, named function-valued bindings (`const` / `let` / `var`, incl. TSX components), per D2 | `func`, methods, extension members, protocol requirements, `init` |
| Parameters | Ordered written name or pattern, annotation, `?`, rest, default syntax | Ordered external label and local name, annotation, default syntax, variadic, `inout` |
| Destructuring | The written pattern is kept as **one** parameter; individual arguments are not invented | — |
| Return | Written annotation. A missing annotation is `unknown` (inferred, not computed) | Written `-> T`. An omitted clause on `func` is `implicit: Void` (language-defined) |
| Constructors / `init` | No return slot | A distinct `initializer` result that keeps the failable `?`/`!`. `-> Self` is never fabricated |
| Throws | `notExpressible`, **never** "does not throw" | `throws` / `rethrows`. Typed `throws(E)` only if the pinned grammar corpus proves it parses clean |
| Async, generics, constraints, modifiers | Preserved as written | Preserved (`async`, generic params, `where`) |
| Overloads | D3: exact match first; an ambiguous remainder makes the file `incomplete` | Same; argument labels belong to the signature |
| `#if` | — | Every branch is traversed and syntactic guards are kept. Build settings are never evaluated |
| Known gaps | — | `#Preview` parses with ERROR, so the whole file is `incomplete` (SWIFT-GRAMMAR.md) |

Parsing rules for both languages:

- Any ERROR or MISSING node makes that file side `incomplete`, and the file emits
  no rows.
- A clean parse that contains an eligible construct the extractor cannot
  represent is also `incomplete / unsupported-construct`. It is never skipped
  silently.
- Normalization works through syntax tokens, dropping trivia while keeping
  literal values and token boundaries. It never uses a regex that strips
  whitespace.

### 3.2 Cost of cross-file resolution

Each propagation level multiplies the work per request:

- **None (F3-A):** at most two blob parses per changed file. Files with
  identical endpoints need no parse.
- **Same-file types (F3-B):** reuses the same parses.
- **Captured cross-file (F3-C):** finding consumers of a changed type means
  scanning **candidate consumer files, including unchanged ones**. Parsing only
  the changed file cannot find its callers. The cost grows with the observed
  inventory, not with the number of changed files. Several constructs need
  explicit handling or an `unknown` result:
  - package imports, path aliases, re-exports, declaration merging and
    ambient types;
  - generic substitution.

  Swift imports name modules, not files. Without captured module membership,
  a same-named type elsewhere is only a candidate.
- **Compiler-level (F3-D):** needs captured `tsconfig`, dependency, module and
  toolchain inputs. It is out of scope for a watcher.

---

## 4. Proposed public contract (`interface.v2`): PROPOSAL, not pinnable

### 4.1 Integration boundary

The contract depends only on existing public identifiers, whose meanings are
unchanged:

- **`session_id`**: capture scope (which worktree is watched), never
  authorship.
- **event `seq`**: a per-session, monotonically increasing decimal string. `H`
  is the durable high-water.
- **snapshot SHA-256**: the content address of recorded bytes, served by the
  existing authenticated blob route.

The following work in other streams could interact with these identifiers:

- **Several simultaneous captures** (IMPLEMENTATION_PLAN "Future: several
  simultaneous captures"). This keeps `seq` per session and every event keyed by
  `session_id`, so there is no conflict. A comparison **cannot span sessions**.
  If auto-connect or restart ever splits one worktree's work across sessions, a
  cross-session "before" needs its own design, and the client must not stitch
  sessions together.
- **Auto-connect** ("capture the worktree" split from "bind an agent"). This
  starts captures earlier, which gives a better default F1 anchor. It is not a
  semantic change. **Real dependency:** if a future change lets `session_id`
  mean anything other than capture scope, this contract must be revisited.
- **Session removal and GC.** Removing a session tombstones it, and requests
  for it return `410`. GC then marks every blob referenced by any non-removed
  session and sweeps the rest of the shared CAS (`src/maintenance.ts`).
  - A blob shared with a retained session survives.
  - A retained session's endpoint becomes `*-blob-missing` only if a CAS object
    is lost outside normal GC.
- **Stream worker.** Stream rows are keyed by `change_seq`, and range rows by
  `(B, A)`. The selection value is shared (§6.4).

### 4.2 Routes

```text
GET /v1/sessions/:session_id/interfaces
      ?before_seq=B&after_seq=A&limit=16
      [&path_prefix=src/]           exact byte-prefix filter on recorded paths
      [&after_path=<cursor>]        exclusive, from page.next_after_path
      [&include_identical=true]     also list paths whose endpoints are equal (§2.2)
GET /v1/schemas/projections/interface.v2
```

The endpoint is GET only. There is no POST, job, polling handle, projection
event, persisted index or new GC root. Source bytes come from the existing blob
route.

**Request validation:**

- `B` and `A` are required.
- The server rejects:
  - unknown or duplicate parameters;
  - non-canonical decimal strings;
  - `B > A`;
  - an unsafe `path_prefix` (absolute path, `..`, NUL).
- Pagination freezes `B`, `A`, the filter and the projection version.
- Paths are ordered by exact UTF-16 code unit (D8), with no case or Unicode
  normalization.

**HTTP status codes** follow the reader's existing conventions:

| Code | When |
|---|---|
| `200` | Any projection disposition, including `unavailable` / `unsupported` / `skipped`. |
| `400` | Malformed request. |
| `401` | Existing authentication failure. |
| `404` | Unknown session. |
| `409` | `A > H`, with the `slipstream-durable-seq` header, as on the events cursor. |
| `410` | Removed session. The tombstone is rechecked after async resolution, following the existing deletion-race discipline. |
| `500` | Corrupt recorded chain or internal failure. |

Error bodies stay **text**, as the reader's are today. No JSON error envelope is
invented.

### 4.3 Envelope (PROPOSAL)

```jsonc
{
  "projection_version": "interface.v2",
  "session_id": "…",
  "range": { "before_seq": "10", "after_seq": "20" },
  "status": "ready",                      // ready | partial | skipped (page level)
  // "fallback_reason": "…"               // required iff status == skipped
  "inventory": {
    "scope": "observed",                  // F2-A
    "baseline_completed_seq": "10",       // null if the baseline was not complete by A
    "unknown_scopes": [],                 // from capture.baseline.completed.v1
    "unknown_scopes_complete": true,      // false when capped (see "Metadata cap")
    "policy_exclusions": ["store-directory", ".git", "symlinks"]
  },
  "analysis": {                           // F3/F4 — every value "notAnalyzed" under A
    "shared_types": "notAnalyzed",
    "effects": "notAnalyzed",
    "behavior": "notAnalyzed"
  },
  "gaps": [ { "seq": "14", "reason": "restart", "scope": "…" } ],
  "gaps_complete": true,                  // false when capped; the full list is on the event stream
  "files": [ /* §4.4 */ ],
  "page": { "complete": true, "next_after_path": null }
}
```

What the page-level `status` values mean:

- **`ready`**: every returned file is `ready` or `identical`. This includes an
  empty page. It does **not** mean complete repository inventory, complete
  history, all pages loaded, or any semantic analysis.
- **`partial`** (F5-A): at least one returned file has another status. This
  includes a page on which every file failed. Every such file has
  `changes: []`.
- **`skipped`**: the page returned no file rows because no file could start.
  The causes are admission rejection or a deadline before the first file,
  `scan-limit`, or shutdown. `page.complete` is `false` and the cursor does not
  move.

**Deadline and cancellation mid-page.**

- Files already finished keep their results.
- The file in progress is returned with its §4.4 status. That is
  `skipped / timeout` or `skipped / cancelled` unless a higher-precedence
  condition was already established; for example, a before-side parse error
  still wins.
- The page ends there, with `page.complete: false`. `next_after_path` is that
  file's path, so the next request moves past it.
- A client can retry one file on its own with `path_prefix`.

**Filtering.** By default, `files` omits results whose status is `identical`.
A missing blob is never `identical` (§4.4), so it is always listed. With
`include_identical=true`, `identical` results are listed too. This supports
"Show unchanged branches".

**Metadata cap.** `gaps` (ordered by `seq`) and `unknown_scopes` (ordered by
path) share a 64 KiB serialized budget. Entries beyond it are omitted, and the
matching `gaps_complete` / `unknown_scopes_complete` flag becomes `false`.

- The cap is explicit, never silent.
- The full lists stay on the public event stream.
- The envelope is therefore bounded, so the rest of the response budget is
  always available to file results.

### 4.4 File result

```jsonc
{
  "path": "src/services/activity.ts",
  "before": { "record_seq": "4",  "field": "snapshot",
              "snapshot": { "kind": "content", "sha256": "…", "size": 412 } },
  "after":  { "record_seq": "19", "field": "after",
              "snapshot": { "kind": "content", "sha256": "…", "size": 431 },
              "observation": "watcher" },        // or "reconciliation" + "gap_ref"
  "language": "typescript",                      // plain string, never an enum; null iff no module for the path
  "language_version": "typescript.v2",           // null iff no module, whatever the status
  "status": "ready",
  "coverage": { "before": { "state": "complete" }, "after": { "state": "complete" } },
  "changes": [ /* §4.5 */ ]
}
```

A file has exactly one `status`. The first established condition in this order
wins, extending D10:

| # | Condition | `status` | `fallback_reason` |
|---|---|---|---|
| 0 | Endpoints are equal (§2.2), and for content the blob is still retained. Retention is checked on every request. No parse happens; content coverage is `notEvaluated` and absent coverage is `absent`. A missing blob falls through to row 5/6 | `identical` | — |
| 1 | Before extraction incomplete | `incomplete` | `before-parse-error` / `before-unsupported-construct` |
| 2 | After extraction incomplete | `incomplete` | `after-parse-error` / `after-unsupported-construct` |
| 3 | Duplicate declaration | `incomplete` | `duplicate-declaration` |
| 4 | Ambiguous correspondence | `incomplete` | `ambiguous-correspondence` |
| 5 | Before side not comparable | `unavailable` | `before-blob-missing` / `before-unknown-boundary` / `before-<capture reason>` |
| 6 | After side not comparable | `unavailable` | `after-blob-missing` / `after-<capture reason>` |
| 7 | No language module | `unsupported` | `unsupported-language` |
| 8 | Per-file limit: input bytes, declarations, syntax visits, or a single file result larger than the response ceiling. This is **terminal**: retrying gives the same result, and the cursor moves past the file | `skipped` | `too-large` |
| 9 | Deadline or cancellation hit this file. This is **retryable** | `skipped` | `timeout` / `cancelled` |
| 10 | Comparison succeeded | `ready` | — |

The D10 consequences in [INTERFACE-PROJECTION.md](INTERFACE-PROJECTION.md#status-precedence-d10)
carry over, with two v2 exceptions:

- `identical`, like `ready`, has no `fallback_reason`.
- `language` / `language_version` are `null` exactly when no module exists for
  the path, whatever the status (§5.3). One boundary case needs its own shape: an unknown before
boundary is `"before": { "kind": "unknownBoundary" }` with coverage
`{ "state": "unavailable", "reason": "unknown-boundary" }`, and it has no
recorded provenance.

### 4.5 Change rows and component deltas

The `setActivity` card from the owner design, using real TypeScript sources:

```ts
// before — src/services/activity.ts
export async function setActivity(userId: string, active: boolean): Promise<void> {}
// after
export async function setActivity(userId: string, state: ActivityState): Promise<User> { return user; }
```

The proposed row:

```jsonc
{
  "kind": "signatureChanged",                   // added | removed | signatureChanged (D3)
  "identity": { "kind": "function", "scope": [], "name": "setActivity", "guards": [] },
  "before": { "display_name": "setActivity", "span": { "byte_start": 0, "byte_end": 84 } },
  "after":  { "display_name": "setActivity", "span": { "byte_start": 0, "byte_end": 103 } },
  "parameters": [
    { "op": "equal",
      "before": { "position": 0, "name": "userId", "type": { "state": "written", "text": "string" } },
      "after":  { "position": 0, "name": "userId", "type": { "state": "written", "text": "string" } } },
    { "op": "removed",
      "before": { "position": 1, "name": "active", "type": { "state": "written", "text": "boolean" } },
      "after": null },
    { "op": "added",
      "before": null,
      "after":  { "position": 1, "name": "state", "type": { "state": "written", "text": "ActivityState" } } }
  ],
  "result": {
    "op": "changed",
    "before": { "kind": "return", "type": { "state": "written", "text": "Promise<void>" } },
    "after":  { "kind": "return", "type": { "state": "written", "text": "Promise<User>" } }
  },
  "throws": { "op": "equal", "before": { "mode": "notExpressible" }, "after": { "mode": "notExpressible" } },
  "header": {                                    // everything in the D4 header not covered above
    "op": "equal",
    "before": { "modifiers": ["export", "async"], "generic_parameters": [], "constraints": [] },
    "after":  { "modifiers": ["export", "async"], "generic_parameters": [], "constraints": [] }
  }
}
```

**Component operations.** `equal` is `=`, `added` is `+`, `removed` is `−`, and
`changed` is `~`. The client may render `changed` as a `−` line followed by a
`+` line, as the design does for `Promise<void>` → `Promise<User>`.

**Parameter pairing.** Within one matched declaration, a parameter's pairing
key is its written **local name**. Two parameters pair only when that name
occurs exactly once on each side.

- A change of label, default, type, position, `inout`, variadic or optional is
  reported as `changed`.
- A different name is `removed` plus `added`. For example, `active` → `state`
  is exactly the design's `− active` / `+ state`.
- Some parameters have no usable key. These are:
  - a Swift `_` local name;
  - a destructured pattern;
  - a name that occurs more than once.

  They are never paired. They are always `removed` plus `added`, with no
  guessed correspondence, even when the text is identical.

**Components outside the parameter list.**

- `result` and `throws` are single slots.
- Any other part of the D4 header that changes (a modifier, generics, a
  constraint) appears under `header`. A change there is always visible, even
  when no parameter or return changed.

**Type states.** The `state` field distinguishes three cases:

- `written`: the annotation is present in the source. A TS annotation that is
  literally `unknown` is `written: "unknown"`.
- `implicit`: the language defines the type, as with Swift's `Void`.
- `unknown` with a `reason`: nothing is written, so the type would be inferred
  (`"inferred-not-computed"`). Extraction is complete, but the type is unknown.

A written `User` annotation is fully extracted **syntax** even while the meaning
of `User` is not analyzed (`analysis.shared_types: "notAnalyzed"`).

**Identity and renames.** v1's `(kind, scope[], name, guards[])` stays the
declaration key, scoped to the path:

- There is no overload ordinal and no line number in identity.
- A rename, a path move, a scope move and a guard move are each reported as
  removed plus added.
- The TS extractor keeps the overload-signature role separate from the
  implementation role, so a legal TypeScript overload set never becomes an
  accidental `duplicate-declaration`.

**Selection identity.** A selection is comparison-local:
`(session_id, B, A, path, projection_version, language_version, identity, side span)`.
It is **not** a permanent symbol ID.

**Ordering:**

- Files are ordered by path, by exact UTF-16 code unit.
- Declarations follow D8 order: removed, then signatureChanged, then added, then
  the D8 tuple.
- Parameters are ordered as follows. Rows with a `before` side (`equal`,
  `changed`, `removed`) come first, in before-position order. `added` rows
  follow, in after-position order. Positions are unique per side, so this order
  is total. For `setActivity` this gives `userId`, `− active`, `+ state`, as in
  the design.

### 4.6 Versioning

- **`projection_version: "interface.v2"`** covers the envelope, the range and
  boundary rules, and the component model. It is a **new version**, not additive
  to v1, because the unit changes from one change's opaque signatures to a range
  of structured contracts. It relies on pre-release freedom; it does not claim
  compatibility.
- **`language_version`** follows D6 (`typescript.v2`, `swift.v1`). Any extractor,
  grammar or normalization change bumps it, and results never change under an
  unchanged tuple.
- **Clients** decode the exact `(projection_version, language_version)` tuples
  they know. An unknown tuple is shown visibly as unsupported, never as
  best-effort.
- **interface.v1**: `src/interface-projection.ts`, `contracts/interface/v1/` and
  its 25-case corpus stay as they are. v2's comparison core extends the v1 core
  (same D3, D8 and D10 logic) rather than forking it.

### 4.7 Caching and compute

**Caching.** Each file comparison is pure and is cached by:

```
(before tag, after tag, language, language_version, projection_version)
```

- The key never contains `seq` or `session_id`; provenance is stamped
  afterwards.
- Timeout, overload, cancellation and availability-dependent failures are never
  cached.
- Blob retention is revalidated on every cache hit, so a cached result followed
  by a GC'd blob returns `*-blob-missing`.
- The whole range response is not cached.

**Admission.** The daemon runs one reader-owned **shared** admission budget for
clip and interface work (ADMISSION.md, T5b.1).

- Each page is one admitted unit, and it processes its files sequentially. There
  is no unbounded fan-out.
- The deadline covers queue wait, record resolution, blob reads, parsing,
  matching and output.
- Cancellation terminates real execution. Settling a promise is not proof that
  the CPU work stopped.
- Swift stays in the isolated `node --liftoff-only` child.

**Starting ceilings.** These are **measurement starting points, not approved
numbers**:

| Resource | Starting ceiling |
|---|---:|
| Files per page | 16 (the caller may request fewer) |
| Blob bytes | 1 MiB per side, 8 MiB per page |
| Eligible declarations | 4,096 per side |
| Syntax visits | 100,000 per side |
| Response | 512 KiB. When the next file result would cross the ceiling, the page ends before it (`page.complete: false`, cursor at the last returned file). If that result is the page's **first** and does not fit beside the bounded envelope, it becomes `skipped / too-large` instead, so every page makes progress. Content is never truncated |
| Prefix scan for endpoint resolution | 100,000 records / 16 MiB, then `skipped / scan-limit` |
| Disposable cache | 128 entries / 16 MiB |

**Risk on record.** A cold Swift invocation measured about 210 ms end to end
(SWIFT-GRAMMAR.md), and the provisional shared deadline is `D = 100 ms`. Cold
Swift pages will time out under the provisional numbers. If measurement
justifies a longer interface deadline, clip's 100 ms ceiling must stay enforced
separately. Raising the shared `D` would quietly relax clip behaviour.

**Scan cost.** Endpoint resolution scans the log prefix for every page. For a
large baseline (for example one that includes `node_modules`) this is
O(records) per page. FD3 must measure it. Until measured, the design hits the
honest `scan-limit` rather than adding a persisted index.

### 4.8 Client rules

The daemon owns analysis. The client owns:

- **Tree building.** Build containment by splitting `path` on `/` and attaching
  declarations under their file.
- **Counts.** A changed declaration counts **once**, however many component rows
  it has. A future type row counts separately.
- **Labels.** "N loaded changes" applies until `page.complete`. When some files
  failed, the label is "N detected changes · M files not compared". A zero with
  missing coverage is never an unchanged badge.
- **Honest distinctions.** These must render differently from one another:
  - `identical` ("no net change");
  - `ready` with `changes: []` ("no detected interface change");
  - `incomplete`, `unavailable`, `unsupported` and `skipped` (each with its
    reason).

---

## 5. Proposed examples and fixtures

These are **design proposals**, not runtime output and not approved fixtures.
Sources are shown without their trailing newline. Final fixtures store exact
bytes, and their hashes and spans are computed from those bytes.

### 5.1 Full worked example: parameter type change

Request:

```text
GET /v1/sessions/11111111-1111-4111-8111-111111111111/interfaces?before_seq=10&after_seq=20&path_prefix=src/f.ts&limit=1
```

Sources (each 31 bytes including the `\n`; the declaration spans `[0,30)`):

```ts
// before  sha256 86e1381da984ad21459e1e796d08963d95ee1ef6eca5987ecf6fa1fef5d64e46
function f(x: number): void {}
// after   sha256 a0f5933b9b22cb5a09402ec1d063c10504d634ea717c939360f5fde690a4be6d
function f(x: string): void {}
```

Proposed response:

```json
{
  "projection_version": "interface.v2",
  "session_id": "11111111-1111-4111-8111-111111111111",
  "range": { "before_seq": "10", "after_seq": "20" },
  "status": "ready",
  "inventory": { "scope": "observed", "baseline_completed_seq": "10", "unknown_scopes": [],
                 "unknown_scopes_complete": true,
                 "policy_exclusions": ["store-directory", ".git", "symlinks"] },
  "analysis": { "shared_types": "notAnalyzed", "effects": "notAnalyzed", "behavior": "notAnalyzed" },
  "gaps": [], "gaps_complete": true,
  "files": [{
    "path": "src/f.ts",
    "before": { "record_seq": "4", "field": "snapshot",
      "snapshot": { "kind": "content", "sha256": "86e1381da984ad21459e1e796d08963d95ee1ef6eca5987ecf6fa1fef5d64e46", "size": 31 } },
    "after": { "record_seq": "20", "field": "after", "observation": "watcher",
      "snapshot": { "kind": "content", "sha256": "a0f5933b9b22cb5a09402ec1d063c10504d634ea717c939360f5fde690a4be6d", "size": 31 } },
    "language": "typescript", "language_version": "typescript.v2",
    "status": "ready",
    "coverage": { "before": { "state": "complete" }, "after": { "state": "complete" } },
    "changes": [{
      "kind": "signatureChanged",
      "identity": { "kind": "function", "scope": [], "name": "f", "guards": [] },
      "before": { "display_name": "f", "span": { "byte_start": 0, "byte_end": 30 } },
      "after":  { "display_name": "f", "span": { "byte_start": 0, "byte_end": 30 } },
      "parameters": [{ "op": "changed",
        "before": { "position": 0, "name": "x", "type": { "state": "written", "text": "number" } },
        "after":  { "position": 0, "name": "x", "type": { "state": "written", "text": "string" } } }],
      "result": { "op": "equal",
        "before": { "kind": "return", "type": { "state": "written", "text": "void" } },
        "after":  { "kind": "return", "type": { "state": "written", "text": "void" } } },
      "throws": { "op": "equal", "before": { "mode": "notExpressible" }, "after": { "mode": "notExpressible" } },
      "header": { "op": "equal",
        "before": { "modifiers": [], "generic_parameters": [], "constraints": [] },
        "after":  { "modifiers": [], "generic_parameters": [], "constraints": [] } }
    }]
  }],
  "page": { "complete": true, "next_after_path": null }
}
```

### 5.2 Required cases

Every case uses the §5.1 request shape and varies only the path and the recorded
history. In each case the file result is what matters.

| Case | TypeScript before → after | Swift before → after | Expected file result |
|---|---|---|---|
| `parameter-change` | `function f(x: number): void {}` → `function f(x: string): void {}` | `func f(_ x: Int) {}` → `func f(_ x: String) {}` | `ready`. One `signatureChanged` row, parameter `changed`, result `equal` (Swift `implicit: Void`). |
| `return-change` | `function f(): number { return 1; }` → `function f(): string { return "1"; }` | `func f() -> Int { 1 }` → `func f() -> String { "1" }` | `ready`. Result `changed`, parameters `[]`. |
| `added-function` | *(empty file)* → `function f(): void {}` | *(empty)* → `func f() {}` | `ready`. One `added` row with every component `added`. Before coverage is `complete` (empty, **not** absent). |
| `added-file` | *(absent)* → `function f(): void {}` | *(absent)* → `func f() {}` | `ready`, `added`. Before coverage is `absent`. Before provenance is the first change's `field:"before"` (§2.2). |
| `removed-function` | Reverse of `added-function` | Reverse | `ready`, one `removed` row. |
| `removed-file` | Reverse of `added-file` | Reverse | `ready`, `removed`. After coverage is `absent`. |
| `unchanged-signature` (body-only) | `function f(): number { return 1; }` → same header, `return 2;` | `func f() -> Int { 1 }` → `func f() -> Int { 2 }` | `ready`, `changes: []`. `analysis.effects` / `behavior` are `notAnalyzed`, so this is not a claim of equal behaviour. |
| `inferred-return` | `function f() { return 1; }` → `function f() { return "1"; }` | `func f() { print(1) }` → `func f() { print("1") }` | `ready`, `changes: []`. The TS result is `unknown / inferred-not-computed` on both sides. **No change is claimed and no equality is claimed beyond the written header.** Swift is `implicit: Void` on both sides. |
| `shared-type-only` | `src/types/user.ts`: `export interface User { isActive: boolean }` → `{ isActive: ActivityState }`. `src/access.ts` identical: `import type { User } from "./types/user";` + `export function canAccess(user: User): boolean { return true; }` | `User.swift`: `struct User { var isActive: Bool }` → `{ var isActive: ActivityState }`. `Access.swift` identical: `func canAccess(_ user: User) -> Bool { true }` | Under F3-A: `user.ts` is `ready` with `changes: []` (it has no function declarations); `access.ts` is `identical` (listed only with `include_identical`); `analysis.shared_types` is `notAnalyzed`. `canAccess` is **never** reported as changed or as semantically unchanged. Under F3-B/C, separate expected files are added. The F3-A output is never reused as proof that propagation is correct. |
| `overload-ambiguity` | `declare function f(x: number): number;` `declare function f(x: string): string;` → both gain `, y` of the same type | `protocol P { func f(_ x: Int) -> Int; func f(_ x: String) -> String }` → both gain `_ y` | `incomplete / ambiguous-correspondence`, `changes: []`. |
| `parse-failure` | `function f(x: {` → `function f(x: number): void {}` | `func f(_ x: ` → `func f(_ x: Int) {}` | `incomplete / before-parse-error`, `changes: []`. After coverage is still `complete`. |
| `swift-preview` | — | `#Preview { Text("a") }` + `func f() {}` → `func f(_ x: Int) {}` added | `incomplete / before-parse-error`. This is the disclosed `#Preview` grammar gap. |
| `unsupported-language` | `src/f.py`: `def f(x): return x` → `def f(x, y): return y` | — | `unsupported / unsupported-language`. `language` and `language_version` are `null`. |
| `missing-content` (blob gone) | The `parameter-change` pair with the before CAS object deleted | Same | `unavailable / before-blob-missing`, `changes: []`. **Never** `added`. |
| `missing-content` (capture unavailable) | Before snapshot is `unavailable{oversize}`; the after source is valid | Same | `unavailable / before-oversize`. Never `added`. |
| `missing-content` + unsupported | `.py` path with a missing blob | — | `unavailable / before-blob-missing` (unavailable outranks unsupported). |
| `unknown-boundary` | The path has **no record at or before B**, and either its first later record is a baseline snapshot (for example `B = 0`) or the baseline was incomplete at B | Same | `unavailable / before-unknown-boundary`, with before endpoint `{ "kind": "unknownBoundary" }` and no provenance. Never `added`. |
| `known-path-incomplete-baseline` | The path was baselined before B; other files were still being scanned at B; then a parameter change | Same | `ready`, a normal `signatureChanged`. `inventory.baseline_completed_seq` discloses that the baseline was incomplete. |
| `parameter-reorder` | `function f(a: number, b: number, c: number)` → `function f(c: number, a: number)` | `func f(_: Int, _: String) {}` → `func f(_: String, _: Int) {}` | TS: `a` changed (position), `b` removed, `c` changed (position), in before order. Swift: the `_` names have no key, so there are two `removed` rows and then two `added` rows. |

**Swift-specific cases:**

- **Labels, defaults and effects in the header.**

  ```swift
  func move(from point: inout Point, count: Int = 1) async throws -> Bool { true }
  ```

  becomes

  ```swift
  func move(at point: inout Point, count: Int = 2) async throws -> Bool { true }
  ```

  The result is one `signatureChanged` row:
  - `point`: `changed` (the label changed);
  - `count`: `changed` (the default changed);
  - result `equal`;
  - throws `equal` as `throws`, which does not imply the function actually
    throws.
- **Other required constructs:** `init?` result, generics and `where`, variadic,
  `#if` guard move, and an extension member.

**Boundary cases.** The final set also covers these recorded-history cases:

- incomplete baseline at B;
- first-change predecessor;
- gap with unchanged hashes;
- restart reconciliation;
- add-then-remove inside the range (`absent` → `absent` → `identical`, also for a `.py` path);
- all-failed page (`partial`) and deadline mid-page;
- oversized single file result (`too-large`) and gap cap (`gaps_complete: false`);
- a captured file replaced by a symlink (content → `absent`);
- `A > H` → `409`;
- a huge decimal `seq`;
- corrupt predecessor chain → `500`;
- page boundary with `next_after_path`;
- cache hit followed by blob loss.

**"Unavailable" versus "no detected changes".** These fragments are what must
never be confused:

```json
{ "status": "identical", "changes": [] }
{ "status": "ready", "changes": [] }
{ "status": "incomplete", "fallback_reason": "before-parse-error", "changes": [] }
{ "status": "unavailable", "fallback_reason": "before-blob-missing", "changes": [] }
{ "status": "unsupported", "fallback_reason": "unsupported-language", "changes": [] }
{ "status": "skipped", "fallback_reason": "timeout", "changes": [] }
```

### 5.3 Fixture ownership and Swift pinning

**The daemon owns the fixtures.** Once F1–F6 are settled, this PR adds:

- `contracts/interface/v2/schema.json`;
- `contracts/interface/v2/cases/<name>/` containing `history.json` (the
  synthetic recorded records and blobs), `request.txt` and
  `expected.json`;
- a fixture-validation check under `node tools/projection-check.ts`.

The validation check proves:

- every `expected.json` validates against the schema, using `src/schema.ts`;
- cross-field invariants hold:
  - `changes` is non-empty only when the status is `ready`;
  - `fallback_reason` is present exactly for `incomplete`, `unavailable`,
    `unsupported` and `skipped`;
  - `language` and `language_version` are `null` exactly when no module exists
    for the path, whatever the status;
- source hashes and sizes match the stored bytes;
- every span slices whole UTF-8 characters, checked with a fatal decode;
- a deliberately malformed fixture is **rejected**.

The expected outputs are **hand-written**. They are not generated by the
extractor they will later test.

Schema validation proves shape, not extractor correctness. Correctness comes
from FD1, FD2 and FD3 running the same cases.

`src/schema.ts` ignores `if`/`else`, `maxItems` and `additionalProperties`. Any
invariant that would need those is checked in code in the validator.

**Swift pins a revision:**

- Copy only the approved synthetic `contracts/interface/v2/` files into
  `Tests/SlipstreamCoreTests/Fixtures/interface-v2/`.
- Add a `PIN` file recording the daemon commit SHA and each copied file's
  SHA-256.
- A Swift test re-hashes the copied files against `PIN`, and fails on drift or
  on an unknown `(projection_version, language_version)` tuple.
- To update, bump `PIN` and re-copy. The files are never edited in place. No
  captured data is ever copied.

---

## 6. Implementation graph (after F1–F6 are settled)

The design PR (this one) finalizes the schema and fixtures once F1–F6 are
settled. There is no separate "promote the contract" PR.

```text
[this PR] decisions + schema + fixtures + validator
   ├── FD1 TypeScript structured extractor ─┐
   ├── FD2 Swift structured extractor ──────┼── FD4 service + GET + schema serving ── FD5 measured acceptance (D7 gate)
   ├── FD3 range endpoint resolver ─────────┘                         │
   └── FS1 Swift decode + fixture pin ── FS2 fixture-backed view ─────┴── FS3 live wiring

Optional, only if approved (F3/F4):
   FT1 type-declaration changes (F3-B) → FP1 captured references (F3-C) → Swift type/reference presentation
   FE1 direct-body syntax evidence (F4-B) → Swift effects presentation
```

### 6.1 Daemon slices

| Slice | Failing cases written first | Done when | Independent live acceptance |
|---|---|---|---|
| **FD1** TS/TSX extractor (`typescript.v2`) | parameter / default / return change; legal overload set versus ambiguity; destructured parameter; inferred return; body-only; TSX function binding; Unicode before declaration; malformed sibling makes the file incomplete | Every TS fixture in `contracts/interface/v2` is reproduced by a pure extractor over whole blobs. Exclusions are published. There is no endpoint | `projection-check interface-v2 --lang typescript` extracts synthetic TS pairs from a **disposable** store and compares them with hand-written expectations. |
| **FD2** Swift extractor (`swift.v1`) | labels; `inout`; variadic; defaults; `async` / `throws`; generics and `where`; protocol requirement; `init?`; `#if` guard move; `#Preview` incomplete; Unicode | Every Swift fixture matches. Parsing stays in the `--liftoff-only` child with cancellation kept | An isolated extraction checker over captured Swift blobs, including the `#Preview` refusal. The daemon process stays alive throughout. |
| **FD3** Range resolver | first-change predecessor; incomplete baseline; unknown scopes; gap; reconciliation; revert; add-then-remove; huge `seq`; corrupt chain; scan limit | Endpoint selection, provenance and inventory match every boundary fixture. The scan is bounded. There is no language code | Capture edits in a disposable session, resolve B/A, and cross-check hashes and provenance against the public events from an independent script. Needs no interface route. |
| **FD4** Service and public surface | admission overload / timeout; shutdown; deletion race (`410`); cache hit then blob loss; pagination freeze; `409` with header; schema route; text errors | GET route and schema served. It uses the reader-owned **shared** budget (wiring what T5b.1 deferred) with both languages, disposable caching and bounded output | Authenticated requests against a disposable daemon cover: ready TS and Swift, a `partial` page, a missing blob, `409` / `410`, and a schema fetch. Stop every UI and repeat from a standalone script. |
| **FD5** Measurement gate | combined starvation; cold Swift; worker-retirement overlap; cancellation churn | All four D7 arms (ADMISSION.md) measured with TS, TSX and Swift. **Brian approves** `C/Q/W/D` and timeout rates. No success criterion is relaxed | The registered combined-load check. Crashes and missing data count as failures. This may be a gate rather than a PR. |

### 6.2 Swift slices

| Slice | Failing cases written first | Done when | Independent live acceptance |
|---|---|---|---|
| **FS1** Decode and pin | unknown version tuple; huge `seq` string; `partial` page; `identical` versus `ready` `[]`; absent versus unavailable; `null` language | Every pinned fixture decodes exactly. The `PIN` hash test passes. Unknown tuples surface visibly | `swift test` against the copied fixtures, with the hashes verified. |
| **FS2** Fixture-backed view | no-change versus failure; partial counts; unavailable side; unknown or inferred type; `notAnalyzed` banner; selection | The owner layout renders from approved fixtures with honest labels. The markers and legend match the design | Launch a fixture-backed native screen and inspect every uncertainty state and the source selection by hand. |
| **FS3** Live wiring | cutoff change; stale reply cannot overwrite a newer selection; pagination; reconnect with descriptor refresh; cancellation; blob loss | Uses the public API only. The stream stays responsive | Run a disposable live daemon with edits in both languages, restart and GC. Compare the UI with an independent HTTP consumer. |

### 6.3 What runs concurrently

After decisions are settled:

- **FD1, FD2, FD3 and FS1** run in parallel.
- **FS2** can run alongside all daemon work.
- **FS3** waits for FD4.
- The feature is complete only once both languages ship (DA-4) and FD5 is
  approved.

### 6.4 Coordination with the stream worker

- **Shared selection value.** Agree it once:
  `{session_id, before_seq, after_seq, path, side, sha256, span, projection_version, language_version}`.
  A stream row selects a single `change_seq`, which is the same as B = seq−1, A = seq.
- **Stream rows are single changes.** They keep their `change_seq`. A range row
  is never given one task or one attribution.
- **Shared navigation.** The tab bar, source opening and the selection store are
  **coordination points**. The stream worker owns stream rows and shared shell
  edits. This feature owns the Function changes page.
- **Source diffs.** A range source diff uses the selected endpoint blobs. The
  existing clip endpoint is tied to one change and cannot stand in for an
  arbitrary range.
- **Plan edits.** `IMPLEMENTATION_PLAN.md` edits stay small and are made by one
  designated editor per PR. Status lines change only against gates actually met.

---

## 7. Not in this proposal

The following are out of scope for this PR:

- Parsers, extractors, endpoints, workers, caches or Swift UI.
- A served or pinnable schema before F1–F6 are settled.
- New log events, projection events, persistence, a persisted symbol index, or
  new GC roots.
- Reading the live worktree, Git, compiler projects or harness logs.
- Changing capture, including adding symlink disclosure events.
- Changing any ratified decision (D2–D11, DA-1–DA-4) or any success criterion.
