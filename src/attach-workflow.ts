/**
 * `slipstream attach` with no identity flags: connect the agent chat this
 * command runs inside. It finds the chat from the harness's own environment,
 * starts the shared daemon if needed, installs the question hook and answer
 * tool for that harness in this workspace, and attaches with the chat's root
 * transcript. Success needs both recording and a connected chat; anything less
 * is reported as pending or refused, never as attached.
 */
import { readdir, readFile, writeFile, rename, mkdir, lstat, realpath, appendFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyClaudeRootTranscript } from './claude-root-transcript.ts';
import { verifyCodexRootTranscript } from './codex-root-transcript.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import { defaultDaemonStore } from './daemon-location.ts';

type Harness = 'claude-code' | 'codex';

export interface AttachDeps {
  env: Record<string, string | undefined>;
  home: string;
  nodePath: string;
  /** The real path of the running `slipstream` entry; the answer tool is its sibling. */
  cliPath: string;
  out: (line: string) => void;
  err: (line: string) => void;
  probe: () => Promise<'live' | 'stale' | 'ambiguous'>;
  startDaemon: () => { exited: Promise<number | null> };
  control: (request: Record<string, unknown> & { verb: string }) => Promise<ResponseEnvelope>;
  run: (command: string, args: string[], cwd: string) => Promise<{ code: number | null; output: string }>;
  pollIntervalMs?: number;
}

interface Chat { harness: Harness; id: string; conductor: boolean }

class Refusal extends Error {}

const execFileAsync = promisify(execFile);
const DAEMON_START_MS = 10_000;
const HOOK_TIMEOUT_S = 3;

export async function runAttachWorkflow(opts: { dir: string; store: string }, deps: AttachDeps): Promise<number> {
  try {
    return await attachThisChat(opts, deps);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    deps.err(`slipstream: ${err.message}`);
    return 1;
  }
}

async function attachThisChat(opts: { dir: string; store: string }, deps: AttachDeps): Promise<number> {
  const chat = detectChat(deps.env);
  let worktree: string;
  try { worktree = await realpath(opts.dir); }
  catch { throw new Refusal(`${opts.dir} does not exist; nothing was recorded`); }
  const transcript = await findTranscript(chat, deps);
  await verifyTranscript(chat, transcript, worktree);

  await ensureDaemon(opts.store, deps);
  const status = await deps.control({ verb: 'status' });
  if (!status.ok) throw new Refusal(`${status.code}: ${status.message}`);
  refuseOtherBinding(status, chat, worktree);

  const changed = await installAgentConfig(chat, worktree, opts.store, deps);

  const res = await deps.control({ verb: 'attach', worktree, harness: chat.harness, harness_session_id: chat.id,
    root_transcript: transcript });
  if (!res.ok) throw new Refusal(`${res.code}: ${res.message}`);
  const connection = String(res.agent_connection);
  const again = res.already_active === true;
  if (connection === 'connected') {
    deps.out(again
      ? `Attached successfully: already recording ${worktree} with this chat, agent connected; nothing changed.`
      : `Attached successfully: recording ${worktree}, agent connected.`);
  } else {
    deps.out(`${again ? 'Already recording' : 'Recording'} ${worktree}; agent setup pending.`);
    deps.out(pendingStep(chat, worktree, changed, storeFlag(opts.store, deps.home)));
  }
  deps.out(`session_id: ${String(res.session_id)}`);
  deps.out(`agent_connection: ${connection}`);
  return 0;
}

function detectChat(env: Record<string, string | undefined>): Chat {
  const claude = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID;
  if (claude && codex) {
    throw new Refusal('this environment has both a Claude Code and a Codex chat; cannot tell which one to connect. '
      + 'Nothing was recorded.');
  }
  if (!claude && !codex) {
    throw new Refusal('no Claude Code or Codex chat detected. Run `slipstream attach` from inside the agent chat '
      + 'you want to connect (for example, ask the agent to run it). Nothing was recorded.');
  }
  return { harness: claude ? 'claude-code' : 'codex', id: (claude ?? codex)!, conductor: !!env.CONDUCTOR_SESSION_ID };
}

