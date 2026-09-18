import { isAbsolute } from 'node:path';
import type { IdentityResult } from '../harness-context.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Codex identity adapter (fail-closed).
 *
 * Per the SC3 probe (tools/identity-probe/FINDINGS.md): Codex exposes NO identity
 * environment variable and a clean env at startup — identity arrives ONLY on the
 * tool call, in `_meta`. The carrier is `_meta.threadId` (== session_id) plus
 * `_meta['x-codex-turn-metadata'].workspaces`, a map from the canonical worktree
 * path to its origin/commit. `cwd` is unreliable (sometimes `/`) and is never a
 * binding input.
 *
 * Fail closed unless `_meta` is present, `threadId` is present, and `workspaces`
 * has EXACTLY one key: an absent, empty, or multi-root map is ambiguous, so we
 * refuse rather than guess. (A dropped Codex transport is terminal for the binding
 * — recovery needs a new conversation — but that is the transport's concern, not
 * this pure derivation's.)
 */
export function codexIdentity(toolCallParams: unknown): IdentityResult {
  if (!isObject(toolCallParams)) return { unresolved: 'tool call has no params' };
  const meta = toolCallParams._meta;
  if (!isObject(meta)) return { unresolved: 'tool call _meta is absent' };
  const threadId = meta.threadId;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return { unresolved: 'tool call _meta.threadId is absent' };
  }
  const turn = meta['x-codex-turn-metadata'];
  if (!isObject(turn)) return { unresolved: 'tool call _meta.x-codex-turn-metadata is absent' };
  const workspaces = turn.workspaces;
  if (!isObject(workspaces)) return { unresolved: 'tool call _meta workspaces map is absent' };
  const keys = Object.keys(workspaces);
  if (keys.length === 0) return { unresolved: 'workspaces map is empty; worktree root is ambiguous' };
  if (keys.length > 1) return { unresolved: `workspaces map has ${keys.length} roots; ambiguous` };
  const worktree = keys[0]!;
  // The worktree root must be an absolute path. A relative key (`.`, or an array's
  // `0`) would be resolved against the daemon's own CWD, which is never a binding
  // input — reject it before contacting the daemon.
  if (!isAbsolute(worktree)) return { unresolved: `workspace root ${worktree} is not an absolute path` };
  return { harness: 'codex', harness_session_id: threadId, worktree };
}
