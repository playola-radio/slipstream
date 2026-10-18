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
import type { FileId } from './file-reader.ts';
import type { AdapterContext } from './types.ts';

export const CLAUDE_ADAPTER_VERSION = 'claude-code/1';
export const CODEX_ADAPTER_VERSION = 'codex/1';

export interface TranscriptBinding {
  path: string;
  ctx: AdapterContext;
  /** The file generation whose bytes discovery read to derive this binding's ctx.
   * The reader is pinned to it and refuses a replacement it has not re-confirmed. */
  generation: FileId;
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
  | { ok: true; line: string; id: FileId }
  | { ok: false; reason: 'inaccessible' | 'empty' | 'malformed' };

/** A bounded, decoded set of a transcript's leading lines, for scanning past a
 * cwd-less preamble to the first cwd-bearing line.
 * `truncated`: the scan stopped at a line/byte budget, so more lines may lie
 * beyond it (a cwd could exist past the searched head); false means the whole file
 * was read.
 * `skipped`: at least one line within the scanned head was dropped (it exceeded
 * the per-line cap, or was not valid UTF-8), so a cwd could have sat on a line we
 * never examined — the caller must not read "no cwd found" as a clean preamble. */
export type HeadLinesResult =
  | { ok: true; lines: string[]; truncated: boolean; skipped: boolean; id: FileId }
  | { ok: false; reason: 'inaccessible' | 'empty' };

export interface DiscoveryIO {
  /** Absolute paths of `*.jsonl` files directly in `dir` (Claude). */
  listDir(dir: string): Promise<ListResult>;
  /** Absolute paths of every `*.jsonl` under `dir` recursively (Codex), capped
   * at `limit`. */
  listTreeJsonl(dir: string, limit: number): Promise<TreeResult>;
  /** The first line of a file, for reading a Codex `session_meta`. */
  readFirstLine(path: string): Promise<FirstLineResult>;
  /** A bounded set of a Claude transcript's leading lines, for scanning past its
   * cwd-less preamble (ai-title, queue-operation, attachments) to the first record
   * that declares the working directory. */
  readHeadLines(path: string): Promise<HeadLinesResult>;
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

/** Where an unresolvable cwd sits once every living component is canonicalized,
 * or `undecidable` when it cannot be placed cheaply. Root-independent, so one walk
 * serves every capture root in a discovery cycle. */
type UnresolvedPlacement = { kind: 'placed'; path: string } | { kind: 'undecidable' };

/**
 * Place an UNRESOLVABLE cwd so each capture root can tell whether it could still
 * sit inside it: an in-root candidate we failed to read rather than a genuine
 * non-candidate.
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
async function placeUnresolvedCwd(io: Pick<DiscoveryIO, 'realpath' | 'probe'>, cwd: string): Promise<UnresolvedPlacement> {
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
      if (symlinkHops > MAX_UNRESOLVED_HOPS) return { kind: 'undecidable' }; // cycle: disclose
      if (isAbsolute(probe.target)) base = '/';
      queue.splice(cursor, 0, ...segmentsOf(probe.target));
      continue;
    }
    return { kind: 'undecidable' }; // uninspectable (e.g. permissions): cannot rule out membership
  }
  return { kind: 'placed', path: base };
}

/** Path resolution memoized for one discovery cycle, so a cwd shared by many
 * transcripts, or checked against many capture roots, is resolved once. It holds
 * filesystem facts only; each root still classifies against them itself. */
interface CwdResolver {
  realpath(path: string): Promise<string | undefined>;
  placeUnresolved(cwd: string): Promise<UnresolvedPlacement>;
}

function createCwdResolver(io: DiscoveryIO): CwdResolver {
  const real = new Map<string, Promise<string | undefined>>();
  const placed = new Map<string, Promise<UnresolvedPlacement>>();
  const memoIO: Pick<DiscoveryIO, 'realpath' | 'probe'> = {
    probe: (path) => io.probe(path),
    realpath: (path) => {
      let p = real.get(path);
      if (!p) real.set(path, (p = io.realpath(path)));
      return p;
    },
  };
  return {
    realpath: memoIO.realpath,
    placeUnresolved: (cwd) => {
      let p = placed.get(cwd);
      if (!p) placed.set(cwd, (p = placeUnresolvedCwd(memoIO, cwd)));
      return p;
    },
  };
}

/** How a transcript's recorded cwd relates to the capture root. */
type CwdClassification =
  | { kind: 'in-root'; cwd: string; rootAliases?: string[] }
  | { kind: 'out-of-root' } // a different worktree's session: skip silently
  | { kind: 'unresolved-in-root' }; // an in-root candidate we could not read: disclose

/**
 * Classify a recorded cwd against the capture root, the single membership rule
 * shared by both harnesses. The recorded cwd — never the on-disk location — is
 * what establishes which worktree a transcript belongs to, so a slug collision
 * (Claude) or a shared global sessions dir (Codex) cannot bind another worktree's
 * session to this root.
 */
async function classifyCwd(resolver: CwdResolver, root: string, cwd: string): Promise<CwdClassification> {
  const canonicalCwd = await resolver.realpath(cwd);
  if (canonicalCwd === undefined) {
    const placed = await resolver.placeUnresolved(cwd);
    return placed.kind === 'undecidable' || isWithinRoot(root, placed.path)
      ? { kind: 'unresolved-in-root' }
      : { kind: 'out-of-root' };
  }
  if (!isWithinRoot(root, canonicalCwd)) return { kind: 'out-of-root' };
  // If the recorded cwd is a non-canonical alias reached through a symlinked
  // ANCESTOR, its root form relativizes a record's absolute paths the same way
  // capture's canonical root does. Only trust an alias root that canonicalizes
  // back to the capture root: a leaf symlink (e.g. /links/alias -> root/pkg)
  // yields a bogus ancestor (/links) that would mis-scope or invent evidence.
  let rootAliases: string[] | undefined;
  if (cwd !== canonicalCwd) {
    const aliasRoot = resolve(cwd, relative(canonicalCwd, root));
    if ((await resolver.realpath(aliasRoot)) === root) rootAliases = [aliasRoot];
  }
  return { kind: 'in-root', cwd: canonicalCwd, ...(rootAliases !== undefined ? { rootAliases } : {}) };
}

/** What one transcript line yields about the working directory: a cwd, a clean
 * record without one, or a line that would not parse (which a cwd record always
 * does, so a malformed line is a gap we cannot read the cwd through, not proof of
 * absence). */
type LineCwd = { kind: 'cwd'; cwd: string } | { kind: 'no-cwd' } | { kind: 'malformed' };

function readLineCwd(line: string): LineCwd {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  // A valid JSON scalar or `null` parses cleanly but is not a cwd-bearing record;
  // it carries no cwd, it is not malformed. Guard before property access so a bare
  // `null` line cannot throw past the catch and abort the whole discovery tick.
  if (typeof obj !== 'object' || obj === null) return { kind: 'no-cwd' };
  const cwd = (obj as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? { kind: 'cwd', cwd } : { kind: 'no-cwd' };
}

/** The outcome of searching a Claude transcript for its recorded working directory.
 * `found` carries the generation ({@link FileId}) of the exact bytes the cwd was
 * read from, so the reader can be pinned to the file whose content established
 * membership. */
type ClaudeCwdResolution =
  | { kind: 'found'; cwd: string; id: FileId } // a cwd-bearing record was read
  | { kind: 'none' } // the whole head was read cleanly and carries no cwd yet (empty or a preamble)
  | { kind: 'unconfirmed'; reason: 'inaccessible' | 'malformed'; detail: string }; // a cwd may exist but the head could not be searched through

/**
 * Search a Claude transcript for the working directory it declares. A session's
 * first records are a cwd-less preamble (ai-title, queue-operation, attachments),
 * so the first line rarely carries the cwd; scan a bounded head for the first
 * record that does.
 *
 * `none` means the searched head was read cleanly and genuinely holds no cwd yet —
 * an empty or still-preamble transcript — which the caller withholds (pending) and
 * re-checks once more is written. `unconfirmed` means a cwd could exist but the
 * head could NOT be searched through to rule it out — the scan hit its budget
 * (truncated), a line was skipped (oversized/undecodable) or malformed, or the head
 * was unreadable — so membership cannot be trusted; the caller discloses it rather
 * than treat it as a clean preamble or slug-trust a candidate that could belong to
 * a slug-colliding sibling worktree.
 */
async function resolveClaudeCwd(
  io: DiscoveryIO,
  path: string,
  firstLine: string,
  firstId: FileId,
): Promise<ClaudeCwdResolution> {
  const first = readLineCwd(firstLine);
  // The cwd came off the first line: pin to that read's generation (`firstId`).
  if (first.kind === 'cwd') return { kind: 'found', cwd: first.cwd, id: firstId };
  let sawMalformed = first.kind === 'malformed';
  const head = await io.readHeadLines(path);
  // The first line already read, so the file is non-empty; an unreadable or
  // raced-to-empty head here leaves membership unconfirmable.
  if (!head.ok) return { kind: 'unconfirmed', reason: 'inaccessible', detail: 'the head could not be read' };
  for (const line of head.lines) {
    const parsed = readLineCwd(line);
    // The cwd came off the head scan: pin to the head read's generation, the exact
    // bytes this cwd was decoded from (not the earlier first-line read, which may
    // predate a replacement the head then read through).
    if (parsed.kind === 'cwd') return { kind: 'found', cwd: parsed.cwd, id: head.id };
    if (parsed.kind === 'malformed') sawMalformed = true;
  }
  // No cwd in the searched head. Only a head that was read through cleanly (every
  // line examined, none skipped, none malformed, nothing beyond the window) is a
  // genuine still-preamble transcript; anything else is a gap we must disclose so a
  // cwd we could not read is never mistaken for a cwd that is not there yet.
  if (head.truncated) {
    return { kind: 'unconfirmed', reason: 'inaccessible', detail: 'a cwd may lie beyond the truncated head' };
  }
  if (head.skipped) {
    return { kind: 'unconfirmed', reason: 'inaccessible', detail: 'an oversized or undecodable head line may carry the cwd' };
  }
  if (sawMalformed) {
    return { kind: 'unconfirmed', reason: 'malformed', detail: 'a malformed head line may carry the cwd' };
  }
  return { kind: 'none' };
}

/** One result per distinct root, each with its own arrays. */
function emptyResults(roots: readonly string[]): Map<string, DiscoveryResult> {
  return new Map([...new Set(roots)].map((root) => [root, { bindings: [], issues: [] }]));
}

/** Disclose one issue to every root it concerns, each getting its own copy. */
function discloseTo(results: Map<string, DiscoveryResult>, roots: Iterable<string>, issue: CoverageIssue): void {
  for (const root of roots) results.get(root)!.issues.push({ ...issue });
}

/**
 * Claude discovery for several capture roots in one pass. Each Claude project
 * directory is listed once and each transcript head read once, however many roots
 * slug onto it; the recorded cwd then decides, per root, whether it is a member.
 */
export async function discoverClaudeRoots(
  io: DiscoveryIO,
  home: string,
  roots: readonly string[],
): Promise<Map<string, DiscoveryResult>> {
  const results = emptyResults(roots);
  const resolver = createCwdResolver(io);
  const byDir = new Map<string, string[]>();
  for (const root of results.keys()) {
    const dir = `${home}/projects/${claudeSlug(root)}`;
    byDir.set(dir, [...(byDir.get(dir) ?? []), root]);
  }
  for (const [dir, group] of byDir) {
    const listed = await io.listDir(dir);
    if (!listed.ok) {
      discloseTo(results, group, { kind: listed.reason, detail: `claude project dir ${dir}` });
      continue;
    }
    for (const path of listed.paths) {
      const sessionId = baseName(path).slice(0, -'.jsonl'.length);
      // The slug directory alone cannot establish membership: two distinct roots can
      // collide onto one slug (e.g. /work/a-b and /work/a/b). So a transcript is bound
      // ONLY once its recorded cwd has been read and confirmed in-root — it is never
      // slug-trusted. Until confirmation:
      //   - an empty or still-preamble transcript is withheld with no issue (pending
      //     coverage); it is re-checked next tick once more is written, and no record
      //     is ingested under an unconfirmed binding (so a colliding sibling's records
      //     landing before confirmation can never be credited to this root);
      //   - a transcript whose membership cannot be confirmed (unreadable/oversized or
      //     truncated head, or an in-root cwd that will not resolve) is disclosed.
      const head = await io.readFirstLine(path);
      if (!head.ok) {
        if (head.reason === 'empty') continue; // not yet written: withhold, stays pending
        // A first line that exists but could not be read (malformed, e.g. invalid
        // UTF-8 or an unbounded line; or inaccessible): disclose the gap.
        discloseTo(results, group, { kind: head.reason, detail: `claude transcript ${path}` });
        continue;
      }
      const resolution = await resolveClaudeCwd(io, path, head.line, head.id);
      if (resolution.kind === 'none') continue; // a cwd-less preamble so far: withhold, pending
      if (resolution.kind === 'unconfirmed') {
        discloseTo(results, group, {
          kind: resolution.reason,
          detail: `claude transcript ${path} membership unconfirmed: ${resolution.detail}`,
        });
        continue;
      }
      for (const root of group) {
        const result = results.get(root)!;
        const cls = await classifyCwd(resolver, root, resolution.cwd);
        if (cls.kind === 'out-of-root') continue; // a slug-colliding other worktree
        if (cls.kind === 'unresolved-in-root') {
          result.issues.push({
            kind: 'inaccessible',
            detail: `claude transcript ${path} cwd ${resolution.cwd} could not be resolved`,
          });
          continue;
        }
        result.bindings.push({
          path,
          ctx: {
            harness: 'claude-code',
            harnessSessionId: sessionId,
            root,
            cwd: cls.cwd,
            adapterVersion: CLAUDE_ADAPTER_VERSION,
            ...(cls.rootAliases !== undefined ? { rootAliases: cls.rootAliases } : {}),
          },
          generation: resolution.id,
        });
      }
    }
  }
  return results;
}

export async function discoverClaude(io: DiscoveryIO, home: string, root: string): Promise<DiscoveryResult> {
  return (await discoverClaudeRoots(io, home, [root])).get(root)!;
}

function parseSessionMeta(line: string): { id: string; cwd: string } | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'session_meta') return undefined;
    const payload = obj.payload;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const p = payload as Record<string, unknown>;
    // An empty id or cwd is not a usable session identity/scope: keying evidence
    // under "" would collapse unrelated sessions, so treat it as malformed (undefined).
    if (typeof p.id !== 'string' || p.id.length === 0 || typeof p.cwd !== 'string' || p.cwd.length === 0) {
      return undefined;
    }
    return { id: p.id, cwd: p.cwd };
  } catch {
    return undefined;
  }
}


