# Clip projection (`clip.v3`)

The clip projection is a **reader-derived public projection** over the immutable
`before`/`after` blobs of a `file.changed` event. It is **not a log event**: it is
never appended to `events.jsonl`, has no `seq` of its own, and carries no
`policy_seq`. Successful extraction is a function of `(before bytes, after bytes, language,
projection_version)`, computed on demand and cached disposably. The same inputs
produce the same spans; transient timeouts and availability failures are never
cached. The language input and cache-key extension were approved by Brian for B2
(2026-09-19).

The current JSON schema is `schemas/projections/clip.v3.json`, served at
`GET /v1/schemas/projections/clip.v3`. The historical `clip.v1` and `clip.v2` schemas remain
available; the clips endpoint computes the current version. This document is the prose companion to
that schema.

## Getting a projection

```
GET /v1/sessions/:id/changes/:seq/clips
```

`:seq` is the `seq` of a `file.changed.v1` event in that session. The reader reads
that event, resolves its `before`/`after` snapshots to raw blob bytes, and returns
the projection as `application/json`.

- **200** with a projection body — the request succeeded. Availability is carried
  *inside* the body (`status`), not by the HTTP status: a change whose blobs were
  garbage-collected still returns 200, with `status: "unavailable"` and a reason.
- **404** — the session is unknown, the `seq` is beyond the session's durable
  high-water, or the record at `seq` is not a `file.changed` event (it has no
  clips).
- **410** — the session was deleted (tombstoned).
- **500** — the log record at `seq` is corrupt (e.g. a `file.changed` event with a
  malformed snapshot). Corruption is never silently rendered as an empty or faked
  projection.

The clips are computed by a reusable, I/O-scoped module
(`computeClipProjection`) that runs directly against on-disk artifacts. The HTTP
reader wraps it; the TUI or any independent client can call it directly. Deleting
the bundled front-end changes nothing about how clips are produced.

## Response shape

```jsonc
{
  "change_seq": "42",              // seq of the file.changed event (response-only)
  "projection_version": "clip.v3", // names the complete algorithm; the cache key
  "status": "fallback",            // ready | fallback | skipped | unavailable
  "fallback_reason": "no-enclosing-function", // required unless ready
  "clips": [
    {
      "before": { "span": { … } | null, "method": "changed-range", "reason": "…"? },
      "after":  { "span": { … } | null, "method": "changed-range", "reason": "…"? }
    }
  ]
}
```

`clips` is an **array** of paired before/after sides. A created file has clips with
a `null` before span; a deleted file has clips with a `null` after span; an edit
produces clips paired by ordered segments within each raw LCS diff block.
Function boundaries are selected before fallback context is merged. Within a fallback edit, a hunk that is a pure
insertion has a `null` before span (nothing on the before side), and a pure
deletion has a `null` after span — a `null` span on a `changed-range` side means
that side of the hunk is empty, never that content was unreadable.

## Language and function selection

The closed input is `javascript`, `jsx`, `typescript`, `tsx`, or `unsupported`.
The reader derives it from the event's path with `languageForPath`: `.js`/`.mjs`/
`.cjs`, `.jsx`, `.ts`/`.mts`/`.cts`, and `.tsx` respectively (case-insensitive).
Everything else is unsupported. A direct-disk caller passes `opts.language`;
omitting it means unsupported. No filename/content-based language guessing occurs.

B2 pins `web-tree-sitter` 0.25.10 and the prebuilt grammar bundle
`tree-sitter-wasms` 0.1.13, loading only JavaScript, TypeScript and TSX grammars.
JavaScript also handles JSX. The WASM binding replaces the native binding whose
worker cancellation could abort the host process; this grammar/runtime change
bumps the algorithm from `clip.v2` to `clip.v3`. Parser indices are UTF-16; the
projection uses row positions and its own raw-byte line index, preserving UTF-8,
BOM and CRLF bytes. Each tree and parser is freed after indexing; grammars are
loaded on demand per worker (JS/JSX share one). Unsupported or wholly missing
content does not initialize WASM. Failed grammar loads are not retained.

