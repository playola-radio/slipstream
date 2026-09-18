import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { IdentityResult } from '../harness-context.ts';

/**
 * Claude Code identity adapter (fail-closed).
 *
 * Per the SC3 probe (tools/identity-probe/FINDINGS.md): Claude Code exposes a
 * FRESH `CLAUDE_CODE_SESSION_ID` (a real UUID) plus `CLAUDE_PROJECT_DIR` in the
 * subprocess environment at `initialize` — before any tool declaration — and the
 * tool-call `_meta` carries NO identity. So the binding is the env triple,
 * observed once and cached; a session without both vars fails closed on every
 * call rather than guessing from cwd/PID.
 *
 * The worktree is canonicalized with the SAME realpath policy the daemon applies
 * at attach, so a symlinked project dir reports the durable root the daemon stored
 * (idempotent — the daemon re-canonicalizes defensively). realpath runs
 * synchronously here: this is a one-shot capture at subprocess startup.
 */
export function claudeIdentity(env: Record<string, string | undefined>): IdentityResult {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { unresolved: 'CLAUDE_CODE_SESSION_ID is absent from the environment' };
  }
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    return { unresolved: 'CLAUDE_PROJECT_DIR is absent from the environment' };
  }
  // A relative project dir would be resolved against the forwarder's CWD, which is
  // never a binding input; require an absolute path and fail closed otherwise.
  if (!isAbsolute(projectDir)) {
    return { unresolved: `CLAUDE_PROJECT_DIR ${projectDir} is not an absolute path` };
  }
  let worktree = projectDir;
  try {
    worktree = realpathSync(projectDir);
  } catch {
    // The path does not resolve on this host; send the raw value. The daemon
    // re-canonicalizes and compares, so an unresolvable path simply fails to match
    // rather than being silently accepted — no honesty loss here.
  }
  return { harness: 'claude-code', harness_session_id: sessionId, worktree };
}
