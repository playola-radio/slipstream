# Interface projection (`interface.v1`)

The interface projection is a **reader-derived view** that reports how the
*named function-like declarations* of a single file changed between two
versions: which were **added**, which were **removed**, and which kept their
identity but changed **signature**. It is computed on demand from two content
versions; it is never a log event and never a second capture source.

This document is the contract for the **language-neutral core** shipped in
PR T5a.1: the declaration/identity model, the correspondence algorithm (D3),
the status-precedence table (D10), row ordering (D8), and the response
envelope. Per-language extraction (TypeScript, Swift, …) is out of scope here
and arrives in later PRs; the core has **zero language branches**.

## What identity is — and is not

An interface change row keys off a declaration's **identity**, a structured
value compared field-by-field (never a delimiter-joined string):

```ts
interface Identity {
  kind: string;                              // "function", "method", "constructor", …
  scope: Array<{ kind: string; name: string }>; // outermost → innermost; [] at top level
  name: string;                              // base declared name
  guards: string[];                          // syntactic #if nesting, outer → inner; [] when unguarded
}
```

- **Identity is a matching key, not proof of rename continuity.** Two
  declarations sharing an identity across versions are *treated as the same
  declaration for comparison*. That is a heuristic correspondence, not a claim
  that a human renamed or preserved anything. A rename is reported as a
  `removed` + an `added`, never as a single "renamed" row.
- **Guards are part of identity.** A function moved from `#if DEBUG` to
  `#else` (`guards: ["DEBUG"]` → `guards: ["!(DEBUG)"]`) is `removed` + `added`
  even if its signature is byte-identical — it is a different compiled
  declaration.
- **Overloads are distinguished by signature, never by an ordinal or source
  position.** Identity carries no overload index and no line/offset. Swift
  argument labels live in the **signature**, not in `name`, so a label change
  (`from:` → `at:`) is a `signatureChanged`, not remove+add.

### The signature

A declaration's `signature` is an **opaque string produced by the language
extractor and compared by exact equality**. The core never parses it. Two
declarations "have the same signature" iff their signature strings are equal
byte-for-byte. What belongs in the signature (parameter labels, defaults,
return type, generics) is each language extractor's decision, specified per
language in later PRs. Body-only edits leave the signature unchanged and
therefore emit no row.

### The span

Every declaration carries a **whole-declaration span** as a half-open range of
**UTF-8 byte offsets** `[byte_start, byte_end)` into that version's file. Byte
offsets, not code-point or code-unit offsets — the reader hands out raw bytes,
and a UTF-16 or code-point span would silently mislocate every declaration
after the first non-ASCII byte.

## Correspondence (D3)

`compare(before, after)` over two declaration lists, with **no similarity
scoring** anywhere:

1. **Duplicate detection, per side, before anything else.** Group each side by
   `(identity, signature)`. If any key occurs twice on either side, the two
   versions contain an indistinguishable pair — the comparison cannot be
   trusted, so the whole result is `incomplete / duplicate-declaration` with
   **no rows**. (Same identity with *different* signatures is a legal overload
   set, not a duplicate.)
2. **Exact matches consume first.** Declarations with an identical
   `(identity, signature)` on both sides correspond and emit no row.
3. **Group the leftovers by identity.** Within each identity group of the
   remaining unmatched declarations:
   - exactly **one** left on each side → one `signatureChanged` row
     (before → after);
   - leftovers on **both** sides with either count > 1 (e.g. `2` before / `1`
     after) → **ambiguous**: the whole comparison is
     `incomplete / ambiguous-correspondence` with **no rows**;
   - leftovers on **one** side only → each is `removed` (before) or `added`
     (after).

A same-scope move with an unchanged signature is an exact match and emits
nothing. `ready` with `changes: []` means **no interface changes within the
declared extraction scope — never behavioral equivalence** (bodies are not
compared) and never a claim that unparsed regions are unchanged.

## Status precedence (D10)

A result has exactly one `status`. When more than one condition holds, the
**first established** condition in this order wins (lower number = higher
precedence). "Established" means the fact is actually known — correspondence
outcomes require both sides to have been extracted (or absent); a side that was
never evaluated can never establish an empty-side conclusion.

