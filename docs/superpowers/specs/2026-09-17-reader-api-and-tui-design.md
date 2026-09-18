# Slipstream PR 2b — the `/v1` reader API + disk-reading TUI: design

Date: 2026-09-17
Status: approved to build (Brian, after Codex architecture consult)
Scope: the READER half of Stage 2 ("Prove the durable interface"). The write half
(PR 2a: durable append log, fsync ordering, crash recovery, session lock) is merged.

## What this delivers

The public `/v1` HTTP reader over the on-disk event log + content-addressed blob
store, and a minimal disk-reading TUI client that consumes only public artifacts.
After this PR the event schema + reader API is a published interface: the bundled
UI can be deleted and replaced by any client speaking `/v1` or reading the on-disk
log/blobs directly.

## The hard rule this PR is gated on

The on-disk JSONL log + CAS blobs are the source of truth; the reader is a **thin
view** over them; the TUI is one client among many. No privileged back channel
between daemon and client. If a capability is only reachable through daemon
internals, it is not done.

## Honesty constraints the reader must not launder

- Unavailable content is explicit-with-reason (inside the event snapshot's
  `kind:unavailable` oneOf), never a fake empty blob. A genuine zero-byte blob is
  an honest empty `200`; a missing blob is `404`, never an empty success.
- The reader never creates or mutates a capture event. It is read-only over the log.
- Coverage gaps and attribution status pass through unchanged; the reader never
  presents them as more certain than they are.
- The reader serves only durably-flushed events (see "The durable boundary").

---

## Architecture

### One durable-bounded cursor for replay and follow

A single sequential read over the on-disk `events.jsonl` at one byte cursor serves
**both** replay and follow. Replay streams complete lines up to the durable
boundary; follow blocks for the boundary to advance instead of ending. There is no
separate history query plus a separately-registered live callback — so there is
structurally no gap and no duplicate at the replay→follow seam. This is the "one
cursor at one log position" success criterion made literal.

### The durable boundary (the critical subtlety)

A newline-terminated line on disk is **not** proof it was fsynced. The reader
therefore never treats physical EOF as the boundary. It reads and emits only up to
the authoritative in-process **durable sequence** — `Log.durableSeq()` (which
advances only after a successful fsync) surfaced via a daemon-internal runtime
adapter. Physical bytes beyond that boundary are re-read later, never emitted
early. Any bytes prefetched past the boundary record's end offset are discarded and
re-read after the boundary advances (so speculative tail bytes are never retained
across a truncation/recovery).

Known limitation (out of scope for this PR, tracked separately): on the
storage-outage *recovery* path, `recovery.ts` republishes `recoveredThroughSeq`
without re-syncing the retained prefix (`recovery.ts` only fsyncs when it truncates
a torn tail; `session.ts` then calls `health.setDurableSeq(recoveredThroughSeq)`).
The reader trusts the in-process durable boundary, which is correct on the normal
live-append path; the recovery-path gap is a merged PR 2a write-path concern and is
handled as separate Brian-authorized work. This PR's disk-parity tests run on
quiescent, successfully flushed sessions, so the gap does not affect them.

### Wakeups (never block capture)

To learn "the durable boundary advanced," the reader uses a **coalesced in-process
wakeup fired after durability advances** — not `fs.watch` (which does not establish
durability and has inode/platform caveats), not polling. The wakeup is only a hint;
the data is always re-read from disk at the byte cursor, so the single on-disk byte
position remains the one cursor and the one data source.

Waiting is race-free: register the waiter, re-sample the durable boundary, and only
then sleep if it is unchanged (otherwise read immediately). Notification delivery,
reader parsing, and socket writes never run inside capture's awaited append path.
Capture can never be blocked by a reader.

### Backpressure and lifecycle

When `res.write()` returns false, the connection stops reading, awaits `drain`
with a deadline, then disconnects (the client resumes from its cursor). Heartbeats
obey the same pressure limit. Connection count and per-connection buffered bytes are
bounded. Replay yields between batches so synchronous parsing cannot starve the
event loop (and thus capture). File handles, waiters, timers, and pending drain
waits are cleaned up on response `close`/`error`. On `ELOCKLOST` a follow is
terminated rather than left hanging forever. An error that occurs after streaming
has begun aborts the connection; a JSON error is never injected into the stream
(the HTTP status is already sent).

---

## Modules (each one responsibility, testable in isolation)

| Module | Responsibility |
|---|---|
| `src/store-reader.ts` | Read-only storage layout: `listSessions(storeDir)`, session/blob/schema path builders, tombstone reads. No writing, no recovery. |
| `src/log-reader.ts` | Strict JSONL framing, cursor validation, sequential reads bounded by a supplied durable seq. Never emits an unterminated line. Forward-compatible reader envelope (not the closed `AnyEvent`). |
| `src/reader-runtime.ts` | Daemon-internal: adapts capture's durable boundary + health into boundary snapshots and race-free wakeups. Supplies boundaries/wakeups, never event payloads. Kept internal — clients never touch it. |
| `src/http-security.ts` | Bearer credential check (`timingSafeEqual`), exact `Host`/`Origin` enforcement, connection descriptor. |
| `src/http-reader.ts` | `node:http` server, routing, status mapping, NDJSON/SSE framing, connection lifecycle + backpressure. |
| `src/tui.ts` | The client. Consumes only public artifacts (HTTP `/v1` or on-disk log/blobs). |
| `src/cli.ts` | New subcommands wiring the server and the TUI. |