Declarations, expressions, generators, arrow functions and methods qualify when
the node has no syntax errors and is not inside an ERROR/missing node. The
smallest reliable enclosing function is selected. Syntax columns are retained
for enclosure checks: a changed boundary line with non-whitespace syntax outside
the function conservatively uses changed-range fallback, rather than borrowing
an unrelated function on the same line. Emitted spans still round to whole lines. An error elsewhere does not
invalidate a usable sibling. Import/top-level changes remain contextual fallback
with a per-side reason; the projection is fallback if any planned segment needs it,
including one later omitted by budget. A wholly unparseable input keeps ranges. If an expanded function cannot fit
but its prepared changed-range clip can, that range is retained with
`function-clip-too-large`. An oversized contextual line never prevents trying a
bounded enclosing function.

Pairing uses raw LCS diff blocks and segment order only: it promises neither
semantic function identity nor move detection. A whole inserted/deleted function
has a null counterpart. A body insertion/deletion may pair the surviving enclosing
function using an interior diff anchor. Repeated edits of one function pair are
deduplicated. Blank separators between created/deleted functions need no standalone
clip; a whitespace-only edit still receives a fallback range.

`computeClipProjection` loads the parser when invoked and supplies it to the
I/O-free `projectClips` core. Pure-core callers wanting extraction pass
the synchronous extractor returned by `await createFunctionIndexer(language)`
as the fourth argument, using the same language as `opts.language`. The daemon computes only through its
existing clip worker; the pool, queue and cancellation protocol are unchanged.

## Byte and line rules

These are part of the contract. A `span` references the **raw blob bytes**, not
decoded text.

- **Byte offsets are zero-based and half-open**: a span covers
  `[byte_start, byte_end)`. `byte_start` is inclusive, `byte_end` is exclusive.
- **Lines split on `\n` (0x0a).** A preceding `\r` stays inside the line's bytes,
  so CRLF content is preserved exactly. A trailing newline terminates the final
  line — there is **no phantom empty last line**.
- **`line_start`/`line_end` are 1-based inclusive.** The span for line range
  `[a, b]` covers `[startOfLine(a), startOfLine(b + 1))`, where
  `startOfLine(lastLine + 1)` is the blob length. Line `b`'s terminator is
  included.
- `\n` is always a UTF-8 boundary, so every span lands on a UTF-8 boundary. The
  core validates UTF-8 before producing spans; non-UTF-8 (including any NUL byte)
  content is treated as binary and never spanned.
- **`truncated`** is `true` when the per-side budget clipped a span short of its
  full changed range, or when the budget prevented a later hunk from being emitted
  at all — in that case the last emitted span on the affected side is marked
  `truncated` so an omission is disclosed, never silent (see Budgets).

To render a clip, fetch the referenced blob (`GET /v1/blobs/sha256/:hex`, the
`sha256` from the event's snapshot) and slice `[byte_start, byte_end)`.

## `null` spans vs. unreadable content

A `null` span means there is **no corresponding span on that side** — created or
deleted content. It **never** means unreadable content. Unreadable or gone content
is reported honestly instead:

- as a non-`ready` top-level `status` (`unavailable` / `skipped`) with a
  `fallback_reason`, or
- as a per-side `method: "unavailable"` with a `reason`.

## `status`

| status | meaning |
| --- | --- |
| `ready` | Every changed segment is function-derived or has no corresponding span. Inspect `truncated` independently: ready does not mean untruncated. |
| `fallback` | At least one segment needs changed-range/whole-file fallback, or parsing failed or timed out. Usable functions in the same change remain extracted. |
| `skipped` | No bounded clip could be produced — and none was invented. |
| `unavailable` | A referenced blob's content is gone (GC'd) or was never captured. |

Every status except `ready` carries a `fallback_reason`.

### `fallback_reason` values you may see

- `unsupported-language` — no parser for the selected language.
- `no-enclosing-function` — a changed segment such as an import is outside a function.
- `parse-error-in-enclosing-scope` — the changed region has unreliable syntax.
- `extraction-budget-exhausted` — deterministic syntax traversal/selection work cap.
- `function-extraction-unavailable` — pure-core caller supplied no extractor; the
  I/O module always supplies the tree-sitter extractor.
- `no-content`, `no-change`, `not-utf8`, `oversize` — `skipped`: nothing bounded to
  show (both sides absent, before == after, binary/non-UTF-8, or over the parse
  budget).
