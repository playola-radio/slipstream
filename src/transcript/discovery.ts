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

/** Join `base` and `segment` textually, WITHOUT collapsing `..`: any `..` must be
 * resolved against the real filesystem by a later `realpath`, since an
 * intervening symlink makes lexical collapse wrong. */
function rawJoin(base: string, segment: string): string {
  if (segment === '') return base;
  return base.endsWith('/') ? base + segment : `${base}/${segment}`;
}

/**
 * True when an UNRESOLVABLE cwd could still sit inside the capture root, so it is
 * an in-root candidate we failed to read rather than a genuine non-candidate.
 *
 * A textual check is unreliable both ways: the raw string may be in the root's
 * alias namespace (cwd `/tmp/proj/gone` for canonical root `/private/tmp/proj`)
 * yet be in-root, or textually in-root yet escape through an internal symlink
 * (`/work/proj/link/gone` where `link` -> `/other/project`). So we degrade the
 * way `realpath` itself would: resolve the longest existing prefix, then decide
 * membership from what remains. `probe` classifies the first component that
 * failed to resolve:
 * - `absent`: the rest is plain names off the prefix's canonical location.
 * - `symlink`: follow its RAW literal target by textual concatenation (never
 *   lexical `..` collapse — an intervening symlink must be resolved first) and
 *   re-run, letting the next `realpath` hop resolve `..` and chained links.
 * - `present`/`error`: we could not resolve through it (e.g. a permission wall),
 *   so membership is undetermined — disclose rather than silently drop.
 *
 * A cwd that places outside the root is a different worktree's session, skipped
 * silently so unrelated dead sessions never degrade this root's coverage.
 * Undecidable cases (uninspectable component, hop-cap exhaustion) fail toward
 * disclosure: never claim non-membership we did not establish.
 */
async function unresolvedCwdMayBeInRoot(
  io: DiscoveryIO,
  root: string,
  cwd: string,
): Promise<boolean> {
  let path = cwd;
  for (let hop = 0; hop < MAX_UNRESOLVED_HOPS; hop += 1) {
    const direct = await io.realpath(path);
    if (direct !== undefined) return isWithinRoot(root, direct);
    // Walk up (string-only, preserving `..`) to the longest ancestor that
    // resolves; realpath follows any symlinks it contains, so its form is exact.
    let ancestor = dirname(path);
    let canonical = await io.realpath(ancestor);
    while (canonical === undefined) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return true; // not even '/' resolves: cannot rule out
      ancestor = parent;
      canonical = await io.realpath(ancestor);
    }
    // The first non-resolving component is the next segment of `path` below
    // `ancestor`; everything after it is the still-unresolved remainder.
    const tail = path.slice(ancestor === '/' ? 1 : ancestor.length + 1);
    const firstSeg = tail.split('/')[0]!;
    const firstChild = rawJoin(ancestor, firstSeg);
    const afterFirst = path.slice(firstChild.length); // '' or leading-'/' remainder
    const probe = await io.probe(firstChild);
    if (probe.kind === 'absent') {
      // Plain (non-symlink) missing names: safe to resolve off the canonical
      // parent, since none of them are symlinks that `..` could cross.
      return isWithinRoot(root, resolve(canonical, tail));
    }
    if (probe.kind !== 'symlink') return true; // uninspectable: disclose
    // Dangling symlink: rebuild the path from its literal target (relative
    // targets against the link's textual parent), preserving `..` for the next
    // realpath hop, then re-append whatever came after the link.
    const base = isAbsolute(probe.target) ? probe.target : rawJoin(ancestor, probe.target);
    path = `${base}${afterFirst}`;
  }
  return true; // hop cap exhausted (e.g. a cycle): disclose rather than drop
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