`src/reader.ts` is unchanged — it is the source-file snapshot reader (a capture-side
helper), an unrelated name that stays distinct from the log/HTTP reader added here.

No HTTP framework, no new runtime dependency. Node built-ins only (`node:http`,
`node:crypto`, `node:fs`). If any of these turns out insufficient, STOP and ask
rather than adding a dependency.

---

## API surface (frozen wire contract)

All routes: `Cache-Control: no-store`. Unsupported method → `405` with
`Allow: GET`. Every data route requires bearer auth (see Auth).

### `GET /v1/sessions`
JSON array of sessions with minimal metadata: `{ id, durable_seq, removed }`.
`durable_seq` is a decimal string. `removed: true` for tombstoned sessions.

### `GET /v1/sessions/{id}/events?after={seq}&follow={bool}`
- `after` missing ⇒ `"0"`. Accept only `0` or `[1-9][0-9]*`, else **400**.
- `follow` truthy ⇒ SSE, else finite NDJSON. In follow mode `Last-Event-ID`
  overrides `after` and is validated the same way (malformed → 400), selected
  before the effective cursor is validated against the durable high-water.
- Unknown session (no dir) → **404**. Tombstoned session → **410** (a valid
  tombstone takes precedence over any remaining log). Effective cursor greater
  than the durable high-water `H` → **409**, headers only, no stream, with
  `Slipstream-Durable-Seq: H`.
- **finite (`follow=false`)**: capture one fixed `H` at request start; return
  exactly `(after, H]`. `Content-Type: application/x-ndjson; charset=utf-8`, one
  LF per record. Response header `Slipstream-Durable-Seq: H`. Appends during the
  response belong to the next request. `after == H` ⇒ empty `200` + header.
- **follow (`follow=true`)**: `Content-Type: text/event-stream; charset=utf-8`.
  Each event frame: `id: <seq>\nevent: slipstream\ndata: <event JSON>\n\n`.
  Heartbeats are SSE comment lines (`: heartbeat\n\n`) and are never persisted
  events. `after == H` ⇒ stream opens and waits. Headers are flushed only after
  validation passes.

### `GET /v1/blobs/sha256/{hex}`
Canonical lowercase 64-char hex, else **400**. On success: exact bytes,
`Content-Type: application/octet-stream`, exact `Content-Length` (a genuine
zero-byte blob → empty `200`). Genuine `ENOENT` → **404**. Other storage failure →
**5xx**. `Range` is ignored; always full `200` (no implied partial support). No
reference-membership check — the endpoint serves blobs by hash.

