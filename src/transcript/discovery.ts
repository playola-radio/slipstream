/**
 * Transcript discovery: find every transcript that may hold evidence for one
 * captured worktree, honestly.
 *
 * Two harness layouts:
 * - Claude Code stores `<home>/projects/<slug>/<sessionId>.jsonl`, where the slug
 *   is the worktree path with '/'→'-'. The slug directory IS the worktree binding,
 *   so membership is the cwd filter; each file name is the harness session id.
 * - Codex stores date-partitioned rollouts NOT organized by worktree, so we scan
 *   and filter by the canonicalized `session_meta.cwd` being inside the root. mtime
 *   is never an eligibility boundary (an old session can resume). A bounded scan
 *   discloses `discovery-limited` rather than pretend the search was exhaustive.
 *
 * "Different harness sessions in the same worktree" are all legitimate candidates
 * (Stage 3: two agents in one worktree are both captured); each keeps its own
 * native session id, so their invocation identities never collide.
 */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CoverageIssue, HarnessName } from '../event.ts';
import type { AdapterContext } from './types.ts';

export const CLAUDE_ADAPTER_VERSION = 'claude-code/1';
export const CODEX_ADAPTER_VERSION = 'codex/1';

export interface TranscriptBinding {
  path: string;
  ctx: AdapterContext;
}

export interface DiscoveryResult {
  bindings: TranscriptBinding[];
  issues: CoverageIssue[];
}

export type ListResult =
  | { ok: true; paths: string[] }
  | { ok: false; reason: 'missing' | 'inaccessible' };

/** A recursive scan result. `truncated`: the file cap was hit; `incomplete`: a
 * subdirectory could not be read, so the scan may have missed transcripts. */
export type TreeResult =
  | { paths: string[]; truncated: boolean; incomplete: boolean }
  | { ok: false; reason: 'missing' | 'inaccessible' };

/** The first line of a transcript, or why it could not be produced (so discovery
 * can disclose an unreadable/empty candidate instead of silently skipping it). */
export type FirstLineResult =
  | { ok: true; line: string }
  | { ok: false; reason: 'inaccessible' | 'empty' };

export interface DiscoveryIO {
  /** Absolute paths of `*.jsonl` files directly in `dir` (Claude). */
  listDir(dir: string): Promise<ListResult>;
  /** Absolute paths of every `*.jsonl` under `dir` recursively (Codex), capped
   * at `limit`. */
  listTreeJsonl(dir: string, limit: number): Promise<TreeResult>;
  /** The first line of a file, for reading a Codex `session_meta`. */
  readFirstLine(path: string): Promise<FirstLineResult>;
  /** Canonicalize a path, or undefined if it does not resolve. */
  realpath(path: string): Promise<string | undefined>;
  /** Inspect a single path component WITHOUT resolving it, so a dangling symlink,
   * a plain missing entry, and an un-inspectable one (permissions) stay distinct. */
  probe(path: string): Promise<MissingProbe>;
}

/** The result of inspecting one path with {@link DiscoveryIO.probe}. `target` for
 * a symlink is its RAW literal target (unresolved, possibly relative, possibly
 * dangling); callers must resolve it against the real filesystem, never lexically. */
export type MissingProbe =
  | { kind: 'absent' } // confirmed not present (ENOENT)
  | { kind: 'symlink'; target: string } // a symlink, possibly dangling
  | { kind: 'present' } // exists but is not a symlink
  | { kind: 'error' }; // could not be inspected (e.g. permissions)

