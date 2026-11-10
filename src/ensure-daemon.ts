import { unreadableMessage, type Build, type BuildCheck } from './daemon-version.ts';

/**
 * Make sure a daemon of this CLI's build serves a store, starting one if none
 * answers. Shared by chat attach, workspace create and the Conductor setup
 * script. A daemon of another build is restarted in place only when the install
 * can do that without losing a recording; otherwise it is refused before any
 * side effect, with what to run.
 */

export interface EnsureDaemonDeps {
  probe: () => Promise<'live' | 'stale' | 'ambiguous'>;
  /** Start a daemon for the store: a detached `slipstream start`, or the
   * LaunchAgent for a managed install. `exited` settles if the start is known
   * to have failed. */
  startDaemon: () => { exited: Promise<number | null> };
  /** Asks the answering daemon whether it is this CLI's build. */
  checkBuild: () => Promise<BuildCheck>;
  /** Describes a daemon of another build and what to run about it, with a
   * restart when the install can replace it in place. */
  mismatch: (daemon: Build | null) => Promise<{ message: string; restart?: () => { exited: Promise<number | null> } }>;
  /** Where a failed start leaves its diagnostics, when known. */
  logPath?: string;
  pollIntervalMs?: number;
}

export class DaemonUnavailableError extends Error {}

const DAEMON_START_MS = 10_000;

export async function ensureDaemon(store: string, deps: EnsureDaemonDeps): Promise<void> {
  const verdict = await deps.probe();
  if (verdict === 'ambiguous') {
    throw new DaemonUnavailableError(`the daemon for ${store} is not answering; run \`slipstream status --store ${store}\`. `
      + 'Nothing was recorded.');
  }
  if (verdict === 'stale' && !await comesUp(deps.startDaemon(), async () => await deps.probe() === 'live', deps)) {
    const why = deps.logPath ? `See ${deps.logPath} for why` : `Run \`slipstream start --store ${store}\` in a terminal to see why`;
    throw new DaemonUnavailableError(`the Slipstream daemon did not start. ${why}. Nothing was recorded.`);
  }
  const check = await deps.checkBuild();
  if (check.kind === 'same') return;
  if (check.kind !== 'different') {
    const why = check.kind === 'absent' ? 'it stopped answering' : check.message;
    throw new DaemonUnavailableError(`${unreadableMessage(store, why)} Nothing was recorded.`);
  }
  const { message, restart } = await deps.mismatch(check.daemon);
  if (!restart) throw new DaemonUnavailableError(`${message} Nothing was recorded.`);
  // Another setup may have replaced the daemon while the remedy was computed.
  if ((await deps.checkBuild()).kind === 'same') return;
  if (await comesUp(restart(), async () => (await deps.checkBuild()).kind === 'same', deps)) return;
  const see = deps.logPath ? `; see ${deps.logPath}` : '';
  throw new DaemonUnavailableError(`${message} Restarting it did not bring up this version${see}. Nothing was recorded.`);
}

/** Polls until `ready`, the start is known to have failed, or the deadline. */
async function comesUp(child: { exited: Promise<number | null> }, ready: () => Promise<boolean>,
  deps: EnsureDaemonDeps): Promise<boolean> {
  let exited = false;
  void child.exited.then(() => { exited = true; });
  const deadline = Date.now() + DAEMON_START_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, deps.pollIntervalMs ?? 100));
    if (await ready()) return true;
    if (exited) break;
  }
  return false;
}
