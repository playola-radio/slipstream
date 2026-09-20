import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { EvidenceFileScope, HarnessName } from '../event.ts';
import type { NormalizedEvidence } from '../evidence-ingest.ts';

/**
 * The pure transcript-adapter cores turn one parsed transcript record into
 * normalized evidence, given a binding context. They are deliberately I/O-free:
 * discovery, incremental reads, and filesystem canonicalization live in the
 * plumbing around them, so the record→evidence mapping is fixture-provable with
 * zero I/O (the required native-identity test).
 */
export interface AdapterContext {
  harness: HarnessName;
  /** The bound harness session id (namespaces every native record id). */
  harnessSessionId: string;
  /**
   * The canonical (realpath) capture root. Evidence paths are relativized against
   * it EXACTLY as capture does (`relative(root, abs)`), so an adapter's
   * `file_scope.paths` line up with `file.changed.path` — otherwise the reducer's
   * exact-string match silently never fires.
   */
  root: string;
  /** The invocation's working directory (canonical), used to resolve a record's
   * relative paths (Codex shell/apply_patch). Absolute record paths ignore it. */
  cwd: string;
  /**
   * Confirmed non-canonical aliases of {@link root} (e.g. the `/tmp` form of a
   * `/private/tmp` root when the worktree is reached through a symlinked
   * ancestor). A record's absolute path in an alias namespace relativizes to the
   * same in-root path as capture's canonical form, so it must not be dropped.
   * Populated by discovery only when it observes an alias; empty otherwise.
   */
  rootAliases?: readonly string[];
  /** Recorded on every emitted record for provenance; excluded from the dedup
   * variant signature so an adapter version bump alone is not a new variant. */
  adapterVersion: string;
}

/** A per-record signal the plumbing folds into coverage health. The pure core
 * only ever produces the two kinds it can observe from a record's content; the
 * I/O layer adds `missing`/`inaccessible`/`discovery-limited`. */
export type Diagnostic =
  | { kind: 'malformed'; detail: string }
  | { kind: 'unsupported'; detail: string };

/** The result of folding one record into an adapter's running state. */
export interface StepResult<S> {
  state: S;
  evidence: NormalizedEvidence[];
  diagnostics: Diagnostic[];
}

/**
 * Relativize native paths into the capture root's space, dropping anything that
 * escapes the root (a different worktree, a parent dir) — such a write cannot
 * match any change this session captures. Returns a `paths` scope with the
 * in-root paths, or `undefined` when nothing remains in scope.
 *
 * Pure and string-only: it assumes `root`/`cwd` are already canonical (the
 * plumbing realpaths them once at bind time). An absolute record path in a
 * confirmed alias namespace (`ctx.rootAliases`) relativizes to the same in-root
 * path as capture's canonical form, so it is kept rather than silently dropped.
 */
export function scopeFromPaths(
  rawPaths: readonly string[],
  ctx: Pick<AdapterContext, 'root' | 'cwd' | 'rootAliases'>,
): Extract<EvidenceFileScope, { kind: 'paths' }> | undefined {
  const roots = [ctx.root, ...(ctx.rootAliases ?? [])];
  const kept: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
    for (const root of roots) {
      const rel = relative(root, abs);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      if (!kept.includes(rel)) kept.push(rel);
      break;
    }
  }
  return kept.length > 0 ? { kind: 'paths', paths: kept } : undefined;
}