/** Claude's on-disk slug for a worktree: the absolute path with '/'→'-'. */
export function claudeSlug(root: string): string {
  return root.replace(/\//g, '-');
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** True when `child` is `root` itself or nested inside it (same canonical space). */
export function isWithinRoot(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && rel[0] !== '/';
}

/** A generous bound on symlink hops while degrading a broken cwd, defeating a
 * symlink cycle. Beyond it, a cwd is too pathological to place cheaply, so we
 * disclose it rather than silently drop what might be an in-root candidate. */
const MAX_UNRESOLVED_HOPS = 64;

/** Path segments, dropping empty and `.` parts. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * True when an UNRESOLVABLE cwd could still sit inside the capture root, so it is
 * an in-root candidate we failed to read rather than a genuine non-candidate.
 *
 * A textual check is unreliable both ways: the raw string may be in the root's
 * alias namespace (cwd `/tmp/proj/gone` for canonical root `/private/tmp/proj`)
 * yet be in-root, or textually in-root yet escape through an internal symlink
 * (`/work/proj/link/gone` where `link` -> `/other/project`). So we resolve the
 * cwd the way `realpath` would — but `realpath` on the whole string fails because
 * of the deleted tail. Instead we walk it component by component and let the
 * KERNEL canonicalize every component that still exists: `realpath` on a living
 * component resolves symlinks, case-insensitive names, and unicode normalization
 * exactly, rather than reimplementing those rules. We keep a canonical prefix
 * `base`: for each component, `realpath(base/seg)` supplies its true form; only
 * when that component does NOT resolve do we fall back to `probe`. A truly
 * nonexistent component contains no symlinks below it, so a `..` after it is
 * resolved lexically (exact); a `..` can also pop back above a gap into living
 * space, which the continued walk re-canonicalizes. A component that exists only
 * as a broken symlink is followed by splicing its literal target, so any `..`
 * after it is evaluated against the target, not the link's own parent.
 *
 * A cwd that places outside the root is a different worktree's session, skipped
 * silently so unrelated dead sessions never degrade this root's coverage.
 * Undecidable cases (an uninspectable component, a symlink cycle past the hop
 * cap) fail toward disclosure: never claim non-membership we did not establish.
 */
async function unresolvedCwdMayBeInRoot(
  io: DiscoveryIO,
  root: string,
  cwd: string,
): Promise<boolean> {
  const queue = segmentsOf(cwd);
  let cursor = 0;
  let base = '/';
  let symlinkHops = 0;
  while (cursor < queue.length) {
    const seg = queue[cursor];
    cursor += 1;
    if (seg === '..') {
      base = dirname(base); // popping a canonical prefix is exact
      continue;
    }
    const candidate = base === '/' ? `/${seg}` : `${base}/${seg}`;
    // Let the kernel canonicalize any component that still resolves (dir, file, or
    // a symlink whose target resolves): this handles symlinks, case-insensitive
    // names, and unicode normalization exactly instead of reimplementing them.
    const canonical = await io.realpath(candidate);
    if (canonical !== undefined) {
      base = canonical;
      continue;
    }
    // The component does not fully resolve; distinguish the reasons.
    const probe = await io.probe(candidate);
    if (probe.kind === 'absent') {
      // Confirmed nonexistent (ENOENT/ENOTDIR): no symlinks live below it, so
      // advancing the prefix lexically is exact. A later `..` may still pop back
      // above this gap into living space, which the continued walk re-resolves.
      base = candidate;
      continue;
    }
    if (probe.kind === 'symlink') {
      // A symlink whose target does not resolve (dangling, or reaching through
      // deleted space). Follow its literal target so a `..` after it is evaluated
      // against the target and the target's living parts get canonicalized above.
      symlinkHops += 1;
      if (symlinkHops > MAX_UNRESOLVED_HOPS) return true; // cycle: disclose
      if (isAbsolute(probe.target)) base = '/';
      queue.splice(cursor, 0, ...segmentsOf(probe.target));
      continue;
    }
    return true; // uninspectable (e.g. permissions): cannot rule out membership
  }
  return isWithinRoot(root, base);
}

export async function discoverClaude(
  io: DiscoveryIO,
  home: string,
  root: string,
): Promise<DiscoveryResult> {
  const dir = `${home}/projects/${claudeSlug(root)}`;
  const listed = await io.listDir(dir);
  if (!listed.ok) {
    return { bindings: [], issues: [{ kind: listed.reason, detail: `claude project dir ${dir}` }] };
  }
  const bindings: TranscriptBinding[] = [];
  for (const path of listed.paths) {
    const sessionId = baseName(path).slice(0, -'.jsonl'.length);
    bindings.push({
      path,
      ctx: {
        harness: 'claude-code',
        harnessSessionId: sessionId,
        root,
        cwd: root,
        adapterVersion: CLAUDE_ADAPTER_VERSION,
      },
    });
  }
  return { bindings, issues: [] };
}

function parseSessionMeta(line: string): { id: string; cwd: string } | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'session_meta') return undefined;
    const payload = obj.payload;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const p = payload as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.cwd !== 'string') return undefined;
    return { id: p.id, cwd: p.cwd };
  } catch {
    return undefined;
  }
}

