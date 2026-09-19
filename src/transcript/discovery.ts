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
import { relative, sep } from 'node:path';
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

export interface DiscoveryIO {
  /** Absolute paths of `*.jsonl` files directly in `dir` (Claude). */
  listDir(dir: string): Promise<ListResult>;
  /** Absolute paths of every `*.jsonl` under `dir` recursively (Codex), capped
   * at `limit`; `truncated` means more existed than were returned. */
  listTreeJsonl(dir: string, limit: number): Promise<{ paths: string[]; truncated: boolean } | { ok: false; reason: 'missing' | 'inaccessible' }>;
  /** The first line of a file, for reading a Codex `session_meta`. */
  readFirstLine(path: string): Promise<string | undefined>;
  /** Canonicalize a path, or undefined if it does not resolve. */
  realpath(path: string): Promise<string | undefined>;
}

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
    const name = baseName(path);
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
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
  const { paths, truncated } = listed as { paths: string[]; truncated: boolean };
  const issues: CoverageIssue[] = [];
  if (truncated) {
    issues.push({
      kind: 'discovery-limited',
      detail: `codex session scan hit the ${limit}-file cap; some transcripts may be unread`,
    });
  }
  const bindings: TranscriptBinding[] = [];
  for (const path of paths) {
    const head = await io.readFirstLine(path);
    if (head === undefined) continue;
    const meta = parseSessionMeta(head);
    if (!meta) continue;
    const canonicalCwd = await io.realpath(meta.cwd);
    if (canonicalCwd === undefined) continue;
    if (!isWithinRoot(root, canonicalCwd)) continue;
    bindings.push({
      path,
      ctx: {
        harness: 'codex',
        harnessSessionId: meta.id,
        root,
        cwd: canonicalCwd,
        adapterVersion: CODEX_ADAPTER_VERSION,
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
