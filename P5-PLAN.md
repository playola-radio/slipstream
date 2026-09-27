# P5 — session deletion + detached-only GC (locked design)

Date: 2026-09-18
Status: design locked via Codex consult (session `01a0b712-8ee6-7380-aef3-6af2ce671cd6`).
**D-BLOB resolved: Brian chose Option B (2026-09-18) — `gc` reclaims unreferenced
global blobs via a conservative detached mark-and-sweep.**

Stage 3, final PR. Adds the WRITER side of the tombstone contract whose READER
side shipped in PR #6 (`store-reader.ts` `readTombstone`/`Tombstone`,
`http-reader.ts` 410). Reuses the existing tombstone format + reader behavior;
does not duplicate them.

## Scope (locked, do not expand)
Two new CONTROL verbs on the shared daemon, both **detached-only**:
- `delete_session <id>` — durably tombstone a retained session, then remove its
  own log history. Never touches the active session. Never touches global blobs.
- `gc` — complete cleanup of already-validly-tombstoned sessions using the same
  durable-tombstone-first ordering. Selects NO new sessions for deletion.

CLI: `slipstream delete <session-id> [--store <dir>]`, `slipstream gc [--store <dir>]`.

## D-BLOB — RESOLVED: Option B (gc mark-and-sweeps unreferenced global blobs)
Blobs are a GLOBAL content-addressed store shared across all sessions. A blob may
be referenced by other retained sessions. "Remove history (log + blobs)" is safe
for the log (session-local) but NOT for blobs.

