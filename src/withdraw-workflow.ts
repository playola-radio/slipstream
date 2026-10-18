/**
 * `slipstream detach`, `slipstream unlink` and `slipstream conductor archive`.
 * Each goes through the daemon when one runs. With no daemon, the CLI records the
 * withdrawal in the intent record itself, under the store lock (contracts.md §8),
 * so a later daemon never resumes it. Nothing is written to the session's log:
 * no capture ran, so no stop is claimed and the state is `stop-unconfirmed`.
 */
import { realpath } from 'node:fs/promises';
import type { ResponseEnvelope } from './control-protocol.ts';
import { NoCaptureError, unlinkOffline, withdrawOffline } from './intent-store.ts';
import { SessionOwnedError } from './lock.ts';
import { isValidSessionId } from './store-reader.ts';

export interface WithdrawDeps {
  store: string;
  control: (request: Record<string, unknown> & { verb: string }) => Promise<ResponseEnvelope>;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A starting daemon holds the store lock before its socket answers. */
const LOCKED_RETRY_MS = 10_000;
const LOCKED_POLL_MS = 250;

/** `missingOk` makes a target with no capture a success: an archive script must
 * not fail for a workspace Slipstream never captured. */
export async function runWithdraw(opts: { target: string; reason: 'detached' | 'archived'; missingOk?: boolean },
  deps: WithdrawDeps): Promise<number> {
  const request = { verb: 'detach', target: opts.target, ...(opts.reason === 'archived' ? { reason: 'archived' } : {}) };
  const nothing = (message: string) => deps.out(`slipstream: ${message}; nothing to withdraw.`);
  const missing = opts.missingOk ? (res: ResponseEnvelope) => !res.ok && res.code === 'TARGET_NOT_FOUND' : () => false;
  return untilUnlocked(deps, request, async () => {
    let result;
    try { result = await withdrawOffline(deps.store, await offlineTarget(opts.target), opts.reason); } catch (err) {
      if (!opts.missingOk || !(err instanceof NoCaptureError)) throw err;
      nothing(err.message);
      return;
    }
    if (result.withdrawn.length === 0) deps.out('already_withdrawn: true');
    for (const id of result.withdrawn) {
      deps.out(`session_id: ${id}`);
      deps.out('state: not_recording');
      deps.out('reason: stop-unconfirmed');
    }
    deps.out('slipstream: no daemon is running; the withdrawal is recorded and will not be resumed. '
      + 'No stop was written to the session, because none was observed.');
  }, missing, nothing);
}

export async function runUnlink(opts: { sessionId: string }, deps: WithdrawDeps): Promise<number> {
  return untilUnlocked(deps, { verb: 'unlink', session_id: opts.sessionId }, async () => {
    if (!await unlinkOffline(deps.store, opts.sessionId)) {
      deps.out(`session_id: ${opts.sessionId}`);
      deps.out('already_unlinked: true');
      return;
    }
    deps.out(`session_id: ${opts.sessionId}`);
    deps.out('slipstream: no daemon is running; the unlink is recorded and the chat will not be reconnected.');
  });
}

/** Ask the daemon; with none answering, act offline. A store lock held while no
 * daemon answers is a daemon starting (or another CLI writing): ask again. */
async function untilUnlocked(deps: WithdrawDeps, request: Record<string, unknown> & { verb: string },
  offline: () => Promise<void>, missing: (res: ResponseEnvelope) => boolean = () => false,
  nothing: (message: string) => void = () => {}): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + LOCKED_RETRY_MS;
  for (;;) {
    const res = await deps.control(request);
    if (!res.ok && missing(res)) {
      nothing(res.message);
      return 0;
    }
    if (res.ok || res.code !== 'DAEMON_UNAVAILABLE') return report(res, deps);
    try {
      await offline();
      return 0;
    } catch (err) {
      if (!(err instanceof SessionOwnedError)) {
        deps.err(`slipstream: ${(err as Error).message}`);
        return 1;
      }
    }
    if (now() >= deadline) {
      deps.err(`slipstream: the store ${deps.store} is locked by another process, but no daemon answers on its control `
        + 'socket. Nothing was changed; retry once that process exits.');
      return 1;
    }
    await sleep(LOCKED_POLL_MS);
  }
}

async function offlineTarget(target: string): Promise<{ sessionId: string } | { root: string }> {
  if (isValidSessionId(target)) return { sessionId: target };
  try { return { root: await realpath(target) }; } catch { return { root: target }; }
}

function report(res: ResponseEnvelope, deps: WithdrawDeps): number {
  if (!res.ok) {
    deps.err(`slipstream: ${res.code}: ${res.message}`);
    return 1;
  }
  for (const [key, value] of Object.entries(res)) {
    if (key !== 'v' && key !== 'ok') deps.out(`${key}: ${String(value)}`);
  }
  return 0;
}
