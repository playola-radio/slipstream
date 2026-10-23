#!/usr/bin/env node
/**
 * The Slipstream CLI. Two families of commands:
 *
 * Standalone capture (Stage 1/2): watch or serve a single worktree into its own
 * store. The JSONL log is the source of truth (see CLAUDE.md).
 *
 *   slipstream watch [dir] [--store <dir>]
 *   slipstream serve [dir] [--store <dir>]
 *   slipstream view  ...
 *
 * Shared daemon: one long-lived daemon owns the shared store, one public
 * reader, and one capture per workspace (up to the capture cap); the other verbs
 * are thin control clients that talk to it over its private socket. `start` comes
 * up with nothing recording — attach a worktree to begin capture.
 *
 *   slipstream start  [--store <dir>]
 *   slipstream attach [dir] [--store <dir>]   (from inside the agent chat to connect)
 *   slipstream attach --watch-only [dir] [--wait] [--store <dir>]
 *   slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id>
 *   slipstream status [<target>] [--store <dir>]
 *   slipstream detach [<target>] [--store <dir>]   (target: session id or workspace; default: this directory)
 *   slipstream unlink --session <id> [--store <dir>]
 *
 * Conductor integration: install the LaunchAgent and chain setup/archive into
 * Conductor's scripts, the scripts themselves, and enrollment of existing
 * workspaces.
 *
 *   slipstream conductor install|setup|archive|enroll [--store <dir>]
 *
 * Workspaces without Conductor: a git worktree under ~/slipstream/workspaces,
 * set up and recorded, and later archived.
 *
 *   slipstream workspace create <repo-dir> [--store <dir>]
 *   slipstream workspace archive <workspace-dir> [--store <dir>]
 *
 * Maintenance of retained sessions (only while the daemon is detached):
 *
 *   slipstream delete <session-id> [--store <dir>]
 *   slipstream gc     [--store <dir>]
 */
import { readFile, open, lstat, realpath, constants } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { defaultDaemonStore, controlSocketPath } from './daemon-location.ts';
import { startCapture } from './session.ts';
import { acquireSessionLock, SessionOwnedError } from './lock.ts';
import { mkdirpDurable } from './storage.ts';
import { intentPath } from './intent-store.ts';
import { startReaderServer } from './http-reader.ts';
import { startDaemon, probeSocket, PROBE_TIMEOUT_MS } from './daemon.ts';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { isValidSessionId } from './store-reader.ts';
import { MAX_MESSAGE_BYTES, type ResponseEnvelope } from './control-protocol.ts';
import { QUESTION_TTL_MS } from './questions.ts';
import { codexPostToolUse, claudePostToolUse, readHookInput } from './question-hook.ts';
import { runTui } from './tui.ts';
import { runAttachWorkflow, runWatchOnlyAttach, runIdentityAttach } from './attach-workflow.ts';
import { runUnlink, runWithdraw, type WithdrawDeps } from './withdraw-workflow.ts';
import { DaemonUnavailableError, ensureDaemon, type EnsureDaemonDeps } from './ensure-daemon.ts';
import { kickstartLaunchAgent, readManagedInstall, type Run } from './launch-agent.ts';
import {
  InventoryError, readConductorInventory, runConductorArchive, runConductorEnroll, runConductorInstall, runConductorSetup,
  sharedScripts,
} from './conductor.ts';
import { runWorkspaceArchive, runWorkspaceCreate, type WorkspaceDeps } from './workspace.ts';
import { isMainModule } from './entrypoint.ts';
import { loadConfig, type ConfigIO, type ConfigOverrides } from './config.ts';
import { homedir } from 'node:os';
import type { HarnessName } from './event.ts';

interface AskInput {
  text: unknown;
  context: unknown;
  reply_to_question_id?: unknown;
}

type Args =
  | { command: 'watch'; dir: string; store: string }
  | { command: 'serve'; dir: string; store: string }
  | { command: 'view' }
  | { command: 'start'; store: string; configPath?: string; overrides: ConfigOverrides }
  | { command: 'status'; store: string; target?: string }
  | { command: 'detach'; store: string; target: string }
  | { command: 'unlink'; store: string; sessionId: string }
  | { command: 'attach'; dir: string; store: string; harness?: string; harnessSessionId?: string; rootTranscript?: string;
    watchOnly?: boolean; wait?: boolean }
  | { command: 'codex-hook'; store: string }
  | { command: 'claude-hook'; store: string }
  | { command: 'ask'; store: string; sessionId: string; requestId: string; inputPath: string }
  | { command: 'delete'; store: string; sessionId: string }
  | { command: 'gc'; store: string }
  | { command: 'conductor'; action: ConductorAction; store: string }
  | { command: 'workspace'; action: WorkspaceAction; dir: string; store: string };