async function findTranscript(chat: Chat, deps: AttachDeps): Promise<string> {
  const found = chat.harness === 'claude-code'
    ? await claudeTranscripts(join(deps.env.CLAUDE_CONFIG_DIR ?? join(deps.home, '.claude'), 'projects'), `${chat.id}.jsonl`)
    : await codexTranscripts(join(deps.env.CODEX_HOME ?? join(deps.home, '.codex'), 'sessions'), `-${chat.id}.jsonl`);
  if (found.length === 1) return found[0]!;
  throw new Refusal(found.length === 0
    ? `could not find this chat's transcript (${chat.harness} ${chat.id}); Slipstream needs it to confirm the chat. `
      + 'Nothing was recorded.'
    : `found ${found.length} transcripts for this chat (${chat.harness} ${chat.id}); cannot tell which is the root. `
      + 'Nothing was recorded.');
}

async function claudeTranscripts(projects: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of await listDir(projects)) {
    const path = join(projects, dir, name);
    if (await isFile(path)) found.push(path);
  }
  return found;
}

/** Codex keeps rollouts under sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl. */
async function codexTranscripts(sessions: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const year of await listDir(sessions)) {
    for (const month of await listDir(join(sessions, year))) {
      for (const day of await listDir(join(sessions, year, month))) {
        for (const file of await listDir(join(sessions, year, month, day))) {
          const path = join(sessions, year, month, day, file);
          if (file.startsWith('rollout-') && file.endsWith(suffix) && await isFile(path)) found.push(path);
        }
      }
    }
  }
  return found;
}

