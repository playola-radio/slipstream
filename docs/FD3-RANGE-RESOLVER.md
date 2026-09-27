# FD3 recorded range resolver handoff

`resolveRecordedRange` in `src/interface-range-resolver.ts` resolves recorded file
identities between two cutoffs of one session. It reads only the public JSONL log
through the caller's frozen `afterSeq`; it does not read the live worktree, Git,
or blobs. The caller passes pre-parsed `bigint` cutoffs, the reader's durable
high-water, a log path, session ID, optional exact path prefix and exclusive
cursor, a scan budget, and an optional abort signal. Cutoffs and provenance are
returned as decimal strings without a `Number` conversion.

On success, `files` contains every observed candidate path at or before A in
UTF-16 order, including tag-equal endpoints. `endpointsEqual` means absent on
both sides or content with the same SHA-256. It does **not** prove that a content
blob is still available. FD4 must check retention before hiding an equal path,
then apply `include_identical`, the page limit, file-result budget, statuses,
coverage and cursor advancement. A recorded `unavailable` tag is never equal,
even to the same reason. FD4 maps recorded absent/unavailable and
`unknownBoundary` to side coverage; content coverage depends on later blob and
language work. Inventory is explicitly observed, carries the first baseline
completion through A, its unknown scopes, and the static policy exclusions.
Gaps include those before B. Reconciliation observation and gap reference remain
on either endpoint.

The result's other variants are `beyondDurable` (FD4 maps to 409 with the
reader's durable header), `scanLimit` (FD4 maps to a pre-first-file skipped page
with `scan-limit`), and `aborted` (FD4 maps its own signal cause to timeout or
cancelled). Both scan outcomes return completed record/byte counts and elapsed
time. The resolver throws `LogCorruptError` for a contradictory chain, invalid
relevant record, or a log that ends before A; FD4 should preserve its existing
post-resolution tombstone recheck before mapping the error to 500 or 410.
Malformed request grammar, including B>A, is FD4's 400; no HTTP parser lives
in this module. Admission and deadline values remain subject to D7 measurement
and owner approval.

The resolver uses the existing log cursor with optional per-read record, UTF-8
byte and abort limits. These optional limits leave existing readers unchanged.
The scan's memory is bounded by the caller's byte/record ceilings plus the
cursor's fixed read window; no persisted index is added. Every page rescans the
prefix, so FD4 should record the returned scan timing during D7 measurement.

## Acceptance and corpus boundary

The FD3 test replays all 62 `expected.json` histories through the production
resolver and checks every listed endpoint and provenance against the hand-written
expected output. It also checks the corrupt-chain 500 history and the
durable-ahead 409 history. The two 400 histories (`range-huge-seq`,
`range-invalid-request-400`) are request-parsing cases for FD4. Language rows,
page statuses, admission, blob-loss handling, and zero file-result budget are
owned by FD1/FD2/FD4, not claimed by FD3. The exact corpus-case list and
ownership split are recorded in the FD3 handoff note.

The approved fixture harness has no condition for a scan limit or a deadline
before any file starts. The scoped contract amendment proposed for the owner is
`harness.limits.scan_records: 0` for deterministic pre-first-file scan-limit and
`harness.interrupt: { phase: "resolve", reason: "timeout" | "cancelled" }` for
the corresponding interruption. FD3 unit tests cover these outcomes now;
no golden expectation or validator was altered here. FD4 can add the fixture
only after an owner-approved harness extension.
