/**
 * Conductor integration: `slipstream conductor install | setup | archive | enroll`.
 *
 * Install chains `slipstream conductor setup` / `archive` into the personal
 * Conductor scripts (`~/.conductor/settings.toml`) and, for a repo that defines
 * its own scripts and so overrides the personal ones, into that repo's
 * `.conductor/settings.local.toml`, ahead of the repo's own command. Conductor's
 * documentation says setup runs after it creates a workspace and archive runs
 * before it archives one; it does not say whether the agent may start before
 * setup finishes, so capture can begin after an agent's first edits. The first
 * baseline is then the first state observed, never a claim of the original one.
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResponseEnvelope } from './control-protocol.ts';
import { shellWord } from './attach-workflow.ts';
import {
  SCRIPT_KINDS, SettingsError, readLegacyScripts, readTomlScripts, writeTomlScripts, type ScriptKind, type Scripts,
} from './conductor-settings.ts';
import {
  InstallError, entryPaths, installLaunchAgent, readManagedInstall, writeManagedInstall, type ManagedRepo, type Run,
} from './launch-agent.ts';

export interface ScriptPaths { node: string; cli: string; store: string }

export function slipstreamCommand(kind: ScriptKind, p: ScriptPaths): string {
  return [p.node, p.cli, 'conductor', kind, '--store', p.store].map(shellWord).join(' ');
}

/** Slipstream first; the existing command runs only once capture is ready (setup)
 * or withdrawn (archive). Braces keep a multi-command script grouped. */
export function chainScript(ours: string, own: string | null): string {
  return own === null || own.trim() === '' ? ours : `${ours} && {\n${own}\n}`;
}

const WORD = String.raw`(?:[\w@%+=:,./-]+|'[^']*'(?:\\''[^']*')*)`;
const CHAINED = new RegExp(String.raw`^${WORD} ${WORD} conductor (?:setup|archive) --store ${WORD}(?: && \{\n([\s\S]*)\n\})?$`);

/** The command a Slipstream chain runs after its own, or undefined when `value`
 * is not a Slipstream chain. */