async function listDir(path: string): Promise<string[]> {
  try { return await readdir(path); } catch { return []; }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function verifyTranscript(chat: Chat, transcript: string, worktree: string): Promise<void> {
  const unverified = (what: string) => new Refusal(`this ${what} is not a runtime Slipstream has verified, or its `
    + `transcript does not match ${worktree}. Questions could not be delivered reliably, so nothing was installed `
    + 'or recorded.');
  if (chat.harness === 'codex') {
    if (!await verifyCodexRootTranscript(transcript, chat.id, worktree)) {
      throw unverified('Codex chat\'s version or launch mode (such as `codex exec`)');
    }
    return;
  }
  const result = await verifyClaudeRootTranscript(transcript, chat.id, worktree);
  if (result.ok) return;
  if (result.reason === 'not-yet') {
    throw new Refusal('this chat\'s transcript is still being written; run `slipstream attach` again after the next '
      + 'tool call. Nothing was recorded.');
  }
  if (result.reason === 'gap') {
    throw new Refusal('this chat\'s opening transcript is too large to verify; attach early in a new chat. '
      + 'Nothing was recorded.');
  }
  if (result.reason === 'unsupported-version') throw unverified('Claude Code version');
  throw new Refusal(`this chat's transcript does not match ${worktree}: the chat may have been started in another `
    + 'directory, or launched in a way Slipstream has not verified (such as an interactive `claude` session in a '
    + 'terminal). Questions could not be delivered reliably, so nothing was installed or recorded.');
}

async function ensureDaemon(store: string, deps: AttachDeps): Promise<void> {
  const verdict = await deps.probe();
  if (verdict === 'live') return;
  if (verdict === 'ambiguous') {
    throw new Refusal(`the daemon for ${store} is not answering; run \`slipstream status --store ${store}\`. `
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
  throw new Refusal(`the Slipstream daemon did not start. Run \`slipstream start --store ${store}\` in a terminal `
    + 'to see why. Nothing was recorded.');
}

function refuseOtherBinding(status: Record<string, unknown>, chat: Chat, worktree: string): void {
  if (status.state !== 'active') return;
  if (status.worktree !== worktree) {
    throw new Refusal(`another workspace, ${String(status.worktree)} is being recorded. Detach it there first `
      + '(`slipstream detach`); nothing was changed.');
  }
  if (status.harness !== chat.harness || status.harness_session_id !== chat.id) {
    throw new Refusal(`this workspace is already recorded with another agent chat (${String(status.harness)} `
      + `${String(status.harness_session_id)}); that binding was kept. Run \`slipstream detach\` first to switch chats.`);
  }
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Install only the selected harness's hook and answer tool. Unrelated entries
 * are kept, an identical entry is left alone, and a different Slipstream entry
 * is refused rather than replaced. Returns whether anything was written. */
async function installAgentConfig(chat: Chat, worktree: string, store: string, deps: AttachDeps): Promise<boolean> {
  const forwarder = join(dirname(deps.cliPath), `mcp-forwarder${extname(deps.cliPath)}`);
  if (!await isFile(forwarder)) {
    throw new Refusal(`the Slipstream answer tool is missing next to ${deps.cliPath}; reinstall Slipstream. `
      + 'Nothing was recorded.');
  }
  const hook = [deps.nodePath, deps.cliPath, 'hook', chat.harness, 'post-tool-use', '--store', store]
    .map(shellWord).join(' ');
  const hookFile = chat.harness === 'claude-code' ? '.claude/settings.local.json' : '.codex/hooks.json';
  const hookEdit = await planHook(join(worktree, hookFile), hook);
  const toolArgs = [forwarder, '--store', store];
  let toolEdit: Edit | null;
  let addClaudeTool = false;
  if (chat.harness === 'codex') {
    toolEdit = await planCodexTool(join(worktree, '.codex', 'config.toml'), deps.nodePath, toolArgs);
  } else {
    toolEdit = null;
    addClaudeTool = await claudeToolMissing(chat, worktree, deps, toolArgs);
  }

  const created: string[] = [];
  for (const edit of [hookEdit, toolEdit]) {
    if (!edit) continue;
    await writeOrRefuse(edit.path, () => writeAtomic(edit.path, edit.text));
    if (edit.created) created.push(edit.path);
    deps.out(`Installed the Slipstream ${edit === hookEdit ? 'question hook' : 'answer tool'} in ${edit.path}`);
  }
  if (addClaudeTool) {
    const claude = deps.env.CLAUDE_CODE_EXECPATH ?? 'claude';
    const { code, output } = await deps.run(claude,
      ['mcp', 'add', '--scope', 'local', 'slipstream', '--', deps.nodePath, ...toolArgs], worktree);
    if (code !== 0) {
      throw new Refusal(`could not add the Slipstream answer tool with \`claude mcp add\` (exit ${String(code)}): `
        + `${output.trim()}. Nothing was recorded.`);
    }
    deps.out('Installed the Slipstream answer tool for this workspace (claude mcp add --scope local).');
  }
  await excludeFromGit(worktree, created);
  return hookEdit !== null || toolEdit !== null || addClaudeTool;
}

interface Edit { path: string; text: string; created: boolean }

async function readConfig(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Refusal(`cannot read ${path}: ${(err as Error).message}. Nothing was recorded.`);
  }
}

const SLIPSTREAM_HOOK = /\bhook (?:claude-code|codex) post-tool-use\b/;

async function planHook(path: string, command: string): Promise<Edit | null> {
  const text = await readConfig(path);
  let config: Record<string, unknown> = {};
  if (text !== null) {
    try { config = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Refusal(`${path} is not valid JSON; fix it and run attach again. Nothing was changed.`); }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Refusal(`${path} is not a JSON object; fix it and run attach again. Nothing was changed.`);
    }
  }
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  const post = (hooks.PostToolUse ?? []) as unknown;
  if (typeof hooks !== 'object' || Array.isArray(hooks) || !Array.isArray(post)) {
    throw new Refusal(`${path} has an unexpected hooks layout; add the Slipstream hook by hand: ${command}`);
  }
  const existing = post.flatMap((group) => Array.isArray((group as { hooks?: unknown })?.hooks)
    ? (group as { hooks: unknown[] }).hooks : [])
    .map((h) => (h as { command?: unknown })?.command)
    .filter((c): c is string => typeof c === 'string' && SLIPSTREAM_HOOK.test(c));
  if (existing.includes(command)) return null;
  if (existing.length > 0) {
    throw new Refusal(`${path} already has a different Slipstream hook (${existing[0]}). It was kept; remove it or `
      + `attach with the store it uses. Nothing was recorded.`);
  }
  const next = { ...config, hooks: { ...hooks, PostToolUse: [...post,
    { matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] } };
  return { path, text: `${JSON.stringify(next, null, 2)}\n`, created: text === null };
}

/** Codex project config is TOML; Slipstream owns only its own server table and
 * appends it as text so the rest of the file stays byte-for-byte unchanged. */
async function planCodexTool(path: string, node: string, args: string[]): Promise<Edit | null> {
  const text = await readConfig(path);
  const block = `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(node)}\n`
    + `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  if (text === null) return { path, text: block, created: true };
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.trim() === '[mcp_servers.slipstream]');
  if (header >= 0) {
    let end = lines.findIndex((l, i) => i > header && l.trim().startsWith('['));
    if (end < 0) end = lines.length;
    const current = lines.slice(header, end).filter((l) => l.trim() !== '').join('\n');
    if (current === block.trimEnd()) return null;
    throw new Refusal(`${path} already has a different Slipstream server entry. It was kept; remove it or make it `
      + `match:\n${block}Nothing was recorded.`);
  }
  if (/^\s*\[mcp_servers\]\s*$/m.test(text) || /^\s*mcp_servers\s*=/m.test(text)
    || /^\s*\[mcp_servers\.["']?slipstream["']?[.\]]/m.test(text)) {
    throw new Refusal(`${path} declares MCP servers in a form attach cannot safely edit. Add this entry by hand:\n`
      + `${block}Nothing was recorded.`);
  }
  const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { path, text: `${text}${sep}${block}`, created: false };
}

/** Claude keeps local-scope servers per project in its own global config; read
 * it to stay idempotent, but leave writing to `claude mcp add`. */
async function claudeToolMissing(chat: Chat, worktree: string, deps: AttachDeps, args: string[]): Promise<boolean> {
  const configDir = deps.env.CLAUDE_CONFIG_DIR;
  const path = configDir ? join(configDir, '.claude.json') : join(deps.home, '.claude.json');
  const text = await readConfig(path);
  if (text === null) return true;
  let server: { command?: unknown; args?: unknown } | undefined;
  try {
    const config = JSON.parse(text) as { projects?: Record<string, { mcpServers?: Record<string, typeof server> }> };
    server = config.projects?.[worktree]?.mcpServers?.slipstream;
  } catch { throw new Refusal(`${path} is not valid JSON; cannot check for an existing Slipstream answer tool.`); }
  if (server === undefined) return true;
  if (server.command === deps.nodePath && JSON.stringify(server.args) === JSON.stringify(args)) return false;
  throw new Refusal(`this workspace already has a different \`slipstream\` MCP server for ${chat.harness} `
    + '(see `claude mcp get slipstream`). It was kept; remove it with `claude mcp remove --scope local slipstream` '
    + 'or make it use this store. Nothing was recorded.');
}

/** A sandboxed chat may not be allowed to write workspace config (Codex keeps
 * `.codex/` and `.git/` read-only in workspace-write mode); say so, not crash. */
async function writeOrRefuse(path: string, write: () => Promise<void>): Promise<void> {
  try { await write(); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new Refusal(`could not write ${path} (${code}). This chat's sandbox may block writing there; allow the `
      + 'command to run with write access to the workspace, or start the chat with full access, then run attach '
      + 'again. Nothing was recorded.');
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { flag: 'wx' });
  await rename(tmp, path);
}

/** Keep generated per-workspace config out of `git status`. Only files attach
 * created are excluded, so a user's own untracked config is never hidden. */
async function excludeFromGit(worktree: string, created: string[]): Promise<void> {
  if (created.length === 0) return;
  let gitPath: string;
  try { gitPath = (await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree })).stdout; }
  catch { return; } // not a git worktree: nothing to keep out of git status
  const exclude = resolve(worktree, gitPath.trim());
  const current = (await readConfig(exclude)) ?? '';
  const have = new Set(current.split('\n'));
  const add = created.map((p) => `/${relative(worktree, p)}`).filter((line) => !have.has(line));
  if (add.length === 0) return;
  await writeOrRefuse(exclude, async () => {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`);
  });
}

function storeFlag(store: string, home: string): string {
  return store === defaultDaemonStore(home) ? '' : ` --store ${shellWord(store)}`;
}

function pendingStep(chat: Chat, worktree: string, installed: boolean, store: string): string {
  const status = `\`slipstream status${store}\``;
  const conductorReload = 'Conductor has no verified way to reload a running chat\'s hooks and tools, so this stays '
    + `pending until the chat confirms. Send this chat another message; if it is still pending, run ${status} to check.`;
  const reload = chat.harness === 'claude-code'
    ? chat.conductor ? conductorReload
      : `Exit this chat, run \`claude --resume ${chat.id}\` in ${worktree}, then run \`slipstream attach${store}\` `
        + 'again there.'
    : chat.conductor
      ? 'Codex runs a project hook only after you trust it, and Conductor does not show that review: in a terminal, '
        + `run \`codex\` in ${worktree}, trust the Slipstream hook in its hook review, and quit. ${conductorReload}`
      : `Exit this chat, run \`codex resume ${chat.id}\` in ${worktree}, trust the Slipstream hook when Codex shows `
        + `its hook review, then run \`slipstream attach${store}\` again there.`;
  return installed
    ? `Next step: the chat must reload to load the new hook and tool. ${reload}`
    : 'Next step: this chat confirms after its next tool call (usually right after this command); check with '
      + `${status}. If it stays setup_pending: ${reload}`;
}
