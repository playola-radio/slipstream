/**
 * Make sure a daemon serves a store, starting one if none answers. Shared by
 * chat attach and the Conductor setup script. A live daemon is always kept,
 * whatever configuration it was started with.
 */

export interface EnsureDaemonDeps {
  probe: () => Promise<'live' | 'stale' | 'ambiguous'>;
  /** Start a daemon for the store: a detached `slipstream start`, or the
   * LaunchAgent for a managed install. `exited` settles if the start is known
   * to have failed. */
  startDaemon: () => { exited: Promise<number | null> };
  /** Where a failed start leaves its diagnostics, when known. */
  logPath?: string;
  pollIntervalMs?: number;
}

export class DaemonUnavailableError extends Error {}

const DAEMON_START_MS = 10_000;

export async function ensureDaemon(store: string, deps: EnsureDaemonDeps): Promise<void> {
  const verdict = await deps.probe();
  if (verdict === 'live') return;
  if (verdict === 'ambiguous') {
    throw new DaemonUnavailableError(`the daemon for ${store} is not answering; run \`slipstream status --store ${store}\`. `
      + 'Nothing was recorded.');
  }
  const child = deps.startDaemon();
  let exited: number | null | undefined;
  void child.exited.then((code) => { exited = code; });
  const deadline = Date.now() + DAEMON_START_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, deps.pollIntervalMs ?? 100));
    if (await deps.probe() === 'live') return;
    if (exited !== undefined) break;
  }
  const why = deps.logPath ? `See ${deps.logPath} for why` : `Run \`slipstream start --store ${store}\` in a terminal to see why`;
  throw new DaemonUnavailableError(`the Slipstream daemon did not start. ${why}. Nothing was recorded.`);
}
