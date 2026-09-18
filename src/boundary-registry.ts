import { staticBoundary, type BoundarySource } from './reader-runtime.ts';

/**
 * The dynamic reader boundary registry (D3). Under one shared daemon the reader
 * is long-lived while sessions attach and detach beneath it, so a session's
 * durability boundary is not a per-request constant — it changes as the session
 * transitions active → retained. The registry is the authoritative, session-keyed
 * source of that boundary, used by BOTH `/v1/sessions` listing and `/events`.
 *
 * It exists to close a specific honesty trap: the reader lists sessions from
 * disk, so the active session's log dir appears mid-startup, and disk high-water
 * can momentarily exceed the durable boundary during the write→fsync window —
 * publishing an uncommitted record. The daemon therefore {@link reserve}s a
 * session (boundary 0) BEFORE its log exists on disk, then {@link activate}s the
 * live boundary once capture is up. The reader trusts the registry over disk for
 * every session it knows; disk high-water is used only for sessions the daemon
 * has never touched this run (retained from a prior run, immutable now).
 *
 * On a transition the registry aborts the session's SSE followers so they
 * reconnect (via Last-Event-ID) and re-resolve against the new boundary — a
 * follower attached while the session was inactive is never pinned to a stale
 * static boundary after (re)attach. Finite reads are NOT registered as followers:
 * they complete against the high-water they captured, so a transition never turns
 * a valid response into a partial download.
 *
 * Race-freedom rests on one invariant enforced by the daemon: attach ALWAYS
 * mints a NEW session UUID (it never reactivates a retained session — roots
 * recur, identity is the UUID). So any session that can transition to active is
 * registry-known before it is disk-listable; a session found on disk but absent
 * from the registry is retained and can never transition. Follower registration
 * and boundary reads are synchronous, so no await interleaves between reading the
 * current boundary and joining the set that a transition aborts.
 */
export interface SessionRuntime {
  boundary: BoundarySource;
}

export interface BoundaryRegistry {
  /** Install a not-yet-committed session at boundary 0, before its log is on
   * disk. No-op if the session is already known. */
  reserve(id: string): void;
  /** Swap in the live boundary once capture is up; aborts existing followers. */
  activate(id: string, boundary: BoundarySource): void;
  /** Pin the boundary at the final durable seq on detach; aborts followers. */
  freeze(id: string, seq: bigint): void;
  get(id: string): SessionRuntime | undefined;
  /** Create a static entry for a retained session discovered on disk; returns the
   * existing entry unchanged if one is already known (never overwrites live). */
  installIfAbsent(id: string, boundary: BoundarySource): SessionRuntime;
  addFollower(id: string, ac: AbortController): void;
  removeFollower(id: string, ac: AbortController): void;
}

interface Entry {
  boundary: BoundarySource;
  followers: Set<AbortController>;
}

export function createBoundaryRegistry(): BoundaryRegistry {
  const entries = new Map<string, Entry>();

  const ensure = (id: string, boundary: BoundarySource): Entry => {
    let entry = entries.get(id);
    if (!entry) {
      entry = { boundary, followers: new Set() };
      entries.set(id, entry);
    }
    return entry;
  };

  const transition = (id: string, boundary: BoundarySource): void => {
    const entry = ensure(id, boundary);
    entry.boundary = boundary;
    // Disconnect followers pinned to the previous boundary; they reconnect and
    // re-resolve. Clear the set so a later transition never re-aborts a stale ref.
    const stale = [...entry.followers];
    entry.followers.clear();
    for (const ac of stale) ac.abort();
  };

  return {
    reserve(id) {
      ensure(id, staticBoundary(0n));
    },
    activate(id, boundary) {
      transition(id, boundary);
    },
    freeze(id, seq) {
      transition(id, staticBoundary(seq));
    },
    get(id) {
      return entries.get(id);
    },
    installIfAbsent(id, boundary) {
      return ensure(id, boundary);
    },
    addFollower(id, ac) {
      const entry = entries.get(id);
      if (entry) entry.followers.add(ac);
    },
    removeFollower(id, ac) {
      entries.get(id)?.followers.delete(ac);
    },
  };
}
