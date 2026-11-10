import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OutcomeUnknownError } from './control-client.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { shellWord } from './shell-word.ts';
import { daemonLogPath, LAUNCH_AGENT_LABEL, plistPath, readManagedInstall, renderPlist } from './launch-agent.ts';
import { parseLock } from './lock.ts';

/**
 * Which Slipstream a CLI or daemon is. A CLI only talks to a daemon of exactly
 * its own build: an upgrade leaves the old daemon running, and its control verbs
 * differ in ways that surface as misleading errors rather than "out of date".
 *
 * `build` is a random id written next to the compiled modules at build time, so
 * two installs of the same version from different commits still differ. Running
 * from source, it is the checkout's commit; null when Git cannot say.
 */
export interface Build { version: string; build: string | null }

const SOURCE_BUILD = 'git-';

// Read once, as the process loads: an upgrade in place rewrites these files
// under a long-running process that still runs the old code.
const own = readBuild();

export function thisBuild(): Promise<Build> {
  return own;
}

async function readBuild(): Promise<Build> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const build = await readFile(new URL('./build-id', import.meta.url), 'utf8')
    .then((text) => text.trim() || null, () => sourceCommit());
  return { version: pkg.version, build };
}

function sourceCommit(): Promise<string | null> {
  return new Promise((resolve) => execFile('git', ['rev-parse', 'HEAD'],
    { cwd: dirname(fileURLToPath(import.meta.url)), timeout: 2000 },
    (error, stdout) => resolve(error || !stdout.trim() ? null : `${SOURCE_BUILD}${stdout.trim()}`)));
}

