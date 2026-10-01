# FD4 reader API handoff

**Status: FD4 implementation accepted for merge by Brian on 2026-09-30; PR #44
awaits Brian's merge.** Brian approved a 10,000 ms default interface-page safety
budget for completeness. The earlier 100 ms cold Swift timeout remains historical
evidence. Clip keeps its 100 ms deadline; shared `C/Q/W`, capture impact and
timeout rates still require separate FD5 evidence and approval. This does not
complete the overall function-change feature.

## Public contract trace

- `GET /v1/sessions/:id/interfaces` is authenticated by the existing reader
  bearer and host/origin checks. It accepts canonical decimal `before_seq` and
  `after_seq`, a 1–16 `limit`, exact `path_prefix`, exclusive `after_path`, and
  `include_identical=true`. It rejects unknown and duplicate parameters.
- The reader freezes the session and durable high-water before calling
  `resolveRecordedRange`. Requests beyond it receive text `409` with
  `slipstream-durable-seq`; malformed requests receive text `400`; missing and
  tombstoned sessions receive `404` and `410`. Tombstones are checked again
  after asynchronous work. Corrupt chains and parser-host failures are text
  `500`, not fabricated file rows.
- The resolver supplies recorded endpoint tags, event provenance, gaps, and
  observed-inventory limits. The service reads only CAS blobs. It checks blob
  retention before hiding tag-equal files and before using a cache entry.
  Missing blobs become side-specific unavailable coverage. No event, persisted
  index, live-worktree read, or Git read is added.
- TypeScript and TSX are parsed in a terminable worker thread and compared by
  `compareStructuredExtractions`. Swift is parsed in its existing
  `--liftoff-only` child and compared by `compareV2`. Both yield the contracted
  row order. One page holds one interface admission slot and processes paths
  sequentially; the reader owns one shared admission budget for clip and
  interface work. Shutdown closes admission before terminating workers.
- Pre-resolution skipped pages have `inventory: null`, `gaps: null`, and
  `gaps_complete: false` under Brian's FD4 amendment. This distinguishes
  unevaluated metadata from an observed empty list. The amended schema,
  golden fixture, and validator remain in sync.
- After a completed file, interruption during the remaining-file look-ahead
  keeps `status: "ready"`, `page.complete: false`, and `next_after_path` at the
  last returned file, with no `fallback_reason`. Here `complete: false` means
  the scan did not finish; it does not promise another visible row. Continuing
  from that cursor may return an empty final page. The reader does not advance
  past unchecked files. An interruption during a file comparison has its own
  partial-page outcome and preserves any established per-file failure status.

## FD4 acceptance evidence

`src/interface-http.test.ts` replays every applicable contract history against
the real HTTP route, including both languages, missing blobs, status precedence,
filtering, identical endpoints, pagination, 400/409 headers, the schema route,
and 410. Harness conditions exercise overload, caps, and mid-page interruption
against their golden outputs. Deterministic look-ahead timeout tests cover an
empty final continuation, a remaining visible file, and a hidden file exposed
by later blob loss. A warmed cache followed by blob loss is tested.
The independent `tools/fd4-live-check.ts` starts a disposable daemon with no
UI, captures TypeScript and Swift edits, and makes authenticated HTTP requests.
Its 2026-09-27 result under the old 100 ms default was TypeScript `ready` with
one change and Swift `skipped/timeout`; that failed result is preserved. Under
Brian's new default, the 2026-09-30 standalone authenticated run returned a
`ready` page with the exact `number`→`string` TypeScript parameter change and
eight exact `Int`→`String` cold Swift parameter changes. A separate file-change
event at seq 22 became durable while the analysis HTTP request was still
pending (frozen range ended at seq 21). The disposable daemon and worktree
were cleaned up; this is functional capture-continuity evidence, not a D7 load
or latency result. The local gitignored response summary is
`.context/fd4-completeness-live-clean.json` (SHA-256
`c9a51db27c8a1ffed60937a70441a0ec732d411dcfcbc9ed6e93b80512ab0e45`);
the committed `tools/fd4-live-check.ts` reproduces the check. A closeout run of
that same independent consumer also fetched the authenticated schema (`200`),
observed unauthenticated `401`, requested beyond durable high-water and received
text `409` with `slipstream-durable-seq: 22`, removed a recorded blob from the
harness-owned disposable store and received a `partial` page with explicit
`unavailable / before-blob-missing` coverage, then tombstoned the disposable
session and received text `410`. Its local summary is
`.context/fd4-closeout-live.json` (SHA-256
`a82ae949825f96faaec098f4b547d2631322febc60c272d11cd7acea5e1dcd91`).
This completes FD4's independent public-reader acceptance row in
`FUNCTION-CHANGES.md` §6.1; the test does not measure shared-load safety.

