/**
 * `slipstream attach` with no identity flags: connect the agent chat this
 * command runs inside. It finds the chat from the harness's own environment,
 * starts the shared daemon if needed, installs the question hook and answer
 * tool for that harness in this workspace, and attaches with the chat's root
 * transcript. Success needs both recording and a connected chat; anything less
 * is reported as pending or refused, never as attached.
 */
import { readdir, readFile, writeFile, rename, mkdir, lstat, realpath, unlink, chmod, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  const plan = await planAgentConfig(chat, worktree, opts.store, deps);

  await ensureDaemon(opts.store, deps);
  const status = await deps.control({ verb: 'status' });
  if (!status.ok) throw new Refusal(`${status.code}: ${status.message}`);
  refuseOtherBinding(status, chat, worktree);

  const changed = await applyAgentConfig(plan, worktree, deps);

  const res = await deps.control({ verb: 'attach', worktree, harness: chat.harness, harness_session_id: chat.id,
    root_transcript: transcript });
  if (!res.ok) throw new Refusal(`${res.code}: ${res.message}`);
  const connection = String(res.agent_connection);
  if (connection !== 'connected' && connection !== 'setup_pending') throw noDelivery();
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
  if (status.agent_connection === 'disconnected') throw noDelivery();
}

function noDelivery(): Refusal {
  return new Refusal('this workspace is already recorded with this chat, but without question delivery (it was '
    + 'attached without its transcript). The recording was kept; run `slipstream detach`, then `slipstream attach` '
    + 'again to connect the chat.');
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

interface ConfigPlan { hookEdit: Edit | null; toolEdit: Edit | null; claudeTool: string[] | null }

/** Plan only the selected harness's hook and answer tool. Unrelated entries
 * are kept, an identical entry is left alone, and a different Slipstream entry
 * is refused rather than replaced. Nothing is written yet. */
async function planAgentConfig(chat: Chat, worktree: string, store: string, deps: AttachDeps): Promise<ConfigPlan> {
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
  if (chat.harness === 'codex') {
    return { hookEdit, toolEdit: await planCodexTool(join(worktree, '.codex', 'config.toml'), deps.nodePath, toolArgs),
      claudeTool: null };
  }
  const missing = await claudeToolMissing(chat, worktree, deps, toolArgs);
  return { hookEdit, toolEdit: null, claudeTool: missing ? [deps.nodePath, ...toolArgs] : null };
}

/** Write the plan, refusing if a file changed since it was planned. Returns
 * whether anything was written. */
async function applyAgentConfig(plan: ConfigPlan, worktree: string, deps: AttachDeps): Promise<boolean> {
  const { hookEdit, toolEdit, claudeTool } = plan;
  for (const edit of [hookEdit, toolEdit]) {
    if (!edit) continue;
    await writeAtomic(edit);
    deps.out(`Installed the Slipstream ${edit === hookEdit ? 'question hook' : 'answer tool'} in ${edit.path}`);
  }
  if (claudeTool) {
    const claude = deps.env.CLAUDE_CODE_EXECPATH ?? 'claude';
    const { code, output } = await deps.run(claude,
      ['mcp', 'add', '--scope', 'local', 'slipstream', '--', ...claudeTool], worktree);
    if (code !== 0) {
      throw new Refusal(`could not add the Slipstream answer tool with \`claude mcp add\` (exit ${String(code)}): `
        + `${output.trim()}. Nothing was recorded.`);
    }
    deps.out('Installed the Slipstream answer tool for this workspace (claude mcp add --scope local).');
  }
  return hookEdit !== null || toolEdit !== null || claudeTool !== null;
}

/** `original` is the file as planned; null when it did not exist. */
interface Edit { path: string; text: string; original: string | null }

async function readConfig(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Refusal(`cannot read ${path}: ${(err as Error).message}. Nothing was recorded.`);
  }
}

const SLIPSTREAM_HOOK = /\bhook (?:claude-code|codex) post-tool-use\b/;

/** Workspace config is edited in place only; a symlinked file or directory may
 * be shared with other workspaces, so it is refused rather than followed. */