| # | Condition | `status` | `fallback_reason` |
|---|-----------|----------|-------------------|
| 1 | Before extraction incomplete (ERROR/missing node) | `incomplete` | `before-parse-error` |
| 2 | After extraction incomplete | `incomplete` | `after-parse-error` |
| 3 | Duplicate declaration on either extracted side | `incomplete` | `duplicate-declaration` |
| 4 | Ambiguous correspondence | `incomplete` | `ambiguous-correspondence` |
| 5 | Before blob missing | `unavailable` | `before-blob-missing` |
| 6 | After blob missing | `unavailable` | `after-blob-missing` |
| 7 | No language module for the file | `unsupported` | `unsupported-language` |
| 8 | Admission rejected (too many declarations) | `skipped` | `overloaded` |
| 9 | Deadline expired | `skipped` | `timeout` |
| 10 | Work cancelled | `skipped` | `cancelled` |
| 11 | Both sides complete/absent, comparison succeeded | `ready` | *(omitted)* |

Consequences (all covered by the corpus):

- **`fallback_reason` is required on every non-`ready` status** and omitted on
  `ready`.
- **Every non-`ready` result carries `changes: []`.** A partial view never
  emits change rows (DA-3: honest partial policy).
- **`language_version` is `null` exactly when there is no module** (status
  `unsupported`), and only then. `language` is likewise `null` only then.
- A missing blob (5/6) outranks no-module (7): *no module + missing blob* →
  `unavailable / <side>-blob-missing` with `language_version: null`.
- Each side's `coverage` reports **that side's actual state** even when its
  reason lost precedence: before-parse-error with a fully-extracted after still
  shows `coverage.after.state = "complete"`.
- **Absent** before-file (never existed) → `ready`, all `added`, before
  coverage `absent`. **Empty** parsed before-file → `ready`, all `added`,
  before coverage `complete`. These are different facts and reported
  differently.
- Timeout/cancellation leaves unfinished sides `coverage.*.state =
  "notEvaluated"`; it never rewrites a side that *did* finish.

## Row ordering (D8)

Rows are sorted deterministically — **never by input order**. Strings compare
by **UTF-16 code unit** with no Unicode normalization and no locale; arrays
compare lexicographically with the shorter prefix first; byte offsets compare
numerically; a `null` counterpart sorts before any declaration.

Primary key is the change kind: `removed` (0), then `signatureChanged` (1),
then `added` (2). Within a kind, rows sort by `D(anchor)` then
`D(counterpart)`, where the **anchor** is the `before` declaration for
`removed`/`signatureChanged` and the `after` declaration for `added`; the
**counterpart** is the `after` declaration for `signatureChanged` and `null`
otherwise. `D(d)` is the tuple:

```
(display_name, signature, identity.kind, identity.scope pairs,
 identity.name, identity.guards, span.byte_start, span.byte_end)
```

## The response envelope

```jsonc
{
  "change_seq": "5",                 // response-only echo; never a cache key
  "projection_version": "interface.v1",
  "language": "typescript",          // null iff no module
  "language_version": "typescript.v1", // null iff no module
  "status": "ready",                 // ready|incomplete|unavailable|unsupported|skipped
  "fallback_reason": "…",            // present iff status != ready
  "coverage": {
    "before": { "state": "complete" },   // complete|absent|incomplete|unavailable|unsupported|notEvaluated
    "after":  { "state": "complete" }    // + "reason" for incomplete/unavailable
  },
  "changes": [
    {
      "kind": "signatureChanged",    // added|removed|signatureChanged
      "identity": { "kind": "function", "scope": [], "name": "f", "guards": [] },
      "before": { "kind": "function", "display_name": "f",
                  "signature": "function f(x: number): number",
                  "span": { "byte_start": 0, "byte_end": 40 } },
      "after":  { "kind": "function", "display_name": "f",
                  "signature": "function f(x: number, y: number): number",
                  "span": { "byte_start": 0, "byte_end": 55 } }
    }
  ]
}
```

`change_seq` mirrors `clip.v3`: a response-only echo of the change sequence
number, **never** part of any cache key.

## Schema location — not served yet

The JSON Schema lives at `contracts/interface/v1/schema.json`. It is **not**
served: `GET /v1/schemas/projections/interface.v1` returns **404** until the
serving PR (T5b.3) adds `interface.v1` to the schema allowlist in
`src/store-reader.ts`. The T5a.1 acceptance check asserts that 404. `language`
in the schema is a plain `string`, never an enum.

## Not in this version

- **No parser, grammar, or tree-sitter** and no TypeScript/Swift extraction or
  signature normalization — those are later PRs. This PR ships only the
  language-neutral core and the synthetic corpus that exercises it.
- **No similarity scoring / fuzzy rename detection.** Correspondence is exact
  identity + exact signature only.
- **No serving of the schema, no HTTP route, no workers, no cache, no
  admission implementation, no persisted index or GC root, no new log events.**
- **No per-language fingerprint / `language_version` gating logic** (known
  follow-up).
- Nothing display-fold related.