## Accepted MVP behavior and follow-ups

Brian accepted the current pagination and host-error behavior for FD4 merge.
When an interrupted page has no rows and its cursor does not advance, a client
stops automatic pagination and offers explicit retry; the page is not complete.
A Swift host failure remains an honest text HTTP `500`, displayed as analysis
failure with manual retry. A reproducibly failing file can block later files in
the range. Per-file recovery requires a later contract and implementation
decision; no status was fabricated in this PR.

## FD5 and FS3 handoff

- **FD5:** Measure baseline, clip-only, interface-only, and combined load with
  TS, TSX, Swift, malformed and Unicode inputs, cold and warm paths, worker
  retirement and cancellation churn. Obtain Brian's D7 approval for shared
  `C/Q/W`, production timeout rates and any revision of the approved
  interface-completeness budget. Preserve clip's existing 100 ms deadline;
  the 10,000 ms interface default does not itself pass D7. Count a look-ahead
  admission timeout as a timeout
  even when its returned page and files are `ready`; the JSON response alone
  cannot identify it. No FD5 gate is waived by this pagination decision.
  Also measure shared-queue saturation by multiple 10-second interface pages:
  clip's own deadline stays 100 ms, but a full queue can reject its admission.
- **FS3:** After FD4 merges, live wiring may proceed alongside FD5. Consume only the authenticated
  public route, schema, event stream and blob route. Freeze session, B/A,
  filters, and version across `next_after_path`; handle partial/skipped pages,
  explicit unavailable sides, unknown scopes, gaps, 409, 410, and stale replies.
  Keep one outstanding page request per view/range, and do not immediately
  retry a timeout or unchanged cursor. FS2 owns the fixture-backed Swift screen.
  This PR changes no Swift client.
- **Contract owner:** Brian approved the narrow pre-first-file harness extension.
  Three additional goldens cover scan-limit, deadline and cancellation during
  resolution; the validator now checks 71 cases with its negative control.
  A later interruption with no file row can also be `skipped`, retaining the
  inventory and gaps already resolved; these goldens specify only the
  pre-resolution outcome.
- **Swift host crash:** The current v2 schema has no dedicated per-file status.
  An abnormal host exit is an internal text `500`; a reproducible crash on one
  file can block later paths on a page. This accepted MVP limitation needs a
  separate contract decision for per-file recovery.
- **FD5 measurement risk:** A page may inspect many identical paths while seeking
  the next visible row. The admission deadline includes that retention scan, so
  large recorded inventories can return a skipped or partial timeout even when
  most files are unchanged. Measure this case under the provisional budget.
- **Internal failures:** A corrupt retained blob, filesystem I/O failure, or
  TypeScript worker failure also returns text `500`; the schema has no truthful
  per-file status for these failures. A repeated failure can block the same page
  until the underlying store or worker problem is resolved.

## Remaining feature-completion gates

The original FD5 tracing-overhead failure remains failed under its frozen
configuration, so the existing measurement cannot establish D7 acceptance.
`FD5-PROTOCOL.md` now holds the bounded acceptance protocol for the current
10-second policy and queue/clip pressure: the scored arms run untraced, and
three traced witness arms supply trace-only evidence with diagnostic-only
latency. Execution needs Brian's separate approval of the window and packet
decisions; the runner refuses to start without them, and no diagnostic rerun or
campaign is authorized by FD4 closeout. The archived native/WASM diagnostic
timeout remains unresolved, but the deferred Rust spike is not a prerequisite
for the existing Node path.

Two historical intermittent tools tests remain tracked follow-ups, despite
passing in the 2026-09-30 (557/557) and 2026-10-01 (576/576, 584/584) tools runs:

- `tools/fd5-bench.test.ts:317`, “real clip cache bypass is separate from
  admission and blob loss forces a new compute”: a prior full tools run counted
  3 clip admissions where 2 were expected; it also failed once in isolation.
  FD5 must retain shared-admission and cache-bypass coverage.
- `tools/swift-parse.test.ts:72`, “cancel-demo reports
  inProgressAtCancel:false when the parse finished first”: that prior full run
  reported `true` where `false` was expected. FD5 must retain real cancellation
  and actual child-exit coverage.

The prior failures are recorded in
`.context/fd5-collector-profile-tools-after-review.txt`; the passing run is
`.context/fd4-completeness-tools-test.log`. Neither failure is claimed fixed.
The accepted no-row/unchanged-cursor and Swift host-error limitations remain
follow-ups. Overall feature completion and release remain gated on FD5.
