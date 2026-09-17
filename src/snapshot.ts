/**
 * A snapshot is one *observed* state of a path — never a claim about writes.
 * Content carries the bytes (via CAS hash); absent means the path does not
 * exist; unavailable means the path exists but its bytes were not captured,
 * with an explicit reason. An empty file is `content` with size 0, never
 * `absent`.
 *
 * `baseline-unknown` is the one reason that describes a *prior* state rather
 * than a read failure: it marks a `before` whose baseline was never observed
 * (its directory was unreadable during the initial scan), so the tool must not
 * pretend the path was `absent` before the change.
 */
export type UnavailableReason = 'oversize' | 'unreadable' | 'unstable' | 'io-error' | 'baseline-unknown';

export type Snapshot =
  | { kind: 'content'; sha256: string; size: number }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: UnavailableReason };

/**
 * True when two *consecutive* observations carry the same information and the
 * later one should be suppressed. This is deliberately not global content
 * dedup: an A -> B -> A cycle produces two real transitions because each
 * comparison is only against the immediately preceding committed state.
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'content' && b.kind === 'content') return a.sha256 === b.sha256;
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.reason === b.reason;
  return true; // absent === absent
}
