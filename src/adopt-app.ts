/**
 * `slipstream adopt-app`: the Slipstream app runs this after it installs or
 * switches its runtime. Hooks and answer tools that `attach` wrote with a Node
 * and a package path (an nvm install, say) move onto the app's stable shims, so
 * the next update keeps them working. Only entries for this store change, and
 * each changed file is copied beside itself first.
 */
import { randomUUID } from 'node:crypto';
import { chmod, constants, copyFile, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appRuntime } from './app-runtime.ts';
import { codexServerBlock, hookCommand } from './attach-workflow.ts';
import { intentPath, loadIntent } from './intent-store.ts';
import { shellWord } from './shell-word.ts';

export interface AdoptDeps {
  env: Record<string, string | undefined>;
  home: string;
  store: string;
  run: (command: string, args: string[], cwd: string) => Promise<{ code: number | null; output: string }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The file's new text, or null when it holds nothing of this store's to move. */
type Rewrite = (text: string) => string | null;

const WORD = String.raw`(?:'(?:[^']|'\\'')*'|[\w@%+=:,./-]+)`;
const NPM_HOOK = new RegExp(`^${WORD} (${WORD}) hook (claude-code|codex) post-tool-use --store (${WORD})$`);

export async function runAdoptApp(deps: AdoptDeps): Promise<number> {
  const runtime = appRuntime(deps.env);
  if (!runtime) {
    deps.err('slipstream: adopt-app runs from the Slipstream app, which sets SLIPSTREAM_APP_RUNTIME; it is not set here.');
    return 2;
  }
  const { store } = deps;
  const mcpArgs = ['--store', store];
  let failed = false;
  const fail = (path: string, message: string) => {
    failed = true;
    deps.out(`failed ${path}: ${message}`);
  };

  let roots: string[] = [];
  try { roots = [...new Set((await loadIntent(store)).captures.map((c) => c.root))]; }
  catch (err) { fail(intentPath(store), (err as Error).message); }

  const seen = new Set<string>();
  const adopt = async (path: string, rewrite: Rewrite) => {
    try {
      const real = await existing(path);
      if (real === null || seen.has(real)) return;
      seen.add(real);
      const text = await readFile(real, 'utf8');
      const next = rewrite(text);
      if (next === null) {
        deps.out(`unchanged ${path}`);
        return;
      }
      const backup = await backUp(path);
      await replaceFile(real, text, next);
      deps.out(`rewrote ${path} (backup ${backup})`);
    } catch (err) {
      fail(path, (err as Error).message);
    }
  };
  const hooks: Rewrite = (text) => rewriteHooks(text, store, (harness) =>
    hookCommand({ command: runtime.cli, args: [] }, harness, store));
  const codexTool: Rewrite = (text) => rewriteCodexTool(text, store, runtime.mcp, mcpArgs);

  for (const root of roots) {
    await adopt(join(root, '.claude', 'settings.local.json'), hooks);
    await adopt(join(root, '.codex', 'hooks.json'), hooks);
    await adopt(join(root, '.codex', 'config.toml'), codexTool);
  }
  await adopt(join(deps.env.CODEX_HOME ?? join(deps.home, '.codex'), 'config.toml'), codexTool);
  if (!await adoptClaudeTool(deps, roots, [runtime.mcp, ...mcpArgs])) failed = true;
  return failed ? 1 : 0;
}

async function existing(path: string): Promise<string | null> {
  try { return await realpath(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isNpmForwarder(args: unknown, store: string): boolean {
  return Array.isArray(args) && args.length === 3 && typeof args[0] === 'string'
    && args[0].endsWith('/dist/mcp-forwarder.js') && args[1] === '--store' && args[2] === store;
}

function rewriteHooks(text: string, store: string, shimHook: (harness: 'claude-code' | 'codex') => string): string | null {
  const config = JSON.parse(text) as { hooks?: { PostToolUse?: unknown } };
  const post = config?.hooks?.PostToolUse;
  if (!Array.isArray(post)) return null;
  const moved = new Map<string, string>();
  for (const group of post) {
    const entries = (group as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(entries)) continue;
    for (const hook of entries as ({ command?: unknown } | null)[]) {
      if (typeof hook?.command !== 'string') continue;
      const m = NPM_HOOK.exec(hook.command);
      if (!m || !/\/dist\/cli\.js'?$/.test(m[1]!) || m[3] !== shellWord(store)) continue;
      const next = shimHook(m[2] as 'claude-code' | 'codex');
      moved.set(hook.command, next);
      hook.command = next;
    }
  }
  if (moved.size === 0) return null;
  // Swap only the command strings so the rest of the file keeps its bytes.
  let next = text;
  for (const [from, to] of moved) next = next.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return isDeepStrictEqual(JSON.parse(next), config) ? next : `${JSON.stringify(config, null, 2)}\n`;
}

/** Only the `command` and `args` lines of Slipstream's server table change. */
function rewriteCodexTool(text: string, store: string, command: string, args: string[]): string | null {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.trim() === '[mcp_servers.slipstream]');
  if (header < 0) return null;
  let end = lines.findIndex((l, i) => i > header && l.trim().startsWith('['));
  if (end < 0) end = lines.length;
  const keyAt = (key: string) => lines.findIndex((l, i) => i > header && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  const commandAt = keyAt('command');
  const argsAt = keyAt('args');
  if (commandAt < 0 || argsAt < 0) return null;
  let current: unknown;
  try { current = JSON.parse(lines[argsAt]!.slice(lines[argsAt]!.indexOf('=') + 1)); } catch { return null; }
  if (!isNpmForwarder(current, store)) return null;
  const [, commandLine, argsLine] = codexServerBlock(command, args).split('\n');
  lines[commandAt] = commandLine!;
  lines[argsAt] = argsLine!;
  return lines.join('\n');
}

/** Claude keeps its servers in its own config; `claude mcp` rewrites them. The
 * scopes are the ones attach checks: each recorded root's local scope, and the user's. */
async function adoptClaudeTool(deps: AdoptDeps, roots: string[], shim: string[]): Promise<boolean> {
  const path = join(deps.env.CLAUDE_CONFIG_DIR ?? deps.home, '.claude.json');
  type Servers = { mcpServers?: Record<string, { args?: unknown } | null> };
  let config: Servers & { projects?: Record<string, Servers> };
  try {
    const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (text === null) return true;
    config = JSON.parse(text) as typeof config;
  } catch (err) {
    deps.out(`failed ${path}: ${(err as Error).message}`);
    return false;
  }
  const scopes = [
    ...roots.filter((root) => isNpmForwarder(config.projects?.[root]?.mcpServers?.slipstream?.args, deps.store))
      .map((root) => ({ scope: 'local', cwd: root })),
    ...isNpmForwarder(config.mcpServers?.slipstream?.args, deps.store) ? [{ scope: 'user', cwd: deps.home }] : [],
  ];
  if (scopes.length === 0) {
    deps.out(`unchanged ${path}`);
    return true;
  }
  let backup: string;
  try { backup = await backUp(path); } catch (err) {
    deps.out(`failed ${path}: ${(err as Error).message}`);
    return false;
  }
  const claude = deps.env.CLAUDE_CODE_EXECPATH ?? 'claude';
  let ok = true;
  let rewrote = false;
  for (const { scope, cwd } of scopes) {
    for (const args of [['mcp', 'remove', '--scope', scope, 'slipstream'],
      ['mcp', 'add', '--scope', scope, 'slipstream', '--', ...shim]]) {
      const { code, output } = await deps.run(claude, args, cwd);
      if (code !== 0) {
        deps.out(`failed ${path}: \`claude ${args.slice(0, 5).join(' ')}\` in ${cwd} exited ${String(code)}: ${output.trim()}`);
        ok = false;
        break;
      }
      if (args[1] === 'add') rewrote = true;
    }
  }
  if (rewrote) deps.out(`rewrote ${path} (backup ${backup})`);
  return ok;
}

async function backUp(path: string): Promise<string> {
  const backup = `${path}.slipstream-backup-${Date.now()}`;
  await copyFile(path, backup, constants.COPYFILE_EXCL);
  return backup;
}

async function replaceFile(path: string, original: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx' });
    await chmod(tmp, (await stat(path)).mode & 0o777);
    if (await readFile(path, 'utf8') !== original) {
      throw new Error('it changed while adopt-app was running and was kept; run adopt-app again');
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
