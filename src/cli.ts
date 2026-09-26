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
 * Shared daemon (Stage 3): one long-lived daemon owns the shared store, one
 * public reader, and at most one active capture; the other verbs are thin
 * control clients that talk to it over its private socket. `start` comes up
 * detached — attach a worktree to begin capture.
 *
 *   slipstream start  [--store <dir>]
 *   slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id>
 *   slipstream status [--store <dir>]
 *   slipstream detach [--store <dir>]
 *
 * Maintenance of retained sessions (only while the daemon is detached):
 *
 *   slipstream delete <session-id> [--store <dir>]
 *   slipstream gc     [--store <dir>]
 */
import { readFile, open, lstat, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultDaemonStore, controlSocketPath } from './daemon-location.ts';
import { startCapture } from './session.ts';
import { startReaderServer } from './http-reader.ts';
import { startDaemon, probeSocket, PROBE_TIMEOUT_MS } from './daemon.ts';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { isValidSessionId } from './store-reader.ts';
import { MAX_MESSAGE_BYTES, type ResponseEnvelope } from './control-protocol.ts';
import { QUESTION_TTL_MS } from './questions.ts';
import { codexPostToolUse, claudePostToolUse, readHookInput } from './question-hook.ts';
import { runTui } from './tui.ts';
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
  | { command: 'status'; store: string }
  | { command: 'detach'; store: string }
  | { command: 'attach'; dir: string; store: string; harness?: string; harnessSessionId?: string; rootTranscript?: string }
  | { command: 'codex-hook'; store: string }
  | { command: 'claude-hook'; store: string }
  | { command: 'ask'; store: string; sessionId: string; requestId: string; inputPath: string }
  | { command: 'delete'; store: string; sessionId: string }
  | { command: 'gc'; store: string };

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

function parseAttach(rest: string[]): Omit<Extract<Args, { command: 'attach' }>, 'command'> | null {
  let dir = process.cwd();
  let store: string | undefined;
  let harness: string | undefined;
  let harnessSessionId: string | undefined;
  let rootTranscript: string | undefined;
  let sawDir = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store' || arg === '--harness' || arg === '--harness-session-id' || arg === '--root-transcript') {
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
  if (command === 'status' || command === 'detach' || command === 'gc') {
    const store = parseStoreOnly(argv.slice(1));
    if (store === null) return null;
    return { command, store };
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
  console.error('       slipstream attach [dir] [--store <dir>] --harness <name> --harness-session-id <id> [--root-transcript <path>]');
  console.error('       slipstream hook codex post-tool-use --store <dir>');
  console.error('       slipstream hook claude-code post-tool-use --store <dir>');
  console.error('       slipstream status [--store <dir>]');
  console.error('       slipstream detach [--store <dir>]');
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

async function runControl(store: string, request: Record<string, unknown> & { verb: string }): Promise<void> {
  const socketPath = controlSocketPath(store);
  try {
    const res = await sendControlRequest({ socketPath, request: { v: 1, ...request } });
    reportControl(res);
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
    console.error('slipstream: detached; `slipstream attach <dir>` a worktree to begin capture');
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
    await runControl(args.store, { verb: 'status' });
    return;
  }

  if (args.command === 'detach') {
    await runControl(args.store, { verb: 'detach' });
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

  if (args.command === 'attach') {
    await runControl(args.store, {
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

  const session = await startCapture({ root: args.dir, storeDir: args.store });
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${session.sessionId}`);
  console.error(`slipstream: log ${session.logPath}`);

  // Shared clean-shutdown wiring for both watch and serve. `teardown` runs any
  // subsystem stop (e.g. the reader server) BEFORE capture stops, so both report
  // cleanly and the log's tail append and drain complete.
  const onSignal = (teardown: () => Promise<void>): void => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await teardown();
      await session.stop();
      const n = await countRecords(session.logPath);
      console.error(`slipstream: stopped; ${n} record(s) committed to ${session.logPath}`);
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
      active: { id: session.sessionId, health: session.health, logPath: session.logPath },
    });
  } catch (err) {
    try { await session.stop(); }
    catch (stopError) { console.error('slipstream: capture cleanup failed', stopError); }
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