/**
 * Codex discovery for several capture roots in one pass. The global sessions tree
 * is enumerated once and each rollout's `session_meta` read once; its cwd then
 * decides, per root, whether it is a member. A scan-wide gap (the file cap, an
 * unreadable subdirectory, a rollout we cannot read) could hide any root's
 * session, so it is disclosed to every root, exactly as a lone scan would.
 */
export async function discoverCodexRoots(
  io: DiscoveryIO,
  home: string,
  roots: readonly string[],
  limit: number,
): Promise<Map<string, DiscoveryResult>> {
  const results = emptyResults(roots);
  const all = [...results.keys()];
  const dir = `${home}/sessions`;
  const listed = await io.listTreeJsonl(dir, limit);
  if ('ok' in listed && listed.ok === false) {
    discloseTo(results, all, { kind: listed.reason, detail: `codex sessions dir ${dir}` });
    return results;
  }
  const { paths, truncated, incomplete } = listed as {
    paths: string[];
    truncated: boolean;
    incomplete: boolean;
  };
  if (truncated) {
    discloseTo(results, all, {
      kind: 'discovery-limited',
      detail: `codex session scan hit the ${limit}-file cap; some transcripts may be unread`,
    });
  }
  if (incomplete) {
    discloseTo(results, all, {
      kind: 'inaccessible',
      detail: `some codex session subdirectories under ${dir} were unreadable`,
    });
  }
  const resolver = createCwdResolver(io);
  for (const path of paths) {
    // A file we cannot read or parse is a candidate we cannot rule out, so it is
    // disclosed as an issue — never silently skipped (which would let a readable
    // sibling conceal it and report coverage as clean).
    const head = await io.readFirstLine(path);
    if (!head.ok) {
      discloseTo(results, all, {
        kind: head.reason === 'inaccessible' ? 'inaccessible' : 'malformed',
        detail: `codex rollout ${path}`,
      });
      continue;
    }
    const meta = parseSessionMeta(head.line);
    if (!meta) {
      discloseTo(results, all, { kind: 'malformed', detail: `codex rollout ${path} has no session_meta` });
      continue;
    }
    for (const root of all) {
      const result = results.get(root)!;
      const cls = await classifyCwd(resolver, root, meta.cwd);
      if (cls.kind === 'out-of-root') continue;
      if (cls.kind === 'unresolved-in-root') {
        // An in-root candidate we failed to read: disclose the gap rather than let a
        // readable sibling report clean coverage. A cwd whose nearest living ancestor
        // is outside the root is a different worktree's session, skipped silently.
        result.issues.push({ kind: 'inaccessible', detail: `codex rollout ${path} cwd ${meta.cwd} could not be resolved` });
        continue;
      }
      result.bindings.push({
        path,
        ctx: {
          harness: 'codex',
          harnessSessionId: meta.id,
          root,
          cwd: cls.cwd,
          adapterVersion: CODEX_ADAPTER_VERSION,
          ...(cls.rootAliases !== undefined ? { rootAliases: cls.rootAliases } : {}),
        },
        // The Codex ctx derives entirely from line 1 (session_meta), so the generation
        // is the first-line read that produced it.
        generation: head.id,
      });
    }
  }
  return results;
}

export async function discoverCodex(
  io: DiscoveryIO,
  home: string,
  root: string,
  limit: number,
): Promise<DiscoveryResult> {
  return (await discoverCodexRoots(io, home, [root], limit)).get(root)!;
}

/** One harness's discovery for every given capture root, sharing enumeration and
 * header reads across them. */
export async function discoverRoots(
  harness: HarnessName,
  io: DiscoveryIO,
  home: string,
  roots: readonly string[],
  codexScanLimit: number,
): Promise<Map<string, DiscoveryResult>> {
  return harness === 'claude-code'
    ? discoverClaudeRoots(io, home, roots)
    : discoverCodexRoots(io, home, roots, codexScanLimit);
}

export async function discover(
  harness: HarnessName,
  io: DiscoveryIO,
  home: string,
  root: string,
  codexScanLimit: number,
): Promise<DiscoveryResult> {
  return (await discoverRoots(harness, io, home, [root], codexScanLimit)).get(root)!;
}