const CONDUCTOR_ACTIONS = ['install', 'setup', 'archive', 'enroll'] as const;
type ConductorAction = typeof CONDUCTOR_ACTIONS[number];
const WORKSPACE_ACTIONS = ['create', 'archive'] as const;
type WorkspaceAction = typeof WORKSPACE_ACTIONS[number];
const CONDUCTOR_DB = join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

/** The shared daemon's default store lives under the home dir, not the worktree:
 * one daemon serves every worktree from a single owner-only root. */
const DEFAULT_DAEMON_STORE = defaultDaemonStore();
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseDirAndStore(rest: string[]): { dir: string; store: string } | null {
  let dir = process.cwd();
  let store: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    }
    else if (!arg.startsWith('--')) dir = resolve(arg);
  }
  return { dir, store: store ?? resolve(dir, '.slipstream') };
}

/** Store-only flag parse for `start` / `status` / `detach`: a `--store` override
 * and nothing else. A stray positional is a usage error, not a silently ignored
 * arg. */
function parseStoreOnly(rest: string[]): string | null {
  let store: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    } else return null; // positional or unknown flag
  }
  return store ?? DEFAULT_DAEMON_STORE;
}

/** `start [--store <dir>]` plus the Fork 4 enrichment overrides: a config file
 * and per-field CLI overrides layered over it. A bad numeric or harness value is
 * a usage error, not a silent skip. */
function parseStart(rest: string[]): { store: string; configPath?: string; overrides: ConfigOverrides } | null {
  let store: string | undefined;
  let configPath: string | undefined;
  const overrides: ConfigOverrides = {};
  const posInt = (v: string | undefined): number | undefined => {
    if (v === undefined || v.startsWith('--')) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const asHarness = (v: string | undefined): HarnessName | undefined =>
    v === 'claude-code' || v === 'codex' ? v : undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) return null;
      store = resolve(v);
    } else if (arg === '--config') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) return null;
      configPath = resolve(v);
    } else if (arg === '--window-ms' || arg === '--grace-ms' || arg === '--codex-scan-limit') {
      const n = posInt(rest[++i]);
      if (n === undefined) return null;
      if (arg === '--window-ms') overrides.windowMs = n;
      else if (arg === '--grace-ms') overrides.graceMs = n;
      else overrides.codexScanLimit = n;
    } else if (arg === '--enable') {
      const h = asHarness(rest[++i]);
      if (h === undefined) return null;
      overrides.sources = { ...overrides.sources, [h]: 'configured' };
    } else if (arg === '--claude-home' || arg === '--codex-home') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) return null;
      const h: HarnessName = arg === '--claude-home' ? 'claude-code' : 'codex';
      overrides.homes = { ...overrides.homes, [h]: resolve(v) };
    } else return null; // positional or unknown flag
  }
  return { store: store ?? DEFAULT_DAEMON_STORE, configPath, overrides };
}

/** `delete <session-id> [--store <dir>]`: exactly one required positional (the
 * session id, NOT a path — never `resolve`d) plus an optional `--store`. A missing
 * id, a second positional, or an unknown flag is a usage error. */
function parseDelete(rest: string[]): { store: string; sessionId: string } | null {
  let store: string | undefined;
  let sessionId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    } else if (!arg.startsWith('--')) {
      if (sessionId !== undefined) return null; // a second positional is a usage error
      sessionId = arg;
    } else return null; // unknown flag
  }
  if (sessionId === undefined) return null; // the session id is required
  return { store: store ?? DEFAULT_DAEMON_STORE, sessionId };
}

/** `ask` has no positional arguments: all four pieces of routing and identity
 * are explicit so a retry cannot accidentally target a different capture or
 * manufacture a fresh id. */
function parseAsk(rest: string[]): Omit<Extract<Args, { command: 'ask' }>, 'command'> | null {
  let store: string | undefined;
  let sessionId: string | undefined;
  let requestId: string | undefined;
  let inputPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg !== '--store' && arg !== '--session' && arg !== '--request-id' && arg !== '--input') return null;
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) return null;
    if (arg === '--store') {
      if (store !== undefined) return null;
      store = resolve(value);
    } else if (arg === '--session') {
      if (sessionId !== undefined) return null;
      sessionId = value;
    } else if (arg === '--request-id') {
      if (requestId !== undefined) return null;
      requestId = value;
    } else {
      if (inputPath !== undefined) return null;
      inputPath = resolve(value);
    }
  }
  if (store === undefined || sessionId === undefined || requestId === undefined || inputPath === undefined) return null;
  if (!isValidSessionId(sessionId) || !CANONICAL_UUID.test(requestId)) return null;
  return { store, sessionId, requestId, inputPath };
}

/** `[<target>] [--store <dir>]` for `status` and `detach`. A session id is sent
 * as is; anything else is a workspace path, made absolute here because the
 * daemon runs in another directory. */