Codex's finding: reclaiming shared blobs requires a store-wide mark-and-sweep,
which *also* deletes crash-orphan blobs unrelated to any tombstoned session —
that is broader than "completing interrupted session deletion," and it is a
scope/retention decision the plan does not settle. Per CLAUDE.md ("GC retention
policy ... report and STOP; do not remedy") this is Brian's call.

- **Option A (default, in-scope literal of "cleanup of tombstoned sessions"):**
  P5 does NOT reclaim global blobs. Deleting a session removes its log; its blobs
  are retained (leaked) and deferred to a future blob-GC pass. Simple, safe, zero
  risk to other sessions.
- **Option B:** `gc` additionally runs a conservative detached mark-and-sweep:
  build the live-set of every blob hash referenced by every NON-removed session's
  log (baseline snapshots + both sides of changes), delete any CAS blob not in the
  set. Reclaims space but also removes crash orphans; more code, more test surface,
  more destructive.

Everything below is INDEPENDENT of D-BLOB and is fully locked.

## Locked design (Q2–Q6)

### delete_session ordering (durable-tombstone-first)
1. Validate: `req.session_id` is a well-formed UUID (existing `isValidSessionId`);
   else `PROTOCOL`.
2. Admission: daemon must be fully `detached` (see "detached-only" below); else
   `SESSION_ACTIVE` (capture in progress) / `CAPTURE_NOT_READY` (maintenance busy)
   / `STORAGE_UNAVAILABLE` (wedged / lock lost).
3. The session dir must exist (`sessions/<id>/`); a well-formed but absent id →
   `SESSION_NOT_FOUND` (new code). Do NOT manufacture a tombstone for an unknown
   id — that would turn a typo into a permanent fictional session entry.
4. Durably publish `removed.json = {"version":1}` via the shared marker helper:
   same-dir unique temp, `wx`/0600, `writeAll`, file `sync()`, `rename`,
   `fsyncDir(session dir)`. Idempotent: republish even if a marker already exists,
   because an existing marker does NOT prove the earlier dir-fsync succeeded.
5. Invalidate affected reader followers (registry `freeze(id, 0n)` after the
   tombstone is durable).
6. Remove history: unlink an EXPLICIT inventory of history files
   (`events.jsonl`), never a blind recursive dir removal; preserve `removed.json`
   and the session dir so `listSessions` still shows `{removed:true}` and
   `/events` still 410s.
7. `fsyncDir(session dir)` again before acknowledging success.
- Crash between 4 and 6 leaves residual history under a durable tombstone; the
  reader already 410s; `gc` finishes step 6 later.
- A cleanup failure after the tombstone is durable → `STORAGE_UNAVAILABLE` whose
  message says removal is logically committed and cleanup is retryable. NEVER roll
  back the tombstone.

### gc
For every session dir with a valid tombstone: re-establish tombstone durability
(republish via the same helper), then run the same history-removal (steps 6–7).
Idempotent and safe to repeat. (Blob sweep only if D-BLOB=B.)

### "Detached-only" (Q3) — both verbs require `state === 'detached'`
Refuse `attaching` / `active` / `detaching` / `wedged`. Checking only
`current?.id` is insufficient because `current` is not installed during attach
startup — a half-started capture would slip through. Requiring full detachment is
the simple, safe admission rule and matches the multi-session guardrail memo
("GC: refuse while any capture is attaching/active/detaching"; see
`IMPLEMENTATION_PLAN.md`, "Future: several simultaneous captures").

### Concurrency: one maintenance slot (Q4)
A single tracked `maintenanceInFlight?: Promise<unknown>`:
- delete/gc verify `state==='detached'` AND slot free, then CLAIM the slot
  synchronously BEFORE their first await.
- `attach` checks the slot before setting `attaching` (refuse if maintenance runs).
- concurrent delete/gc while the slot is held → `CAPTURE_NOT_READY` (do not queue).
- release in `finally`.
- `doTeardown` closes admission (`torn`) then awaits the slot before releasing the
  store lock.
- a store-lock loss (`compromised`) stops further destructive work.

### Error codes (Q5)
Add ONE code: `SESSION_NOT_FOUND` (valid UUID, no such session dir). Reuse
`SESSION_ACTIVE` (a capture is attaching/active/detaching), `CAPTURE_NOT_READY`
(maintenance busy), `STORAGE_UNAVAILABLE` (wedged/lock-lost/fs failure),
`PROTOCOL` (bad UUID/request). CLI validates the id client-side too, preserves
`OutcomeUnknownError` + exit 3. Success = durable logical removal + completed
local cleanup; it must NOT imply reclaimed blob space.

### Reader/registry fixes (Q6)
- `listSessions`: short-circuit removed sessions to `durableSeq: 0n` — do NOT read
  high-water for a tombstoned session (a corrupt residual log must not break
  listing). HTTP listing must also bypass a stale registry boundary for removed.
- Followers: after durable tombstoning, `freeze(id, 0n)` aborts followers; they
  reconnect and get 410. Ensure retained-session followers actually register a
  registry entry (finite/SSE) so the abort reaches them.
- `handleEvents`: register the follower BEFORE a final tombstone re-check, then
  check abort/tombstone before sending headers. Covers deletion racing both before
  and after registration. An already-started 200 may finish; you cannot turn it
  into a 410 mid-stream — the client reconnects and gets 410.
- Blob reads: an already-open fd survives unlink (POSIX); subsequent opens 404.
  Acceptable, honest (404 = unavailable).

## Tests (TDD)
Durability-failure boundaries (fail file-fsync / rename / dir-fsync → tombstone
not falsely acknowledged); retry after partial cleanup; attach-vs-maintenance and
shutdown-vs-maintenance races; unknown id → SESSION_NOT_FOUND; delete of the
active session refused; corrupt residual log under a tombstone still lists + 410s;
follower-registration race → 410 on reconnect; gc completes an interrupted delete.
(If D-BLOB=B: cross-session blob sharing survives gc; an incomplete mark phase
deletes nothing.)

## Gates
`npm run typecheck && npm test && npm run test:os` clean. TOUCHED-AREA REGRESSION:
edits to daemon / readers / control-protocol run the FULL daemon/session/control/
reader suites. PR targets `develop`, title `feature:` + jargon-free.

## Deferred follow-ups (adversarial-review findings, consciously out of P5 scope)
Ruled defer + document by Brian (D1=A, D2=A, D3=A) on 2026-09-19. None is a
regression P5 introduces on the supported single-daemon (D3) topology.

- **C2 — cross-process ownership (P1, data-loss corner, defer + document):**
  standalone `watch`/`serve` capture takes `sessions/<uuid>/owner.lock` while the
  shared daemon takes `<store>/owner.lock` — different files — and `watch` only
  refuses to start when a daemon *control socket* already exists. So a daemon that
  starts *after* a standalone `watch` could run `gc`/`delete_session` concurrently
  with that writer and reclaim a blob it is about to reference. Mixing standalone
  capture and a shared daemon on one store is already outside the supported D3
  topology; a real fix is a unified cross-process store-ownership protocol, which
  is a product/architecture decision, not a P5 change. Documented, not remedied.
- **C6 — symlinked session dir / CAS shard (P2, defer):** a symlink planted where
  a `sessions/<uuid>` dir or a blob shard should be could let destructive ops
  escape the store. Planting it needs write access to the 0700 user-owned store,
  which already grants direct deletion. `storage.ts` (lstat) and the reader
  (`O_NOFOLLOW`) set the convention to extend here later; low real-world risk.
- **C7 — shard-dir re-fsync on gc retry (P3, defer):** after a failed shard-dir
  fsync, a later `gc` that finds the shard already empty skips the fsync, so a
  power loss in that window could resurrect a deleted blob entry. Requires a
  failed fsync *and* a crash in a tiny window; narrow durability corner.

## Standing decision — pre-release schema freedom (Brian, 2026-09-19)
Slipstream has no external consumers yet. Until the first actual release — and
beyond that for as long as Slipstream is the *only* client of its own event log —
the event schema and its type graph may be changed freely (including
non-additively) when doing so improves the overall design, rather than being
treated as a frozen public interface that requires version-bump compatibility.
The honesty constraints still hold in full; this relaxes only the
backward-compatibility/versioning burden, not the truthfulness of what is
recorded. It refines (does not revoke) the "changing this after Stage 3 is a
breaking event-type version bump" note — that framing assumed external consumers.
Consequence for P5's GC: correctness may lean on evolving the schema and the
collector in lockstep rather than defending against arbitrary independent writers.
