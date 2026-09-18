/**
 * The forwarder's harness-identity resolver.
 *
 * SC3 requires verified harness session context; CWD alone is insufficient, and
 * ambiguous identity must FAIL rather than guess. The two harnesses expose
 * identity by different mechanisms and at different times (see FINDINGS.md), so
 * this dispatches by `clientInfo.name` at `initialize`:
 *   - claude-code   → identity is the env triple, observable eagerly at initialize
 *                     and cached (tool-call params carry no identity).
 *   - codex-mcp-client → identity arrives only per tool call, derived each time.
 *
 * Anything else — an unrecognized client, or a call before initialize — fails
 * closed. `worktree`/`harness_session_id` here are DECLARED context the forwarder
 * ships to the daemon; the daemon does the selection comparison.
 */
import { claudeIdentity } from './harness-context/claude.ts';
import { codexIdentity } from './harness-context/codex.ts';

export type Identity = { harness: string; harness_session_id: string; worktree: string };
export type IdentityResult = Identity | { unresolved: string };

export function isResolved(result: IdentityResult): result is Identity {
  return !('unresolved' in result);
}

type Env = Record<string, string | undefined>;

export interface HarnessContext {
  /** Called once with the initialize `clientInfo` and the subprocess env. Selects
   * the per-harness resolver; for Claude it eagerly captures the env triple. */
  initialize(clientInfo: unknown, env: Env): void;
  /** Resolve the declared identity for one tool call, or a fail-closed reason. */
  identityForCall(toolCallParams: unknown): IdentityResult;
}

export const CLAUDE_CLIENT = 'claude-code';
export const CODEX_CLIENT = 'codex-mcp-client';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createHarnessContext(): HarnessContext {
  let resolve: (params: unknown) => IdentityResult = () => ({
    unresolved: 'harness not initialized',
  });

  return {
    initialize(clientInfo, env) {
      const name = isObject(clientInfo) && typeof clientInfo.name === 'string' ? clientInfo.name : undefined;
      if (name === CLAUDE_CLIENT) {
        const cached = claudeIdentity(env); // eager: the env triple is available now
        resolve = () => cached;
      } else if (name === CODEX_CLIENT) {
        resolve = (params) => codexIdentity(params); // per-call: identity only at declaration
      } else {
        const reason = `unrecognized harness clientInfo.name: ${name ?? '(absent)'}`;
        resolve = () => ({ unresolved: reason });
      }
    },
    identityForCall(toolCallParams) {
      return resolve(toolCallParams);
    },
  };
}