### `GET /v1/schemas/{type}`
Raw schema file **bytes** (not `loadSchema`'s parsed object) via an allowlisted
`type → file` map. Malformed type string → **400**; well-formed but unknown type →
**404**. Path traversal and symlinks rejected before any path construction.

### Error codes summary
`400` invalid cursor / malformed hex / bad type · `401` missing/invalid bearer ·
`403` bad Origin/Host · `404` unknown session / missing blob / unknown schema ·
`405` bad method · `409` cursor beyond durable high-water (never silently reset) ·
`410` removed session · `5xx` storage failure. A cursor is never silently reset.

---

## Auth + origin policy (Node built-ins only)

- Bind explicitly to `127.0.0.1` (never omit the host).
- Generate a 32-byte token with `node:crypto`. Publish `{ url, token }` atomically
  to `storeDir/runtime/{daemon-uuid}.json` (dir `0700`, file `0600`). Print the
  file path, never the token. A per-daemon UUID name avoids assuming the session
  lock also grants store-wide singleton ownership.
- Every data route requires `Authorization: Bearer <token>`, compared with
  `timingSafeEqual` over fixed-length buffers. Missing/invalid → **401**.
- Require exactly `Host: 127.0.0.1:<bound-port>`. Reject missing, duplicate, or
  foreign authorities. Forwarded-host headers are ignored.
- `Origin` absent is allowed (native clients). If present it must be exactly
  `http://127.0.0.1:<bound-port>`; `null` and everything else → **403**
  (DNS-rebinding defense). No CORS headers, no cross-origin support in this PR;
  origin enforcement rejects, it does not merely omit CORS headers.
- Existing storage paths validated with `assertOwnerOnly`; creation mode does not
  repair insecure pre-existing files.
- **SSE uses `fetch()` streaming, not `EventSource`** — `EventSource` cannot set
  headers, and putting the token in a query string leaks it into URLs/logs. The
  token stays in the `Authorization` header for both NDJSON and SSE.

---

## The tombstone (410 without building Stage 3)

Session deletion / GC is Stage 3 scope and is **not** built here. To make `410`
reachable and testable now, the reader honors a real, documented tombstone:
`sessions/{id}/removed.json` = `{"version":1}` (owner-only). A valid tombstone
takes precedence over any remaining log and yields `410`. A missing log without a
tombstone is **not** evidence of deletion (it is `404`/error, not `410`); a
malformed marker is a storage error. Tests create the real artifact in a temp store
and hit the real HTTP route — no mocked session registry. (Future deletion must
durably publish the tombstone before removing history and preserve it afterward —
noted for Stage 3, not built here.)

---

## The TUI (minimal, replaceable-client proof)

A small terminal feed viewer that consumes only public artifacts:

- Explicit store/session selection.
- A finite `--disk` replay mode that works with **no daemon**, reading the on-disk
  log/blobs directly over finalized/recovered artifacts.
- Live viewing over HTTP/SSE (default), via `fetch()` streaming with the bearer
  token from the runtime descriptor file.
- Renders: sequence · event kind · path · snapshot status (content/absent/
  unavailable+reason) · gap reason. Distinguishes baseline observations from edits.
  Sanitizes control characters in paths/content before printing.

Explicitly not built: full-screen TUI framework, editor, diff engine, search
index, task grouping, persistent client database. A human-readable terminal feed
is the bar; a raw JSON dump alone does not demonstrate a client.

---

## Testing (deterministic tier unless real timing is required)

Real files and real sockets in `npm test` (per TESTING.md: the only mocked boundary
is `Platform`; everything else runs for real over temp dirs). Narrow internal
scheduling seams where a race must be driven deterministically. Permission
enforcement claims stay in the OS tier.

Required tests (from the plan):

1. **Two independent readers converge.** The direct-disk reader used in the test is
   a **separate, minimal re-implementation** (strict JSONL parse + its own simple
   state reducer), NOT a wrapper around `log-reader.ts` — sharing the logic under
   test would prove nothing. Compare ordered event identities, reconstructed
   snapshots, referenced blob bytes, and gap/unavailable info, on a quiescent
   flushed session. Do not use `readRecords` as the oracle (it swallows read
   failures and skips blank lines).
2. **Reconnect from a stale cursor mid-stream: no gap, no duplicate.** A request
   from cursor `K` emits exactly `K+1…`. Reconnecting from a deliberately stale
   cursor necessarily repeats already-received records — that is correct; the test
   asserts both the exact suffix `(K, H]` and idempotent application by
   `(session_id, seq)`. Reconnect is not transport-level exactly-once.
3. **Schema-evolution guard.** An unknown event type between known changes AND as
   the final record, plus unknown nested fields: the cursor still advances and the
   feed stays complete. Uses a forward-compatible reader envelope.
4. **Error-code paths** 400 / 404 / 409 / 410 each covered with real routes.
5. **Auth/origin**: 401 (missing/invalid bearer), 403 (bad Origin/Host).
6. **Backpressure / slow-client disconnect**; connection cleanup on client abort;
   headers-only 409 carries `Slipstream-Durable-Seq`.
7. **Dangerous schedules** (narrow seams): a complete newline visible while the
   durable boundary is unchanged (must NOT be emitted); an append landing between
   catch-up and waiter registration (must wake); cursors above
   `Number.MAX_SAFE_INTEGER` handled via BigInt.

Anything that genuinely needs real FSEvents/timing goes in `*.os.test.ts`;
everything above is deterministic.

---

## Out of scope (do not build)

Conductor attach / session selection (Stage 3), harness attribution/enrichment
(Stage 4), the full three-column workspace UI (Stage 5), session deletion/GC
(Stage 3), the recovery durable-sync fix (separate Brian-authorized PR).

## Success criteria (from IMPLEMENTATION_PLAN Stage 2 — not reworded)

- Reader API: `GET /v1/sessions`, `GET /v1/sessions/{id}/events?after={seq}` with
  `follow=false` (finite NDJSON, durable high-water in a response header) and
  `follow=true` (SSE), `GET /v1/blobs/sha256/{hex}`, `GET /v1/schemas/{type}`.
- Replay-then-follow uses one cursor in one log position — no gap, no duplicate.
- SSE: `id` = session-local sequence, `event` = `slipstream`, `Last-Event-ID`
  overrides `after`, heartbeats are SSE comments (not persisted events); a slow
  client is disconnected and resumes from its cursor; it never blocks capture.
- Error codes: 400 invalid cursor, 404 unknown session, 410 removed session, 409
  cursor beyond durable high-water. Never silently reset a cursor.
- Loopback-only HTTP with authentication and explicit origin policy; owner-only
  storage permissions.
- Tests: two independent readers converge; reconnect from a stale cursor (no gap /
  no duplicate); schema-evolution guard; each error-code path covered.