/** The CLI module beside this one, as a managed install records it. */
async function thisCliPath(): Promise<string> {
  return realpath(fileURLToPath(new URL(`./cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url)));
}

/** The status fields a daemon reports its build in. */
export function buildFields(own: Build): Record<string, unknown> {
  return { daemon_version: own.version, daemon_build: own.build };
}

/** The build a status reply reports; null for a daemon too old to report one. */
export function reportedBuild(status: Record<string, unknown>): Build | null {
  if (typeof status.daemon_version !== 'string') return null;
  return { version: status.daemon_version, build: typeof status.daemon_build === 'string' ? status.daemon_build : null };
}

export function sameBuild(daemon: Build | null, own: Build): boolean {
  return daemon !== null && daemon.version === own.version && daemon.build === own.build;
}

export type Send = (request: RequestEnvelope) => Promise<ResponseEnvelope>;

export type BuildCheck =
  | { kind: 'same' }
  | { kind: 'absent'; response: ResponseEnvelope }
  /** `daemon` is null when the daemon does not report a build: one older than this check. */
  | { kind: 'different'; daemon: Build | null }
  | { kind: 'unreadable'; message: string };

const NOT_READY_RETRIES = 20;
const NOT_READY_WAIT_MS = 100;

/** Asks the store's daemon which build it is. No daemon answering is `absent`. */
export async function checkDaemonBuild(send: Send, own: Build): Promise<BuildCheck> {
  for (let attempt = 0; ; attempt++) {
    let res: ResponseEnvelope;
    try { res = await send({ v: 1, verb: 'status' }); } catch (err) {
      if (!(err instanceof OutcomeUnknownError)) throw err;
      return { kind: 'unreadable', message: err.message };
    }
    if (res.ok) {
      const daemon = reportedBuild(res);
      return sameBuild(daemon, own) ? { kind: 'same' } : { kind: 'different', daemon };
    }
    if (res.code === 'DAEMON_UNAVAILABLE') return { kind: 'absent', response: res };
    if (res.code !== 'CAPTURE_NOT_READY' || attempt >= NOT_READY_RETRIES) return { kind: 'unreadable', message: `${res.code}: ${res.message}` };
    await new Promise((r) => setTimeout(r, NOT_READY_WAIT_MS));
  }
}

/** A build for people: the version, plus which build when `other` shares it. */
export function describeBuild(build: Build | null, other: Build | null): string {
  if (build === null) return 'an older version (it does not report one)';
  if (build.version !== other?.version || build.build === other.build) return build.version;
  if (build.build === null) return `${build.version} (run from source)`;
  if (build.build.startsWith(SOURCE_BUILD)) return `${build.version} (run from source at ${build.build.slice(SOURCE_BUILD.length, SOURCE_BUILD.length + 8)})`;
  return `${build.version} (build ${build.build.slice(0, 8)})`;
}

export function mismatchMessage(store: string, daemon: Build | null, own: Build, remedy: string): string {
  return `The Slipstream daemon running for ${store} is ${describeBuild(daemon, own)}; this CLI is ${describeBuild(own, daemon)}. ${remedy}`;
}

export function unreadableMessage(store: string, message: string): string {
  return `couldn't confirm the Slipstream daemon running for ${store} is this version (${message}); `
    + `run \`slipstream status --store ${shellWord(store)}\`.`;
}

export interface Remedy {
  /** What to tell the user to run. */
  text: string;
  /** Restarts the daemon in place on this build, when that keeps every recording. */
  restart?: { uid: number };
}

/**
 * How to get a daemon of this build. A managed daemon whose LaunchAgent plist is
 * exactly what this install writes restarts on the new code; launchd sends
 * SIGTERM, and a daemon that keeps capture intent (every managed one) resumes
 * its recordings with a marked gap. A detached daemon is never stopped for the
 * user: an older one may keep no intent, so stopping it would end its recordings.
 */
export async function remedyFor(store: string, daemon: Build | null, own: Build, home = homedir()): Promise<Remedy> {
  const managed = await readManagedInstall(store).catch(() => null);
  if (managed) {
    if (process.getuid && await runsThisCli(managed.node, store, home)) {
      const uid = process.getuid();
      return { text: `Restart it with \`launchctl kickstart -k gui/${uid}/${LAUNCH_AGENT_LABEL}\`.`, restart: { uid } };
    }
    return { text: `Restart it on this version with \`slipstream conductor install --store ${shellWord(store)}\`.` };
  }
  const pid = parseLock(await readFile(join(store, 'owner.lock'), 'utf8').catch(() => '')).pid;
  const stop = pid === undefined
    ? `Stop the \`slipstream start --store ${shellWord(store)}\` process`
    : `Stop it with \`kill ${pid}\``;
  const recordings = daemon === null
    ? 'The new daemon resumes recordings started on 0.3.0 or later with a marked gap; record folders an older daemon was recording again.'
    : 'The new daemon resumes its recordings with a marked gap.';
  return { text: `${stop}; the next \`slipstream attach\` or \`slipstream workspace create\` starts one on ${own.version}. ${recordings}` };
}

/** Whether the store's LaunchAgent plist is the one this CLI would install. */
async function runsThisCli(node: string, store: string, home: string): Promise<boolean> {
  const cli = await thisCliPath().catch(() => null);
  const plist = await readFile(plistPath(home), 'utf8').catch(() => null);
  return cli !== null && plist === renderPlist({ node, cli, store, log: daemonLogPath(home), home });
}

/**
 * Wraps a control sender so requests reach only a daemon of this exact build.
 * The build is checked once, before the first request; on a mismatch nothing is
 * sent and every request answers `DAEMON_VERSION_MISMATCH` with what to run. An
 * unavailable check is not cached, so a later retry checks again. That retry
 * still never sends its request until the daemon has answered with this build.
 */
export function versionGate(send: Send, store: string, own: Build): Send {
  let refusal: Promise<ResponseEnvelope | null> | undefined;
  return async (request) => {
    const current = refusal ??= checkDaemonBuild(send, own).then(async (check) => {
      if (check.kind === 'same') return null;
      if (check.kind === 'absent') return check.response;
      const message = check.kind === 'unreadable'
        ? unreadableMessage(store, check.message)
        : mismatchMessage(store, check.daemon, own, (await remedyFor(store, check.daemon, own)).text);
      return { v: 1, ok: false, code: 'DAEMON_VERSION_MISMATCH', message } as const;
    });
    const response = await current;
    if (!response) return send(request);
    if (response.code === 'DAEMON_UNAVAILABLE' && refusal === current) refusal = undefined;
    return response;
  };
}