function parseTargeted(rest: string[]): { store: string; target?: string } | null {
  let store: string | undefined;
  let target: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      store = resolve(value);
    } else if (arg.startsWith('--') || target !== undefined) return null;
    else target = isValidSessionId(arg) ? arg : resolve(arg);
  }
  return { store: store ?? DEFAULT_DAEMON_STORE, ...(target !== undefined ? { target } : {}) };
}

function parseUnlink(rest: string[]): { store: string; sessionId: string } | null {
  let store: string | undefined;
  let sessionId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) return null;
    if (arg === '--store') store = resolve(value);
    else if (arg === '--session' && sessionId === undefined) sessionId = value;
    else return null;
  }
  if (sessionId === undefined) return null;
  return { store: store ?? DEFAULT_DAEMON_STORE, sessionId };
}

function parseAttach(rest: string[]): Omit<Extract<Args, { command: 'attach' }>, 'command'> | null {
  let dir = process.cwd();
  let store: string | undefined;
  let harness: string | undefined;
  let harnessSessionId: string | undefined;
  let rootTranscript: string | undefined;
  let watchOnly = false;
  let wait = false;
  let sawDir = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--watch-only') watchOnly = true;
    else if (arg === '--wait') wait = true;
    else if (arg === '--store' || arg === '--harness' || arg === '--harness-session-id' || arg === '--root-transcript') {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) return null;
      if (arg === '--store') store = resolve(value);
      else if (arg === '--harness') harness = value;
      else if (arg === '--harness-session-id') harnessSessionId = value;
      else rootTranscript = resolve(value);
    }
    else if (!arg.startsWith('--')) {
      if (sawDir) return null; // a second positional worktree is a usage error, not a silent override
      dir = resolve(arg);
      sawDir = true;
    }
    else return null; // unknown flag
  }
  if (wait && !watchOnly) return null;
  if (watchOnly) {
    if (harness !== undefined || harnessSessionId !== undefined || rootTranscript !== undefined) return null;
    return { dir, store: store ?? DEFAULT_DAEMON_STORE, watchOnly, wait };
  }
  return { dir, store: store ?? DEFAULT_DAEMON_STORE, harness, harnessSessionId, ...(rootTranscript ? { rootTranscript } : {}) };
}

export function parseArgs(argv: string[]): Args | null {
  const command = argv[0];
  if (command === 'watch' || command === 'serve') {
    const parsed = parseDirAndStore(argv.slice(1));
    if (!parsed) return null;
    return { command, dir: parsed.dir, store: parsed.store };
  }
  if (command === 'start') {
    const parsed = parseStart(argv.slice(1));
    if (parsed === null) return null;
    return { command, store: parsed.store, configPath: parsed.configPath, overrides: parsed.overrides };
  }
  if (command === 'gc') {
    const store = parseStoreOnly(argv.slice(1));
    if (store === null) return null;
    return { command, store };
  }
  if (command === 'status') {
    const parsed = parseTargeted(argv.slice(1));
    return parsed && { command, ...parsed };
  }
  if (command === 'detach') {
    const parsed = parseTargeted(argv.slice(1));
    return parsed && { command, store: parsed.store, target: parsed.target ?? process.cwd() };
  }
  if (command === 'unlink') {
    const parsed = parseUnlink(argv.slice(1));
    return parsed && { command, ...parsed };
  }
  if (command === 'attach') {
    const parsed = parseAttach(argv.slice(1));
    if (!parsed) return null;
    return { command: 'attach', ...parsed };
  }
  if (command === 'hook' && argv[1] === 'codex' && argv[2] === 'post-tool-use') {
    const store = parseStoreOnly(argv.slice(3));
    return store === null ? null : { command: 'codex-hook', store };
  }
  if (command === 'hook' && argv[1] === 'claude-code' && argv[2] === 'post-tool-use') {
    const store = parseStoreOnly(argv.slice(3));
    return store === null ? null : { command: 'claude-hook', store };
  }
  if (command === 'delete') {
    const parsed = parseDelete(argv.slice(1));
    if (!parsed) return null;
    return { command: 'delete', ...parsed };
  }
  if (command === 'ask') {
    const parsed = parseAsk(argv.slice(1));
    if (!parsed) return null;
    return { command: 'ask', ...parsed };
  }
  if (command === 'conductor' && (CONDUCTOR_ACTIONS as readonly string[]).includes(argv[1] ?? '')) {
    const store = parseStoreOnly(argv.slice(2));
    return store === null ? null : { command, action: argv[1] as ConductorAction, store };
  }
  if (command === 'workspace' && (WORKSPACE_ACTIONS as readonly string[]).includes(argv[1] ?? '')) {
    const dir = argv[2];
    if (dir === undefined || dir.startsWith('--')) return null;
    const store = parseStoreOnly(argv.slice(3));
    return store === null ? null : { command, action: argv[1] as WorkspaceAction, dir: resolve(dir), store };
  }
  if (command === 'view') return { command: 'view' };
  return null;
}

