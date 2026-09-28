# FD4 reader API handoff

**Status: in progress; keep the PR draft.** The reader serves `interface.v2`, but
the provisional D7 deadline is shorter than cold isolated Swift extraction in
the standalone live check. FD5 must measure and obtain Brian's approval before
the production admission values or the Swift ready gate can be claimed.

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

## Evidence and open gates

`src/interface-http.test.ts` replays every applicable contract history against
the real HTTP route, including both languages, missing blobs, status precedence,
filtering, identical endpoints, pagination, 400/409 headers, the schema route,
and 410. Harness conditions exercise overload, caps, and mid-page interruption
against their golden outputs. A warmed cache followed by blob loss is tested.
The independent `tools/fd4-live-check.ts` starts a disposable daemon with no
UI, captures TypeScript and Swift edits, and makes authenticated HTTP requests.
Its production-budget result on 2026-09-27 was TypeScript `ready` with one
change and Swift `skipped/timeout`; the script reports a failed ready-both gate.

- **FD5:** Measure baseline, clip-only, interface-only, and combined load with
  TS, TSX, Swift, malformed and Unicode inputs, cold and warm paths, worker
  retirement and cancellation churn. Obtain Brian's D7 approval for `C/Q/W/D`
  and timeout rates. Preserve clip's existing deadline while deciding how an
  interface deadline can accommodate Swift. Do not infer approval from FD4's
  test-only longer deadline.
- **FS3:** Once FD4/FD5 admission is settled, consume only the authenticated
  public route, schema, event stream and blob route. Freeze session, B/A,
  filters, and version across `next_after_path`; handle partial/skipped pages,
  explicit unavailable sides, unknown scopes, gaps, 409, 410, and stale replies.
  FS2 owns the fixture-backed Swift screen. This PR changes no Swift client.
- **Contract owner:** A deterministic fixture-harness extension for scan-limit,
  deadline and cancellation before the first file was proposed separately.
  No approved golden fixture was changed for that extension without owner
  disposition. Unit tests cover those paths meanwhile.
- **Swift host crash:** The current v2 schema has no dedicated per-file status.
  An abnormal host exit is an internal text `500`; a reproducible crash on one
  file can block later paths on a page. A per-file recovery status would need a
  separate contract decision.
