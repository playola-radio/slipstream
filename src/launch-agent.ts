/**
 * The managed install: a user LaunchAgent that restarts the daemon after a crash
 * or a login, plus a record of the absolute Node and `slipstream` entry paths it
 * and the Conductor scripts use. Nothing here sources nvm or depends on an
 * interactive shell; re-running the install after a Node or package upgrade
 * rewrites every recorded path together.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertOwnerOnly, mkdirpDurable } from './storage.ts';
import { acquireSessionLock, SessionOwnedError } from './lock.ts';

export const LAUNCH_AGENT_LABEL = 'radio.playola.slipstream';
/** git is on it, for the daemon's ignore-rule checks. */
export const DAEMON_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
const SHUTDOWN_WAIT_MS = 2_000;
const SHUTDOWN_POLL_MS = 50;

export type Run = (command: string, args: string[]) => Promise<{ code: number | null; output: string }>;

/** A repo whose Conductor scripts the install chains Slipstream into. */
export interface ManagedRepo {
  root: string;
  /** The repo's shared (`settings.toml` or `conductor.json`) commands as they
   * were when the install last chained them; a later change is drift. */
  setup: string | null;
  archive: string | null;
}

export interface ManagedInstall {
  version: 1;
  /** The `@playola-radio/slipstream` version the paths were recorded from. */
  package_version: string;
  node: string;
  cli: string;
  log: string;
  repos: ManagedRepo[];
}

export class InstallError extends Error {}

export interface EntryPaths { node: string; cli: string }

/** The running Node and `slipstream` entry, validated for recording. */
export async function entryPaths(execPath: string, nodeVersion: string, cliPath: string): Promise<EntryPaths> {
  const major = Number(nodeVersion.split('.')[0]);
  if (!isAbsolute(execPath)) throw new InstallError(`Node's path ${execPath} is not absolute`);
  if (!(major >= 24)) throw new InstallError(`Slipstream needs Node 24 or later; this is Node ${nodeVersion} at ${execPath}`);
  if (!isAbsolute(cliPath) || !(await stat(cliPath).catch(() => null))?.isFile()) {
    throw new InstallError(`the slipstream entry ${cliPath} is not a file`);
  }
  return { node: execPath, cli: cliPath };
}

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function daemonLogPath(home: string): string {
  return join(home, 'Library', 'Logs', 'slipstream', 'daemon.log');
}

export function manifestPath(store: string): string {
  return join(store, 'control', 'install.json');
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderPlist(o: { node: string; cli: string; store: string; log: string; home: string }): string {
  const args = [o.node, o.cli, 'start', '--store', o.store].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${DAEMON_PATH}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(o.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readManagedInstall(store: string): Promise<ManagedInstall | null> {
  let text: string;
  try { text = await readFile(manifestPath(store), 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as ManagedInstall;
  if (parsed?.version !== 1 || !Array.isArray(parsed.repos)) throw new InstallError(`${manifestPath(store)} is not a Slipstream install record`);
  return parsed;
}

export async function writeManagedInstall(store: string, install: ManagedInstall): Promise<void> {
  const control = dirname(manifestPath(store));
  await mkdirpDurable(control);
  await assertOwnerOnly(store, 'dir');
  await assertOwnerOnly(control, 'dir');
  await writeAtomic(manifestPath(store), JSON.stringify(install, null, 2) + '\n', 0o600);
}

export interface LaunchAgentResult { plist: string; log: string; reloaded: boolean }

/** Write the LaunchAgent for these paths and make sure launchd runs it. A plist
 * whose paths changed is reloaded, which restarts the daemon on the new ones;
 * an unchanged, loaded one is left alone unless `restart` asks for the daemon to
 * be restarted on new code at the same paths. */
export async function installLaunchAgent(o: EntryPaths & { home: string; store: string; uid: number; restart?: boolean },
  run: Run): Promise<LaunchAgentResult> {
  const plist = plistPath(o.home);
  const log = daemonLogPath(o.home);
  const text = renderPlist({ ...o, log });
  const current = await readFile(plist, 'utf8').catch(() => null);
  if (current !== null && current !== text) {
    const store = current.match(/<string>--store<\/string>\s*<string>([^<]+)<\/string>/)?.[1];
    if (store !== undefined && store !== xml(o.store)) {
      throw new InstallError('a managed Slipstream daemon already belongs to another store; stop and remove that install before choosing a different store');
    }
  }
  const domain = `gui/${o.uid}`;
  await mkdir(dirname(log), { recursive: true });
  if (current === text && (await run('launchctl', ['print', `${domain}/${LAUNCH_AGENT_LABEL}`])).code === 0) {
    if (!o.restart) return { plist, log, reloaded: false };
    const restarted = await run('launchctl', ['kickstart', '-k', `${domain}/${LAUNCH_AGENT_LABEL}`]);
    if (restarted.code !== 0) {
      throw new InstallError(`launchctl could not restart the daemon (exit ${restarted.code}): ${restarted.output.trim()}`);
    }
    return { plist, log, reloaded: true };
  }
  if (current !== text) await writeAtomic(plist, text, 0o644);
  await run('launchctl', ['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]);
  // launchd can stop only the process it owns. Prove no manual or legacy daemon
  // still owns this shared store before saying the managed one was installed.
  await mkdirpDurable(o.store);
  const shutdownDeadline = Date.now() + SHUTDOWN_WAIT_MS;
  for (;;) {
    try {
      const ownership = await acquireSessionLock(o.store);
      await ownership.release();
      break;
    } catch (err) {
      if (!(err instanceof SessionOwnedError)) throw err;
      if (Date.now() >= shutdownDeadline) {
        throw new InstallError(`another daemon still owns ${o.store}; stop it before installing the managed daemon`);
      }
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
  }
  // launchd finishes a bootout asynchronously; a bootstrap right behind it can
  // fail until the old instance is gone.
  let loaded = await run('launchctl', ['bootstrap', domain, plist]);
  for (let i = 0; loaded.code !== 0 && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    loaded = await run('launchctl', ['bootstrap', domain, plist]);
  }
  if (loaded.code !== 0) {
    throw new InstallError(`launchctl could not load ${plist} (exit ${loaded.code}): ${loaded.output.trim()}`);
  }
  return { plist, log, reloaded: true };
}

/** Ask launchd to start the managed daemon now. `exited` settles only when
 * launchd refuses, so a slow start is waited out rather than abandoned. */
export function kickstartLaunchAgent(uid: number, run: Run): { exited: Promise<number | null> } {
  return {
    exited: run('launchctl', ['kickstart', `gui/${uid}/${LAUNCH_AGENT_LABEL}`])
      .then((r) => r.code === 0 ? new Promise<never>(() => {}) : r.code),
  };
}