async function countRecords(logPath: string): Promise<number> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).length;
}

function usage(): void {
  console.error('Usage: slipstream watch  [dir] [--store <dir>]');
  console.error('       slipstream serve  [dir] [--store <dir>]');
  console.error('       slipstream start  [--store <dir>] [--config <file>] [--enable <harness>]');
  console.error('                         [--window-ms N] [--grace-ms N] [--claude-home <dir>] [--codex-home <dir>] [--codex-scan-limit N]');
  console.error('       slipstream attach [dir] [--store <dir>]   (run inside the agent chat to connect)');
  console.error('       slipstream attach --watch-only [dir] [--wait] [--store <dir>]');
  console.error('       slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id> [--root-transcript <path>]');
  console.error('       slipstream hook codex post-tool-use --store <dir>');
  console.error('       slipstream hook claude-code post-tool-use --store <dir>');
  console.error('       slipstream status [<session-id or dir>] [--store <dir>]');
  console.error('       slipstream detach [<session-id or dir>] [--store <dir>]   (default: this directory)');
  console.error('       slipstream unlink --session <session-id> [--store <dir>]');
  console.error('       slipstream conductor install [--store <dir>]   (LaunchAgent + Conductor setup/archive scripts)');
  console.error('       slipstream conductor enroll  [--store <dir>]   (capture every existing Conductor workspace)');
  console.error('       slipstream conductor setup|archive [--store <dir>]   (run by Conductor\'s scripts)');
  console.error('       slipstream workspace create <repo-dir> [--store <dir>]   (new worktree under ~/slipstream/workspaces)');
  console.error('       slipstream workspace archive <workspace-dir> [--store <dir>]');
  console.error('       slipstream ask --store <dir> --session <capture-id> --request-id <uuid> --input <json-file>');
  console.error('       slipstream delete <session-id> [--store <dir>]');
  console.error('       slipstream gc     [--store <dir>]');
  console.error('       slipstream view   [--store <dir>] [--session <id>] [--disk] [--changes] [--context N] [--full]');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse only the documented file shape before talking to the daemon. The daemon
 * remains the authority for source identity and semantic admission; this prevents
 * a typo or a malformed JSON file from looking like a daemon-side rejection. */
async function readAskInput(path: string): Promise<AskInput> {
  let value: unknown;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('input is not a regular file');
      const buffer = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_MESSAGE_BYTES) throw new Error('input exceeds the control message byte cap');
      bytes = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    const detail = err instanceof SyntaxError ? 'input is not valid JSON' : `could not read input: ${(err as Error).message}`;
    throw new Error(detail);
  }
  if (!isPlainObject(value)) {
    throw new Error('input must be an object with text and context');
  }
  return { text: value.text, context: value.context,
    ...(Object.hasOwn(value, 'reply_to_question_id') ? { reply_to_question_id: value.reply_to_question_id } : {}) };
}

/** The input-file cap alone is insufficient because routing fields are added
 * afterwards. Reject locally before opening the control socket when the actual
 * framed request would exceed the daemon's line cap. */
