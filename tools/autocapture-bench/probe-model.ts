/** Pure path classification for the bench probes. Imports nothing from the
 * product, so the probes can load it before any product module. */
export type PathClass = 'worktree' | 'store' | 'lock' | 'transcript' | 'other';

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Lock files are split out from the rest of the store so heartbeat I/O is
 * visible on its own. */
export function classifyPath(path: string, roots: { worktrees: string; store: string; transcripts: string }): PathClass {
  if (path.endsWith('/owner.lock') || path.includes('/owner.lock.')) return 'lock';
  if (under(path, roots.worktrees)) return 'worktree';
  if (under(path, roots.store)) return 'store';
  if (under(path, roots.transcripts)) return 'transcript';
  return 'other';
}

const METADATA_OPS = new Set(['realpath', 'access', 'exists']);

/** Path resolution and existence probes touch no directory listing and no file
 * content, so they are reported apart from enumeration and reads. */
export function isMetadataOp(op: string): boolean {
  return METADATA_OPS.has(op.replace(/^fh\./, '').replace(/Sync$/, ''));
}
