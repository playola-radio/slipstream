# Clip projection (`clip.v1`)

The clip projection is a **reader-derived public projection** over the immutable
`before`/`after` blobs of a `file.changed` event. It is **not a log event**: it is
never appended to `events.jsonl`, has no `seq` of its own, and carries no
`policy_seq`. It is a pure function of `(before bytes, after bytes,
projection_version)`, computed on demand and cached disposably — so identical
blobs always yield the identical result, and a dropped cache recomputes the same
answer.

The published JSON schema is `schemas/projections/clip.v1.json`, served at
`GET /v1/schemas/projections/clip.v1`. This document is the prose companion to
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
  "projection_version": "clip.v1", // names the complete algorithm; the cache key
  "status": "fallback",            // ready | fallback | skipped | unavailable
  "fallback_reason": "function-extraction-unavailable", // required unless ready
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
produces one clip per changed range. Within an edit, a hunk that is a pure
insertion has a `null` before span (nothing on the before side), and a pure
deletion has a `null` after span — a `null` span on a `changed-range` side means
that side of the hunk is empty, never that content was unreadable.

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
| `ready` | Function-level clips extracted. **Reserved for a later version** (`clip.v1` never returns `ready`; function extraction is B2). |
| `fallback` | A diffable file rendered as changed byte ranges (or whole-file where a diff wasn't possible). This is the normal `clip.v1` result for any UTF-8 file. |
| `skipped` | No bounded clip could be produced — and none was invented. |
| `unavailable` | A referenced blob's content is gone (GC'd) or was never captured. |

Every status except `ready` carries a `fallback_reason`.

### `fallback_reason` values you may see

- `function-extraction-unavailable` — a normal `fallback`: the file diffed fine,
  but function-level clips aren't available in this version.
- `no-content`, `no-change`, `not-utf8`, `oversize` — `skipped`: nothing bounded to
  show (both sides absent, before == after, binary/non-UTF-8, or over the parse
  budget).
- `clip-too-large` — `skipped`: a diff was possible but no whole-line clip fits
  the per-side byte ceiling (e.g. a minified file whose single line exceeds
  64 KiB). Nothing is emitted past the locked budget rather than an oversized clip.
- `after-missing`, `after-unavailable` (and `before-*` variants) — `unavailable`:
  the side's blob is gone or its snapshot was `unavailable`, with the reason.
- `timeout`, `overloaded`, `worker-error` — `skipped`, transient: the projection
  couldn't be produced within budget / under load / due to a worker fault. These
  are **never cached** — retry and it may succeed.

### Per-side `method`

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
  is terminated and replaced) and the change is `skipped`/`timeout` — the bounded
  fallback is prepared *before* any parse, so an overrun still had a chance to
  produce ranges.
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
- The cache key is `(before side, after side, projection_version)`. `change_seq`
  is **not** part of the key — it is stamped onto the response on the way out, so
  two changes with identical before/after blobs share one cached computation and
  each still reports its own `change_seq`.
- A cache hit is **revalidated**: if a referenced blob has since been GC'd, the
  stale entry is dropped and the request recomputes (yielding `unavailable`). A
  stale result never masquerades as available.
- `timeout`, `overloaded`, and `worker-error` results are **never cached** —
  they're transient, so a retry gets a fresh attempt.

## Version compatibility

`projection_version` names the **complete** extraction algorithm and is the cache
key. Any change to how spans are computed is a new version (e.g. `clip.v2`), served
under its own schema at `/v1/schemas/projections/clip.v2`. A client should treat an
unrecognized `projection_version` as opaque and fetch its schema rather than assume
the `clip.v1` rules. Within a version, unknown fields are permitted for forward
compatibility — ignore fields you don't recognize.

## Retention

Clips are viewable **exactly while the blobs are retained**. Slipstream's blob GC
(P5) is unchanged by this projection; when a change's blobs are collected, its
clips become `unavailable` with a reason. Nothing is faked to paper over a
collected blob.