export function chainedOwn(value: string): { own: string | null } | undefined {
  const m = CHAINED.exec(value);
  return m ? { own: m[1] ?? null } : undefined;
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function localSettingsPath(root: string): string {
  return join(root, '.conductor', 'settings.local.toml');
}

/** A repo's shared scripts: `settings.toml`, then legacy `conductor.json`, per key. */
export async function sharedScripts(root: string): Promise<Scripts> {
  const tomlPath = join(root, '.conductor', 'settings.toml');
  const jsonPath = join(root, 'conductor.json');
  const toml = await readText(tomlPath);
  const json = await readText(jsonPath);
  return { ...(json === null ? {} : readLegacyScripts(json, jsonPath)), ...(toml === null ? {} : readTomlScripts(toml, tomlPath)) };
}

/** Where the shared scripts no longer match what the install chained. */
export function driftOf(recorded: ManagedRepo, shared: Scripts): ScriptKind[] {
  return SCRIPT_KINDS.filter((k) => (shared[k] ?? null) !== recorded[k]);
}

// ---- install --------------------------------------------------------------

export interface InstallDeps {
  home: string;
  store: string;
  uid: number;
  execPath: string;
  nodeVersion: string;
  cliPath: string;
  packageVersion: string;
  run: Run;
  /** The root of every repo Conductor knows. */
  listRepos: () => Promise<string[]>;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Write { path: string; text: string }

export async function runConductorInstall(deps: InstallDeps): Promise<number> {
  try {
    return await install(deps);
  } catch (err) {
    if (!(err instanceof InstallError) && !(err instanceof SettingsError) && !(err instanceof InventoryError)) throw err;
    deps.err(`slipstream: ${err.message}`);
    return 1;
  }
}

async function install(deps: InstallDeps): Promise<number> {
  const paths = await entryPaths(deps.execPath, deps.nodeVersion, deps.cliPath);
  const ours = (kind: ScriptKind) => slipstreamCommand(kind, { ...paths, store: deps.store });
  const prior = await readManagedInstall(deps.store);
  const writes: Write[] = [];
  const notes: string[] = [];

  // Plan every edit before writing any, so a settings file Slipstream cannot
  // read leaves the machine as it was.
  const personalPath = join(deps.home, '.conductor', 'settings.toml');
  const personalText = (await readText(personalPath)) ?? '';
  const personal = readTomlScripts(personalText, personalPath);
  const personalNext: Scripts = {};
  for (const kind of SCRIPT_KINDS) {
    const current = personal[kind];
    const chain = current === undefined ? undefined : chainedOwn(current);
    const own = chain ? chain.own : current ?? null;
    personalNext[kind] = chainScript(ours(kind), own);
  }
  const personalOut = writeTomlScripts(personalText, personalNext, personalPath);
  if (personalOut !== personalText) writes.push({ path: personalPath, text: personalOut });

  const managedPath = join(deps.home, '.conductor', 'settings.managed.toml');
  const managedText = await readText(managedPath);
  if (managedText !== null && Object.keys(readTomlScripts(managedText, managedPath)).length > 0) {
    notes.push(`warning: ${managedPath} sets Conductor scripts, which override Slipstream's on this machine; `
      + 'workspaces will not be captured until those scripts run `slipstream conductor setup`.');
  }

  const repos: ManagedRepo[] = [];
  const chained: string[] = [];
  for (const root of [...new Set(await deps.listRepos())].sort()) {
    if (!(await stat(root).catch(() => null))?.isDirectory()) {
      notes.push(`skipped ${root}: Conductor lists it, but it is not a directory here.`);
      continue;
    }
    const shared = await sharedScripts(root);
    const localPath = localSettingsPath(root);
    const localText = await readText(localPath);
    const local = localText === null ? {} : readTomlScripts(localText, localPath);
    const before = prior?.repos.find((r) => r.root === root);
    const next: Scripts = {};
    for (const kind of SCRIPT_KINDS) {
      const value = local[kind];
      const ourChain = value === undefined ? undefined : chainedOwn(value);
      let own: string | null;
      if (ourChain) {
        // Follow a shared script that changed since the last install, unless the
        // chained command was edited by hand.
        own = before && ourChain.own === before[kind] ? shared[kind] ?? null : ourChain.own;
      } else if (value !== undefined) own = value;
      else if (shared[kind] !== undefined) own = shared[kind];
      else continue;
      next[kind] = chainScript(ours(kind), own);
    }
    if (Object.keys(next).length === 0) continue;
    const out = writeTomlScripts(localText ?? '', next, localPath);
    if (out !== localText) writes.push({ path: localPath, text: out });
    repos.push({ root, setup: shared.setup ?? null, archive: shared.archive ?? null });
    chained.push(localPath);
    const ignored = await deps.run('git', ['-C', root, 'check-ignore', '-q', join('.conductor', 'settings.local.toml')]);
    if (ignored.code === 1) {
      notes.push(`warning: ${localPath} is not ignored by git. It holds paths for this machine only; do not commit it.`);
    }
  }

  const upgraded = prior !== null && (prior.package_version !== deps.packageVersion || prior.node !== paths.node);
  const agent = await installLaunchAgent({ ...paths, home: deps.home, store: deps.store, uid: deps.uid, restart: upgraded }, deps.run);
  for (const w of writes) await writeAtomic(w.path, w.text);
  await writeManagedInstall(deps.store, { version: 1, package_version: deps.packageVersion, ...paths, log: agent.log, repos });

  deps.out(`LaunchAgent: ${agent.plist}${agent.reloaded ? ' (loaded; the daemon was started on these paths)' : ' (unchanged)'}`);
  deps.out(`Daemon log: ${agent.log}`);
  deps.out(`Node: ${paths.node}`);
  deps.out(`Slipstream: ${paths.cli} (${deps.packageVersion})`);
  deps.out(`Personal Conductor scripts: ${personalPath}`);
  for (const path of chained) deps.out(`Repo override: ${path}`);
  for (const note of notes) deps.out(note);
  deps.out('Conductor runs setup after it creates a workspace. Its documentation does not say whether the agent can '
    + 'start before setup finishes, so a capture may begin after the agent\'s first edits; Slipstream then records '
    + 'the first state it sees as the baseline.');
  deps.out('Run `slipstream conductor enroll` to capture workspaces that already exist. '
    + 'Run this install again after upgrading Node or Slipstream.');
  return 0;
}

// ---- setup / archive ------------------------------------------------------

export interface SetupDeps {
  env: Record<string, string | undefined>;
  store: string;
  packageVersion: string;
  ensureDaemon: () => Promise<void>;
  /** A waiting watch-only attach: 0 recording, 1 not recording, 3 still pending. */
  attach: (dir: string) => Promise<number>;
  err: (line: string) => void;
}

export async function runConductorSetup(deps: SetupDeps): Promise<number> {
  const dir = deps.env.CONDUCTOR_WORKSPACE_PATH;
  if (!dir) {
    deps.err('slipstream: CONDUCTOR_WORKSPACE_PATH is not set; `slipstream conductor setup` runs as a Conductor setup script.');
    return 2;
  }
  await warnOfDrift(deps);
  try {
    await deps.ensureDaemon();
  } catch (err) {
    deps.err(`slipstream: ${(err as Error).message}`);
    deps.err(`slipstream: ${dir} is NOT recording.`);
    return 1;
  }
  return deps.attach(dir);
}

async function warnOfDrift(deps: SetupDeps): Promise<void> {
  let install;
  try { install = await readManagedInstall(deps.store); } catch (err) {
    deps.err(`slipstream: warning: ${(err as Error).message}`);
    return;
  }
  if (!install) return;
  if (install.package_version !== deps.packageVersion) {
    deps.err(`slipstream: warning: the install was recorded by Slipstream ${install.package_version}, but this is `
      + `${deps.packageVersion}. Run \`slipstream conductor install\` to refresh the daemon and scripts.`);
  }
  const root = deps.env.CONDUCTOR_ROOT_PATH;
  const recorded = root ? install.repos.find((r) => r.root === root) : undefined;
  if (!recorded) return;
  let shared: Scripts;
  try { shared = await sharedScripts(recorded.root); } catch (err) {
    deps.err(`slipstream: warning: ${(err as Error).message}`);
    return;
  }
  for (const kind of driftOf(recorded, shared)) {
    deps.err(`slipstream: warning: this repo's own ${kind} script changed since \`slipstream conductor install\` chained it; `
      + `${localSettingsPath(recorded.root)} still runs the old one. Run \`slipstream conductor install\` to update it.`);
  }
}

export async function runConductorArchive(deps: {
  env: Record<string, string | undefined>;
  withdraw: (target: string) => Promise<number>;
  err: (line: string) => void;
}): Promise<number> {
  const dir = deps.env.CONDUCTOR_WORKSPACE_PATH;
  if (!dir) {
    deps.err('slipstream: CONDUCTOR_WORKSPACE_PATH is not set; `slipstream conductor archive` runs as a Conductor archive script.');
    return 2;
  }
  return deps.withdraw(dir);
}

// ---- enroll ---------------------------------------------------------------

export interface Inventory {
  /** Non-archived workspace paths, in admission order. */
  workspaces: string[];
  /** Whether the order is Conductor's last-activity time; otherwise inventory order. */
  byActivity: boolean;
}

export class InventoryError extends Error {}

type Row = Record<string, unknown>;

/** Conductor's own record of its workspaces and repos, opened read-only. Its
 * columns are checked, not assumed: a schema this does not recognize fails. */
export async function readConductorInventory(dbPath: string): Promise<Inventory & { repos: string[] }> {
  if (!(await stat(dbPath).catch(() => null))?.isFile()) throw new InventoryError(`Conductor's database ${dbPath} was not found`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
    const ws = columns('workspaces');
    const repos = columns('repos');
    const missing = [...['state', 'workspace_path'].filter((c) => !ws.has(c)).map((c) => `workspaces.${c}`),
      ...(repos.has('root_path') ? [] : ['repos.root_path'])];
    if (missing.length > 0) {
      throw new InventoryError(`Conductor's database ${dbPath} has no ${missing.join(', ')}; this Conductor version is not one `
        + 'Slipstream can read. Nothing was enrolled.');
    }
    const byActivity = ws.has('last_activity_at');
    const order = byActivity ? 'last_activity_at IS NULL, last_activity_at DESC, rowid' : 'rowid';
    const workspaces = (db.prepare(`SELECT workspace_path FROM workspaces WHERE state != 'archived' AND workspace_path IS NOT NULL `
      + `AND workspace_path != '' ORDER BY ${order}`).all() as Row[]).map((r) => String(r.workspace_path));
    const roots = (db.prepare(`SELECT root_path FROM repos WHERE root_path IS NOT NULL AND root_path != ''`).all() as Row[])
      .map((r) => String(r.root_path));
    return { workspaces, byActivity, repos: roots };
  } finally { db.close(); }
}

export interface EnrollDeps {
  ensureDaemon: () => Promise<void>;
  control: (request: Record<string, unknown> & { verb: string }) => Promise<ResponseEnvelope>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Ask for a watch-only capture of every workspace, in order. A workspace that
 * already has one keeps it, and its place if it is waiting. */
export async function runConductorEnroll(inventory: Inventory, deps: EnrollDeps): Promise<number> {
  try {
    await deps.ensureDaemon();
  } catch (err) {
    deps.err(`slipstream: ${(err as Error).message}`);
    return 1;
  }
  deps.out(`Enrolling ${inventory.workspaces.length} Conductor workspace(s), ${inventory.byActivity
    ? 'most recently active first (Conductor\'s last activity time)'
    : 'in Conductor\'s inventory order (it records no activity time)'}.`);
  let recording = 0;
  let starting = 0;
  let waiting = 0;
  let failed = 0;
  for (const dir of inventory.workspaces) {
    const res = await deps.control({ verb: 'attach', mode: 'watch-only', worktree: dir });
    if (!res.ok && res.code === 'CAPTURE_LIMIT_REACHED') {
      waiting++;
      deps.out(`${dir}: waiting for a capture slot (NOT recording)`);
    } else if (!res.ok) {
      failed++;
      deps.err(`slipstream: ${dir}: NOT recording (${res.code}: ${res.message})`);
    } else if (res.state === 'recording') {
      recording++;
      deps.out(`${dir}: recording`);
    } else if (res.state === 'queued' || res.state === 'baselining') {
      starting++;
      deps.out(`${dir}: starting (${String(res.state)})`);
    } else {
      failed++;
      deps.err(`slipstream: ${dir}: NOT recording (${String(res.reason ?? res.state)}${res.message ? `: ${String(res.message)}` : ''})`);
    }
  }
  deps.out(`${recording} recording, ${starting} starting, ${waiting} waiting, ${failed} not recording.`);
  if (waiting > 0) {
    deps.out('Waiting workspaces start automatically, in this order, as capture slots free up. '
      + 'Archive workspaces you no longer use in Conductor to free slots.');
  }
  return failed > 0 ? 1 : 0;
}