export async function discoverCodex(
  io: DiscoveryIO,
  home: string,
  root: string,
  limit: number,
): Promise<DiscoveryResult> {
  const dir = `${home}/sessions`;
  const listed = await io.listTreeJsonl(dir, limit);
  if ('ok' in listed && listed.ok === false) {
    return { bindings: [], issues: [{ kind: listed.reason, detail: `codex sessions dir ${dir}` }] };
  }
  const { paths, truncated, incomplete } = listed as {
    paths: string[];
    truncated: boolean;
    incomplete: boolean;
  };
  const issues: CoverageIssue[] = [];
  if (truncated) {
    issues.push({
      kind: 'discovery-limited',
      detail: `codex session scan hit the ${limit}-file cap; some transcripts may be unread`,
    });
  }
  if (incomplete) {
    issues.push({
      kind: 'inaccessible',
      detail: `some codex session subdirectories under ${dir} were unreadable`,
    });
  }
  const bindings: TranscriptBinding[] = [];
  for (const path of paths) {
    // A file we cannot read or parse is a candidate we cannot rule out, so it is
    // disclosed as an issue — never silently skipped (which would let a readable
    // sibling conceal it and report coverage as clean).
    const head = await io.readFirstLine(path);
    if (!head.ok) {
      issues.push({ kind: head.reason === 'empty' ? 'malformed' : 'inaccessible', detail: `codex rollout ${path}` });
      continue;
    }
    const meta = parseSessionMeta(head.line);
    if (!meta) {
      issues.push({ kind: 'malformed', detail: `codex rollout ${path} has no session_meta` });
      continue;
    }
    const canonicalCwd = await io.realpath(meta.cwd);
    if (canonicalCwd === undefined) {
      // Can't canonicalize the cwd. If it could still sit inside this root (directly
      // or through the root's alias namespace), it is an in-root candidate we failed
      // to read — disclose the gap rather than let a readable sibling report clean
      // coverage. A cwd whose nearest living ancestor is outside the root is a
      // different worktree's session: a genuine non-candidate, skipped silently.
      if (await unresolvedCwdMayBeInRoot(io, root, meta.cwd)) {
        issues.push({ kind: 'inaccessible', detail: `codex rollout ${path} cwd ${meta.cwd} could not be resolved` });
      }
      continue;
    }
    if (!isWithinRoot(root, canonicalCwd)) continue;
    // If the recorded cwd is a non-canonical alias reached through a symlinked
    // ANCESTOR, its root form relativizes a record's absolute paths the same way
    // capture's canonical root does. Only trust an alias root that canonicalizes
    // back to the capture root: a leaf symlink (e.g. /links/alias -> root/pkg)
    // yields a bogus ancestor (/links) that would mis-scope or invent evidence.
    let rootAliases: string[] | undefined;
    if (meta.cwd !== canonicalCwd) {
      const aliasRoot = resolve(meta.cwd, relative(canonicalCwd, root));
      if ((await io.realpath(aliasRoot)) === root) rootAliases = [aliasRoot];
    }
    bindings.push({
      path,
      ctx: {
        harness: 'codex',
        harnessSessionId: meta.id,
        root,
        cwd: canonicalCwd,
        adapterVersion: CODEX_ADAPTER_VERSION,
        ...(rootAliases !== undefined ? { rootAliases } : {}),
      },
    });
  }
  return { bindings, issues };
}

export async function discover(
  harness: HarnessName,
  io: DiscoveryIO,
  home: string,
  root: string,
  codexScanLimit: number,
): Promise<DiscoveryResult> {
  return harness === 'claude-code'
    ? discoverClaude(io, home, root)
    : discoverCodex(io, home, root, codexScanLimit);
}