- `truncated-before`, `truncated-after` — a function result omitted content on
  a side that has no emitted span to carry `truncated: true`. The top-level
  fallback reason discloses this without changing any legitimate null counterpart.
- `clip-too-large` — `skipped`: a diff was possible but no whole-line clip fits
  the per-side byte ceiling (e.g. a minified file whose single line exceeds
  64 KiB). Nothing is emitted past the locked budget rather than an oversized clip.
- `after-missing`, `after-unavailable` (and `before-*` variants) — `unavailable`:
  the side's blob is gone or its snapshot was `unavailable`, with the reason.
- `timeout`, `worker-error` — transient. A soft parser abort/fault returns
  prepared `fallback` ranges with per-side reasons. A hard worker deadline/fault
  returns `skipped` when no result reached the service. Both are **never cached**.
- `overloaded` — `skipped`, transient: admission rejected the request. Never cached.

### Per-side `method`

- `function` — reliable enclosing function, rounded outward to whole lines.

- `changed-range` — a real diff hunk (`span` present).
- `whole-file` — the side could not be diffed against the other (create, delete,
  diff-too-large, or the counterpart side unavailable), so the whole side is the
  span.
- `absent` — the path did not exist on this side (`span` is `null`).
- `unavailable` — this side's content is gone or was not captured (`span` is
  `null`, `reason` present).

## Budgets

Fixed ceilings (may only be tightened, never relaxed):

- Parse only UTF-8 content **≤ 1 MiB** per side. Larger → `skipped`/`oversize`.
- **100 ms** wall-clock per change. A parse that overruns is cancelled (its worker
  is terminated and replaced) and the change is `skipped`/`timeout`. Bounded
  fallback is prepared *before* parsing; each WASM parse has a stricter 20 ms
  cooperative progress-callback budget so a soft timeout can return those ranges. The hard
  deadline includes blob reads, computation and worker communication.
- Deterministic extraction caps: 20,000 visited syntax nodes per side and
  400,000 function/error-range selection checks per change. Exhaustion keeps
  the prepared fallback. These are stricter work limits, not raised ceilings.
- Clips are capped at **300 lines and 64 KiB per side, across the whole array**.
  Hitting the cap sets `truncated: true` on the affected span(s) — including the
  last emitted span when the cap drops later hunks entirely, so the omission is
  always visible. A single line wider than the 64 KiB clip ceiling yields no clip
  (`skipped`/`clip-too-large`) rather than one that exceeds the budget.
- The fallback is changed ranges **± 20 lines** of context. If even the bounded
  ranges can't be produced, the result is `skipped` with a reason — invented
  ranges are never returned.

## Cold-cache protection

Clip parsing runs in **isolated worker threads**, never on the capture path. The
reader bounds how many parses it admits at once (a small worker pool behind a
bounded queue). A burst of uncached requests that exceeds admission is returned
immediately as `skipped`/`overloaded` — an explicit, stated deferral, never a
silent stall — so cold-cache demand cannot starve capture. Capture is always
prioritized.

## Caching and retry behavior

- The cache is **disposable** (in-memory, bounded by entry count and bytes). There
  is no on-disk projection store and nothing to resume from a log.
- The cache key is `(before side, after side, projection_version, language)`. `change_seq`
  is **not** part of the key — it is stamped onto the response on the way out, so
  two changes with identical before/after blobs and language share one computation and
  each still reports its own `change_seq`.
- A cache hit is **revalidated**: if a referenced blob has since been GC'd, the
  stale entry is dropped and the request recomputes (yielding `unavailable`). A
  stale result never masquerades as available.
- `timeout`, `overloaded`, and `worker-error` results are **never cached** —
  they're transient, so a retry gets a fresh attempt.

## Version compatibility

`projection_version` names the **complete** extraction algorithm and is the cache
key. Any change to how spans are computed is a new version (e.g. `clip.v3`), served
under its own schema at `/v1/schemas/projections/clip.v3`. A client should treat an
unrecognized `projection_version` as opaque and fetch its schema rather than assume
the `clip.v1` rules. Within a version, unknown fields are permitted for forward
compatibility — ignore fields you don't recognize.

## Retention

Clips are viewable **exactly while the blobs are retained**. Slipstream's blob GC
(P5) is unchanged by this projection; when a change's blobs are collected, its
clips become `unavailable` with a reason. Nothing is faked to paper over a
collected blob.
