# FD3 recorded range resolver handoff

`resolveRecordedRange` in `src/interface-range-resolver.ts` resolves recorded file
identities between two cutoffs of one session. It reads only the public JSONL log
through the caller's frozen `afterSeq`; it does not read the live worktree, Git,
or blobs. The caller passes pre-parsed `bigint` cutoffs, the reader's durable
high-water, a log path, session ID, optional exact path prefix and exclusive
cursor, a scan budget, and an optional abort signal. Sequence comparisons use
`bigint`; `record_seq`, gap `seq` and `baselineCompletedSeq` are returned as
decimal strings. FD4 echoes the request's range in the public envelope.

On success, `files` contains every observed candidate path at or before A in
UTF-16 order, including tag-equal endpoints. `endpointsEqual` means absent on
both sides or content with the same SHA-256. It does **not** prove that a content
blob is still available. FD4 must check retention before hiding an equal path,
then apply `include_identical`, the page limit, file-result budget, statuses,
coverage and cursor advancement. A recorded `unavailable` tag is never equal,
even to the same reason. FD4 maps recorded absent/unavailable and
`unknownBoundary` to side coverage; content coverage depends on later blob and
language work. Inventory is explicitly observed, carries the first baseline
completion through A, its unknown scopes, and the policy exclusions (with
`git-ignored` once a git capture scope is recorded through A). Gaps include
those before B, and each git-scope outage as a `capture-scope-unavailable`
session gap. Reconciliation observation and gap reference remain
on either endpoint. A first-change predecessor has `record_seq > B`; that is
later-record provenance, not proof of an atomic state at B. FD4 must keep that
provenance and the gap list visible. The public event stream carries change-level
`coalesced` and observation intervals; they are outside the v2 endpoint schema.

The result's other variants are `beyondDurable` (FD4 maps to 409 with the
reader's durable header), `scanLimit` (FD4 maps to a pre-first-file skipped page
with `scan-limit`), and `aborted` (FD4 maps its own signal cause to timeout or
cancelled). Both scan outcomes return the number and UTF-8 bytes of complete
records consumed, plus elapsed time; a failed in-progress read may have used
more I/O than these counts. The resolver throws `LogCorruptError` for a contradictory chain, invalid
relevant record, or a log that ends before A; FD4 should preserve its existing
post-resolution tombstone recheck before mapping the error to 500 or 410.
Malformed request grammar, including B>A, is FD4's 400; no HTTP parser lives
in this module. Admission and deadline values remain subject to D7 measurement
and owner approval.

The resolver uses the existing log cursor with optional per-read record, UTF-8
byte and abort limits. These optional limits leave existing readers unchanged.
The scan limits bound the raw prefix read. Parsed objects and the per-path map
add memory overhead beyond the raw-byte ceiling. No persisted index is added.
Every page rescans the prefix. A prefix past the configured byte or record
ceiling returns `scanLimit` on every later page until the budget or design
changes; FD4 must report that outcome honestly.

## Acceptance and corpus boundary

The FD3 test replays all 62 `expected.json` histories through the production
resolver and checks every listed endpoint and provenance against the hand-written
expected output. It also checks the corrupt-chain 500 history and the
durable-ahead 409 history. The two 400 histories (`range-huge-seq`,
`range-invalid-request-400`) are request-parsing cases for FD4. Language rows,
page statuses, admission, blob-loss handling, and zero file-result budget are
owned by FD1/FD2/FD4, not claimed by FD3. The exact 62 successful-case names,
selected from actual corpus membership, are:

- `py-missing-blob-unsupported`, `py-unsupported-language`.
- `range-add-then-remove-py`, `range-add-then-remove-ts`, `range-admission-skipped`, `range-all-failed-page`, `range-cancelled-mid-page`, `range-deadline-mid-page`, `range-gap-before-b`, `range-gap-cap`, `range-gap-unchanged-hashes`, `range-git-scope`, `range-git-scope-unavailable`, `range-page-boundary-first`, `range-page-boundary-second`, `range-rename`, `range-restart-reconciliation`, `range-reverted-hidden`, `range-reverted-listed`, `range-too-large-first-file`, `range-unknown-scopes`.
- `swift-added-file`, `swift-added-function`, `swift-capture-unavailable`, `swift-extension-member`, `swift-generics-where`, `swift-guard-move`, `swift-inferred-return`, `swift-init-failable`, `swift-known-path-incomplete-baseline`, `swift-labels-defaults-effects`, `swift-missing-blob`, `swift-overload-ambiguity`, `swift-parameter-change`, `swift-parameter-reorder`, `swift-parse-failure`, `swift-preview`, `swift-removed-file`, `swift-removed-function`, `swift-return-change`, `swift-shared-type-only`, `swift-unchanged-signature`, `swift-unknown-boundary`, `swift-variadic`.
- `ts-added-file`, `ts-added-function`, `ts-capture-unavailable`, `ts-constructor-change`, `ts-destructured-param`, `ts-inferred-return`, `ts-known-path-incomplete-baseline`, `ts-missing-blob`, `ts-optional-rest-default`, `ts-overload-ambiguity`, `ts-parameter-change`, `ts-parameter-reorder`, `ts-parse-failure`, `ts-removed-file`, `ts-removed-function`, `ts-return-change`, `ts-shared-type-only`, `ts-unchanged-signature`, `ts-unicode-span`, `ts-unknown-boundary`.

`node tools/fd3-live-check.ts` starts a disposable daemon, captures an addition
and an edit, then compares FD3's endpoints and CAS bytes with an independent
consumer of the public events and blob routes. On Node v24.11.0 it passed with
the first change at seq `4`, the edit at seq `5`, and endpoint SHA-256 values
`44f834e7743cecbb5cec4e4969477294bd771635409a5dca8291f6dff8296f9f`
and `bf3b412a6c07a0c56b382dbd1b7da605fb1ea34c7962e2e15abbc1114ed405e6`.
The script does not print the reader token and stops its own daemon.

FD3 measured cold-prefix resolution on Node v24.11.0/macOS using disposable
synthetic session logs with distinct absent-file baseline records. Each size was
run three times under the provisional 100,000-record/16 MiB scan ceiling:

| Paths | Log bytes | Median elapsed | Outcome |
| ---: | ---: | ---: | --- |
| 1,000 | 339,460 | 5.2 ms | resolved |
| 10,000 | 3,408,466 | 34.3 ms | resolved |
| 40,000 | 13,698,466 | 107.8 ms | resolved |
| 50,000 | 17,128,466 | 122.8 ms | scan-limit after 48,977 records |

The 40,000-path result exceeds the provisional 100 ms shared deadline *before*
language work. The 50,000-path prefix cannot resolve at the provisional byte
ceiling. These numbers are a D7 owner decision input, not approved admission
values or a reason to relax the clip deadline. The measurement command and full
raw samples are retained in the workspace's `.context/` evidence.

The approved pre-first-file harness cases are documented in
`docs/FD4-READER-API.md` and `FUNCTION-CHANGES.md` §5.3.