async function readWorkspaceConfig(path: string): Promise<string | null> {
  for (const p of [dirname(path), path]) {
    let link = false;
    try { link = (await lstat(p)).isSymbolicLink(); } catch { /* missing: created later */ }
    if (link) {
      throw new Refusal(`${p} is a symbolic link; attach only edits this workspace's own config. Nothing was recorded.`);
    }
  }
  return readConfig(path);
}

async function planHook(path: string, command: string): Promise<Edit | null> {
  const text = await readWorkspaceConfig(path);
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
  const existing = post.flatMap((group) => {
    const { matcher, hooks: entries } = (group ?? {}) as { matcher?: unknown; hooks?: unknown };
    return Array.isArray(entries) ? entries.map((h) => ({ matcher, ...(h ?? {}) as { type?: unknown; command?: unknown } })) : [];
  }).filter((h) => typeof h.command === 'string' && SLIPSTREAM_HOOK.test(h.command));
  const different = existing.find((h) => h.matcher !== '*' || h.type !== 'command' || h.command !== command);
  if (different) {
    throw new Refusal(`${path} already has a different Slipstream hook (${String(different.command)}, matcher `
      + `${JSON.stringify(different.matcher)}). It was kept; remove it or make it match. Nothing was recorded.`);
  }
  if (existing.length > 0) return null;
  const next = { ...config, hooks: { ...hooks, PostToolUse: [...post,
    { matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] } };
  return { path, text: `${JSON.stringify(next, null, 2)}\n`, original: text };
}

/** Codex project config is TOML; Slipstream owns only its own server table and
 * appends it as text so the rest of the file stays byte-for-byte unchanged. */
async function planCodexTool(path: string, node: string, args: string[]): Promise<Edit | null> {
  const text = await readWorkspaceConfig(path);
  const block = `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(node)}\n`
    + `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  if (text === null) return { path, text: block, original: null };
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
  if (lines.some(unsafeServerLine)) {
    throw new Refusal(`${path} declares MCP servers in a form attach cannot safely edit. Add this entry by hand:\n`
      + `${block}Nothing was recorded.`);
  }
  const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { path, text: `${text}${sep}${block}`, original: text };
}

/** Only plain `[mcp_servers.<other name>]` tables are understood; any other
 * header or key that mentions mcp_servers (quoted, spaced, dotted, arrays) could
 * already declare Slipstream, so appending a table might break the file. */
function unsafeServerLine(line: string): boolean {
  const t = line.trim();
  const keyOrHeader = t.startsWith('[') ? t : t.split('=')[0]!;
  if (t.startsWith('#') || !keyOrHeader.includes('mcp_servers')) return false;
  return !/^\[mcp_servers\.(?!slipstream[.\]])[\w-]+(?:\.[\w-]+)*\]$/.test(t);
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
  if (server !== null && typeof server === 'object' && server.command === deps.nodePath
    && JSON.stringify(server.args) === JSON.stringify(args)) return false;
  throw new Refusal(`this workspace already has a different \`slipstream\` MCP server for ${chat.harness} `
    + '(see `claude mcp get slipstream`). It was kept; remove it with `claude mcp remove --scope local slipstream` '
    + 'or make it use this store. Nothing was recorded.');
}

/** Replace a planned file atomically, refusing if it changed since planning. A
 * sandboxed chat may not be allowed to write workspace config (Codex keeps
 * `.codex/` read-only in workspace-write mode); that is explained, not crashed on. */
async function writeAtomic(edit: Edit): Promise<void> {
  const tmp = `${edit.path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(edit.path), { recursive: true });
    await writeFile(tmp, edit.text, { flag: 'wx' });
    if (edit.original !== null) await chmod(tmp, (await stat(edit.path)).mode & 0o777);
    if (await readConfig(edit.path) !== edit.original) {
      throw new Refusal(`${edit.path} changed while attach was running; it was kept. Run attach again. `
        + 'Nothing was recorded.');
    }
    await rename(tmp, edit.path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if (err instanceof Refusal) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new Refusal(`could not write ${edit.path} (${code}). This chat's sandbox may block writing there; allow the `
      + 'command to run with write access to the workspace, or start the chat with full access, then run attach '
      + 'again. Nothing was recorded.');
  }
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
