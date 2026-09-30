# FD4 reader API handoff

**Status: in progress; keep the PR draft.** Brian approved a 10,000 ms default
interface-page safety budget for completeness on 2026-09-30. The earlier 100 ms
cold Swift timeout remains historical evidence. Clip keeps its 100 ms deadline;
the shared `C/Q/W`, capture impact and timeout rates still require FD5 evidence
and approval.

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

## Evidence and open gates

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
the committed `tools/fd4-live-check.ts` reproduces the check.

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
- **FS3:** Once FD4/FD5 admission is settled, consume only the authenticated
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
  file can block later paths on a page. A per-file recovery status would need a
  separate contract decision.
- **FD5 measurement risk:** A page may inspect many identical paths while seeking
  the next visible row. The admission deadline includes that retention scan, so
  large recorded inventories can return a skipped or partial timeout even when
  most files are unchanged. Measure this case under the provisional budget.
- **Internal failures:** A corrupt retained blob, filesystem I/O failure, or
  TypeScript worker failure also returns text `500`; the schema has no truthful
  per-file status for these failures. A repeated failure can block the same page
  until the underlying store or worker problem is resolved.

## Remaining merge and measurement gates

The original FD5 tracing-overhead failure remains failed under its frozen
configuration. The native/WASM diagnostic timeout remains unresolved. Two
previous tools-suite failures (clip cache-bypass admission count under load and
the Swift cancellation demo) passed in the 2026-09-30 run but remain tracked as
intermittent until diagnosed; one green run does not erase them. The no-row,
unchanged-cursor progress decision also remains open. None is silently waived
by the 10-second interface-completeness policy or the functional live check.