function assertAskRequestFitsControlLine(request: AskInput & {
  verb: 'ask'; session_id: string; request_id: string;
}): void {
  if (Buffer.byteLength(JSON.stringify({ v: 1, ...request }), 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error('ask request exceeds the control message byte cap');
  }
}

const ASK_SEQ_RE = /^[1-9][0-9]*$/;

function isAskAcknowledgment(res: ResponseEnvelope, sessionId: string, requestId: string): boolean {
  if (!res.ok) return true;
  const r = res as Record<string, unknown>;
  const queuedAt = r.queued_at_ms;
  const expiresAt = r.expires_at_ms;
  return r.session_id === sessionId && r.request_id === requestId
    && typeof r.question_id === 'string' && isValidSessionId(r.question_id)
    && typeof r.seq === 'string' && ASK_SEQ_RE.test(r.seq)
    && typeof queuedAt === 'number' && Number.isSafeInteger(queuedAt) && queuedAt >= 0
    && typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt >= 0
    && expiresAt === queuedAt + QUESTION_TTL_MS
    && typeof r.duplicate === 'boolean';
}

async function runAskControl(store: string, request: AskInput & {
  verb: 'ask'; session_id: string; request_id: string;
}): Promise<void> {
  try {
    const res = await sendControlRequest({ socketPath: controlSocketPath(store), request: { v: 1, ...request } });
    if (!isAskAcknowledgment(res, request.session_id, request.request_id)) {
      throw new OutcomeUnknownError('daemon reply was not a valid ask acknowledgment');
    }
    // Ask responses are an API surface. Preserve all durable acknowledgment or
    // rejection metadata, without rendering submitted source text.
    if (!res.ok && res.code === 'STORAGE_UNAVAILABLE') {
      console.error(JSON.stringify({ ...res, message: `${res.message}; outcome unknown; ${retryGuidance('ask')}` }));
      process.exitCode = 3;
    } else {
      (res.ok ? console.log : console.error)(JSON.stringify(res));
      if (!res.ok) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      console.error(`slipstream: outcome unknown — ${err.message}`);
      console.error(`slipstream: ${retryGuidance('ask')}`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

/** Refuse a standalone capture over a store a daemon owns: its control socket is
 * the tell. Two writers over one store would fight for the lock and the reader;
 * failing here gives a clear message instead of a lock error. Returns true when
 * the caller should stop. */
async function isDaemonOwned(store: string): Promise<boolean> {
  const controlSock = controlSocketPath(store);
  let st;
  try {
    st = await lstat(controlSock);
  } catch {
    return false; // no control socket: no daemon owns this store
  }
  if (!st.isSocket()) return false; // an unrelated file squatting the path is not a daemon
  const verdict = await probeSocket(controlSock, PROBE_TIMEOUT_MS);
  if (verdict === 'stale') return false; // socket left by a dead daemon; safe to capture
  // 'live' or 'ambiguous': a daemon may still own this store; refuse to fight it for the lock.
  console.error(`slipstream: ${store} is owned by a running daemon (${controlSock} answers).`);
  console.error('slipstream: use `slipstream attach` to capture through the daemon, or choose another --store.');
  process.exitCode = 2;
  return true;
}

/** Print a control response: ok fields to stdout, an error to stderr with a
 * non-zero exit. */
function reportControl(res: ResponseEnvelope): void {
  if (res.ok) {
    for (const [key, value] of Object.entries(res)) {
      if (key === 'v' || key === 'ok') continue;
      console.log(`${key}: ${String(value)}`);
    }
    return;
  }
  console.error(`slipstream: ${res.code}: ${res.message}`);
  process.exitCode = 1;
}

/** How to recover from an unknowable outcome, per verb. `status` reports attach
 * state only — it cannot show whether a `delete_session` or `gc` committed — so
 * point those idempotent maintenance verbs at a check that actually confirms
 * them, or at a safe rerun, instead of the generic "run status". */
export function retryGuidance(verb: string): string {
  switch (verb) {
    case 'delete_session':
      return 'the deletion may have committed; `slipstream delete` is idempotent — safely rerun it, '
        + "or confirm via the reader's session listing (a removed session is served HTTP 410 gone).";
    case 'gc':
      return '`slipstream gc` is idempotent — safely rerun it to finish any interrupted cleanup.';
    case 'ask':
      return 'retry the SAME --request-id, --session, and input body; do not retarget an old capture.';
    default:
      return 'run `slipstream status` before retrying; the request may have committed.';
  }
}

async function runControl(store: string, request: Record<string, unknown> & { verb: string },
  printOk?: (res: Record<string, unknown>) => void): Promise<void> {
  const socketPath = controlSocketPath(store);
  try {
    const res = await sendControlRequest({ socketPath, request: { v: 1, ...request } });
    if (res.ok && printOk) printOk(res);
    else reportControl(res);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      // Honesty: the request reached the daemon but its outcome is unknowable —
      // never report it as "nothing happened".
      console.error(`slipstream: outcome unknown — ${err.message}`);
      console.error(`slipstream: ${retryGuidance(request.verb)}`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

/** Detach, unlink or archive: through the daemon, or recorded offline without one. */
async function runWithdrawal(store: string, run: (deps: WithdrawDeps) => Promise<number>, verb: string): Promise<void> {
  const socketPath = controlSocketPath(store);
  try {
    process.exitCode = await run({ store, out: (line) => console.log(line), err: (line) => console.error(line),
      control: (request) => sendControlRequest({ socketPath, request: { v: 1, ...request } }) });
  } catch (err) {
    if (!(err instanceof OutcomeUnknownError)) throw err;
    console.error(`slipstream: outcome unknown — ${err.message}`);
    console.error(`slipstream: ${retryGuidance(verb)}`);
    process.exitCode = 3;
  }
}

type CaptureRow = Record<string, unknown> & { binding?: Record<string, unknown> | null };

/** Human-readable `status`: the daemon, then one block per capture. */
export function formatStatus(res: Record<string, unknown>): string[] {
  const lines = [`reader_url: ${String(res.reader_url)}`];
  const slots = res.binding_slots as { used: number; limit: number } | undefined;
  if (slots) lines.push(`linked_chats: ${slots.used}/${slots.limit}`);
  const rows = res.capture ? [res.capture as CaptureRow] : (res.captures ?? []) as CaptureRow[];
  if (!res.capture) lines.push(`captures: ${rows.length}`);
  for (const row of rows) {
    lines.push('', `${String(row.root)}`);
    lines.push(`  session_id: ${String(row.session_id)}`);
    lines.push(`  state: ${String(row.state)}${row.reason ? ` (${String(row.reason)})` : ''}`);
    if (row.message) lines.push(`  ${String(row.message)}`);
    const b = row.binding;
    lines.push(b
      ? `  chat: ${String(b.harness)} ${String(b.harness_session_id)} ${String(b.state)} (generation ${String(b.binding_generation)})`
      : '  chat: none');
  }
  return lines;
}

/** `slipstream attach --watch-only` records a workspace without linking a chat. */
async function runWatchOnly(dir: string, store: string, wait: boolean): Promise<number> {
  const socketPath = controlSocketPath(store);
  try {
    return await runWatchOnlyAttach({ dir, wait }, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      control: (request) => sendControlRequest({ socketPath, request: { v: 1, ...request } }),
    });
  } catch (err) {
    if (!(err instanceof OutcomeUnknownError)) throw err;
    console.error(`slipstream: outcome unknown — ${err.message}`);
    console.error(`slipstream: ${retryGuidance('attach')}`);
    return 3;
  }
}

/** Watch-only attach that first starts this store's daemon when none is running. */
async function watchOnlyWithDaemon(dir: string, store: string, wait: boolean): Promise<number> {
  const cliPath = await realpath(fileURLToPath(import.meta.url));
  try {
    await ensureDaemon(store, await daemonStarter(store, cliPath));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    console.error(`slipstream: ${err.message}`);
    return 1;
  }
  return runWatchOnly(dir, store, wait);
}

const runCommand: Run = (command, commandArgs) => new Promise((done) => {
  execFile(command, commandArgs, { timeout: 30_000 }, (err, stdout, stderr) => {
    const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
    done({ code, output: `${stdout}${stderr}` });
  });
});

/** How to start this store's daemon: through launchd when `conductor install`
 * manages it, so there is only ever the supervised one; otherwise detached. */
async function daemonStarter(store: string, cliPath: string): Promise<EnsureDaemonDeps> {
  const socketPath = controlSocketPath(store);
  const probe = () => probeSocket(socketPath, PROBE_TIMEOUT_MS);
  const managed = await readManagedInstall(store).catch(() => null);
  if (managed && process.getuid) {
    const uid = process.getuid();
    return { probe, logPath: managed.log, startDaemon: () => kickstartLaunchAgent(uid, runCommand) };
  }
  return {
    probe,
    startDaemon: () => {
      const child = spawn(process.execPath, [cliPath, 'start', '--store', store], { cwd: homedir(), detached: true, stdio: 'ignore' });
      const exited = new Promise<number | null>((done) => {
        child.once('exit', (code) => done(code));
        child.once('error', () => done(null));
      });
      child.unref();
      return { exited };
    },
  };
}

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

async function runConductor(action: ConductorAction, store: string): Promise<number> {
  const cliPath = await realpath(fileURLToPath(import.meta.url));
  const socketPath = controlSocketPath(store);
  const out = (line: string) => console.log(line);
  const err = (line: string) => console.error(line);
  const control = (request: Record<string, unknown> & { verb: string }) => sendControlRequest({ socketPath, request: { v: 1, ...request } });
  const ensure = async () => ensureDaemon(store, await daemonStarter(store, cliPath));
  if (action === 'install') {
    if (!process.getuid) {
      err('slipstream: `conductor install` needs macOS launchd.');
      return 1;
    }
    return runConductorInstall({
      home: homedir(), store, uid: process.getuid(), execPath: process.execPath, nodeVersion: process.versions.node,
      cliPath, packageVersion: await packageVersion(), run: runCommand, out, err,
      listRepos: async () => (await readConductorInventory(CONDUCTOR_DB)).repos,
    });
  }
  if (action === 'setup') {
    return runConductorSetup({ env: process.env, store, packageVersion: await packageVersion(), ensureDaemon: ensure, err,
      attach: (dir) => runWatchOnly(dir, store, true) });
  }
  if (action === 'archive') {
    await runWithdrawal(store, (deps) => runConductorArchive({ env: process.env, err,
      withdraw: (target) => runWithdraw({ target, reason: 'archived', missingOk: true }, deps) }), 'detach');
    return Number(process.exitCode ?? 0);
  }
  let inventory;
  try { inventory = await readConductorInventory(CONDUCTOR_DB); } catch (e) {
    if (!(e instanceof InventoryError)) throw e;
    err(`slipstream: ${e.message}`);
    return 1;
  }
  try {
    return await runConductorEnroll(inventory, { ensureDaemon: ensure, control, out, err });
  } catch (e) {
    if (!(e instanceof OutcomeUnknownError)) throw e;
    err(`slipstream: outcome unknown — ${e.message}`);
    err(`slipstream: ${retryGuidance('attach')}`);
    return 3;
  }
}

async function runWorkspace(action: WorkspaceAction, dir: string, store: string): Promise<number> {
  const deps: WorkspaceDeps = {
    home: homedir(),
    git: (args, cwd) => new Promise((done) => {
      execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
        done({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, output: `${stdout}${stderr}` });
      });
    }),
    record: (path) => watchOnlyWithDaemon(path, store, true),
    withdraw: async (path) => {
      await runWithdrawal(store, (w) => runWithdraw({ target: path, reason: 'archived', missingOk: true }, w), 'detach');
      return Number(process.exitCode ?? 0);
    },
    scripts: sharedScripts,
    runScript: (script, cwd, env) => new Promise((done) => {
      const child = spawn('/bin/sh', ['-c', script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('exit', (code) => done(code ?? 1));
      child.once('error', () => done(1));
    }),
    exists: (path) => lstat(path).then(() => true, () => false),
    realpath: (path) => realpath(path),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
  return action === 'create' ? runWorkspaceCreate(dir, deps) : runWorkspaceArchive(dir, deps);
}

async function runIdentity(store: string, request: Record<string, unknown> & { verb: 'attach'; worktree: string }): Promise<void> {
  const socketPath = controlSocketPath(store);
  try {
    process.exitCode = await runIdentityAttach(request, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      control: (req) => sendControlRequest({ socketPath, request: { v: 1, ...req } }),
      report: (res) => reportControl({ v: 1, ok: true, ...res }),
    });
  } catch (err) {
    if (!(err instanceof OutcomeUnknownError)) throw err;
    console.error(`slipstream: outcome unknown — ${err.message}`);
    console.error(`slipstream: ${retryGuidance('attach')}`);
    process.exitCode = 3;
  }
}

/** `slipstream attach` without identity flags connects the chat it runs in. */
async function runThisChatAttach(dir: string, store: string): Promise<void> {
  const socketPath = controlSocketPath(store);
  const cliPath = await realpath(fileURLToPath(import.meta.url));
  try {
    process.exitCode = await runAttachWorkflow({ dir, store }, {
      env: process.env, home: homedir(), nodePath: process.execPath, cliPath,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      ...await daemonStarter(store, cliPath),
      control: (request) => sendControlRequest({ socketPath, request: { v: 1, ...request } }),
      run: (command, commandArgs, cwd) => new Promise((done) => {
        execFile(command, commandArgs, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          done({ code, output: `${stdout}${stderr}` });
        });
      }),
    });
  } catch (err) {
    if (!(err instanceof OutcomeUnknownError)) throw err;
    console.error(`slipstream: outcome unknown — ${err.message}`);
    console.error(`slipstream: ${retryGuidance('attach')}`);
    process.exitCode = 3;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (args.command === 'view') {
    await runTui(process.argv.slice(3), console.log);
    return;
  }

  if (args.command === 'codex-hook' || args.command === 'claude-hook') {
    try {
      const deadlineAtMs = Date.now() + 1000;
      const callback = await readHookInput(process.stdin, deadlineAtMs);
      const output = await (args.command === 'codex-hook' ? codexPostToolUse : claudePostToolUse)(callback, args.store, deadlineAtMs);
      if (output) process.stdout.write(output);
    } catch { /* Hooks must never interrupt the agent or log callback content. */ }
    return;
  }

  if (args.command === 'start') {
    const configIO: ConfigIO = { readFile: (p) => readFile(p, 'utf8').then((s) => s).catch(() => undefined) };
    const { config, warnings } = await loadConfig({
      path: args.configPath,
      io: configIO,
      cli: args.overrides,
      homeDir: homedir(),
    });
    for (const w of warnings) console.error(`slipstream: ${w}`);
    const daemon = await startDaemon({ storeDir: args.store, config });
    console.error(`slipstream: daemon control ${daemon.socketPath}`);
    console.error(`slipstream: reader ${daemon.readerUrl}`);
    console.error('slipstream: nothing is recording yet; `slipstream attach <dir>` a worktree to begin capture');
    console.error('slipstream: press Ctrl-C to stop');
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (args.command === 'status') {
    await runControl(args.store, { verb: 'status', ...(args.target !== undefined ? { target: args.target } : {}) },
      (res) => formatStatus(res).forEach((line) => console.log(line)));
    return;
  }

  if (args.command === 'detach') {
    await runWithdrawal(args.store, (deps) => runWithdraw({ target: args.target, reason: 'detached' }, deps), 'detach');
    return;
  }

  if (args.command === 'unlink') {
    await runWithdrawal(args.store, (deps) => runUnlink({ sessionId: args.sessionId }, deps), 'unlink');
    return;
  }

  if (args.command === 'ask') {
    let input: AskInput;
    try {
      input = await readAskInput(args.inputPath);
      assertAskRequestFitsControlLine({
        verb: 'ask', session_id: args.sessionId, request_id: args.requestId, ...input,
      });
    } catch (err) {
      console.error(`slipstream: ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }
    await runAskControl(args.store, {
      verb: 'ask', session_id: args.sessionId, request_id: args.requestId, ...input,
    });
    return;
  }

  if (args.command === 'attach' && args.watchOnly) {
    process.exitCode = await watchOnlyWithDaemon(args.dir, args.store, args.wait === true);
    return;
  }

  if (args.command === 'conductor') {
    process.exitCode = await runConductor(args.action, args.store);
    return;
  }

  if (args.command === 'workspace') {
    process.exitCode = await runWorkspace(args.action, args.dir, args.store);
    return;
  }

  if (args.command === 'attach' && !args.harness && !args.harnessSessionId && !args.rootTranscript) {
    await runThisChatAttach(args.dir, args.store);
    return;
  }

  if (args.command === 'attach') {
    await runIdentity(args.store, {
      verb: 'attach',
      worktree: args.dir,
      harness: args.harness,
      harness_session_id: args.harnessSessionId,
      root_transcript: args.rootTranscript,
    });
    return;
  }

  if (args.command === 'gc') {
    await runControl(args.store, { verb: 'gc' });
    return;
  }

  if (args.command === 'delete') {
    // Validate the id client-side so a typo is a clear local error, not a round
    // trip: an invalid id can never name a real session, and this keeps a malformed
    // path off the wire. The daemon re-validates and re-checks existence.
    if (!isValidSessionId(args.sessionId)) {
      console.error(`slipstream: not a valid session id: ${args.sessionId}`);
      process.exitCode = 2;
      return;
    }
    await runControl(args.store, { verb: 'delete_session', session_id: args.sessionId });
    return;
  }

  // Standalone capture: never over a daemon-owned store.
  if (await isDaemonOwned(args.store)) return;

  // Hold the store lock for the whole capture, as the daemon does: gc and offline
  // intent writers then know this store has a writer they must not run beside.
  await mkdirpDurable(args.store);
  let session: Awaited<ReturnType<typeof startCapture>> | undefined;
  let storeLock;
  try {
    storeLock = await acquireSessionLock(args.store, { onCompromised: (reason) => {
      console.error(`slipstream: lost the store lock (${reason}); stopping capture`);
      void (session?.stop() ?? Promise.resolve()).finally(() => process.exit(1));
    } });
  } catch (err) {
    if (!(err instanceof SessionOwnedError)) throw err;
    console.error(`slipstream: ${args.store} is in use by another slipstream process (${err.message}).`);
    console.error('slipstream: use `slipstream attach` to capture through the daemon, or choose another --store.');
    process.exitCode = 2;
    return;
  }
  // Readers take a live store lock to mean a daemon will start this store's
  // waiting captures (contracts.md §7), so never hold a daemon store's lock for
  // a capture. Checked under the lock: only a lock holder creates the record.
  const daemonStore = await lstat(intentPath(args.store)).then(() => true, async (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    await storeLock.release();
    throw err;
  });
  if (daemonStore) {
    await storeLock.release();
    console.error(`slipstream: ${args.store} belongs to the slipstream daemon (it has capture intent).`);
    console.error('slipstream: use `slipstream attach` to capture through the daemon, or choose another --store.');
    process.exitCode = 2;
    return;
  }
  try {
    session = await startCapture({ root: args.dir, storeDir: args.store });
  } catch (err) {
    await storeLock.release().catch(() => {});
    throw err;
  }
  const captured = session;
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${captured.sessionId}`);
  console.error(`slipstream: log ${captured.logPath}`);

  // Shared clean-shutdown wiring for both watch and serve. `teardown` runs any
  // subsystem stop (e.g. the reader server) BEFORE capture stops, so both report
  // cleanly and the log's tail append and drain complete.
  const onSignal = (teardown: () => Promise<void>): void => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await teardown();
      await captured.stop();
      await storeLock.release();
      const n = await countRecords(captured.logPath);
      console.error(`slipstream: stopped; ${n} record(s) committed to ${captured.logPath}`);
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  };

  if (args.command === 'watch') {
    console.error('slipstream: press Ctrl-C to stop');
    // The active watcher subscription keeps the process alive until a signal.
    onSignal(async () => {});
    return;
  }

  // args.command === 'serve'
  let server;
  try {
    server = await startReaderServer({
      storeDir: args.store,
      active: { id: captured.sessionId, health: captured.health, logPath: captured.logPath },
    });
  } catch (err) {
    try { await captured.stop(); }
    catch (stopError) { console.error('slipstream: capture cleanup failed', stopError); }
    await storeLock.release().catch(() => {});
    throw err;
  }
  console.error(`slipstream: reader ${server.url}`);
  console.error(`slipstream: reader descriptor ${server.descriptorPath}`);
  console.error('slipstream: press Ctrl-C to stop');

  // Stop accepting readers (aborting live SSE followers) before tearing down capture.
  onSignal(async () => { await server.close(); });
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
