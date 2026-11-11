/**
 * name_workspace orchestration for the MCP forwarder.
 *
 * One send, never a resend: a lost reply may follow a name that landed, and a
 * second send could overwrite a newer replacement or reach a relinked session.
 * Retrying is the agent's deliberate choice, so ambiguity is OUTCOME_UNKNOWN.
 * Arguments pass through raw; the daemon is the authority on their validity.
 */
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { isResolved, type IdentityResult } from './harness-context.ts';
import type { ToolResult } from './mcp-protocol.ts';

export interface ForwardNameDeps {
  identity: IdentityResult;
  name: unknown;
  /** Forwarded only when the caller passed the key. */
  replaceExisting: unknown | undefined;
  /** Send one control request. Resolves a response envelope (including a
   * synthesized DAEMON_UNAVAILABLE) or throws {@link OutcomeUnknownError}. */
  send: (request: RequestEnvelope) => Promise<ResponseEnvelope>;
}

function failure(code: string, message: string): ToolResult {
  return { text: `${code}: ${message}`, isError: true, structured: { code } };
}

const outcomeUnknown = (): ToolResult => failure('OUTCOME_UNKNOWN',
  'the name was sent but whether it was saved could not be confirmed');

export async function forwardNameWorkspace(deps: ForwardNameDeps): Promise<ToolResult> {
  if (!isResolved(deps.identity)) return failure('IDENTITY_UNRESOLVED', deps.identity.unresolved);
  const envelope: RequestEnvelope = {
    v: 1,
    verb: 'name_workspace',
    name: deps.name,
    ...(deps.replaceExisting === undefined ? {} : { replace_existing: deps.replaceExisting }),
    harness: deps.identity.harness,
    harness_session_id: deps.identity.harness_session_id,
    worktree: deps.identity.worktree,
  };
  let res: ResponseEnvelope;
  try { res = await deps.send(envelope); } catch (err) {
    if (err instanceof OutcomeUnknownError) return outcomeUnknown();
    throw err;
  }
  if (!res.ok) return failure(res.code, res.message);
  if (typeof res.changed !== 'boolean') return outcomeUnknown();
  const text = res.changed ? 'Agent name saved.' : 'An agent name was already set; kept it.';
  return { text, isError: false, structured: { changed: res.changed } };
}
