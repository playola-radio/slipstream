#!/usr/bin/env node
/**
 * live-feed — a standalone terminal viewer for a Slipstream capture log.
 *
 * It tails `<store>/sessions/<session_id>/events.jsonl` (the public artifact,
 * read-only) and pretty-prints each change as a scrolling colored line:
 *
 *   HH:MM:SS path <before>B → <after>B [new|deleted|modified]
 *
 * Capture gaps are shown as dim "⚠ gap: <reason>" lines so coverage gaps stay
 * visible. Run the capture with `npm run slipstream -- watch <dir>` in one
 * terminal and this viewer in another.
 *
 *   node tools/live-feed/cli.ts [dir] [--store <dir>] [--log <path>] [--no-color]
 *
 * With no --log, it auto-discovers the newest events.jsonl under the store dir
 * (default `<dir>/.slipstream`).
 */
import { readdir, stat, open } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseLine, formatEvent } from './feed.ts';

export interface CliOptions {
  logPath: string | null;
  storeDir: string;
  color: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

export interface ParseEnv {
  cwd: string;
  defaultColor: boolean;
}

export function parseArgs(argv: string[], env: ParseEnv): ParseResult {
  let dir = env.cwd;
  let store: string | undefined;
  let logPath: string | undefined;
  let color = env.defaultColor;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--no-color') color = false;
    else if (arg === '--color') color = true;
    else if (arg === '--store' || arg === '--log') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `missing value for ${arg}` };
      }
      if (arg === '--store') store = resolve(env.cwd, value);
      else logPath = resolve(env.cwd, value);
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown option ${arg}` };
    } else {
      dir = resolve(env.cwd, arg);
    }
  }

  return {
    ok: true,
    options: {
      logPath: logPath ?? null,
      storeDir: store ?? join(dir, '.slipstream'),
      color,
      help,
    },
  };
}

/** Find the most recently modified events.jsonl under `<storeDir>/sessions/*`. */
export async function discoverLog(storeDir: string): Promise<string | null> {
  const sessionsDir = join(storeDir, 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    const candidate = join(sessionsDir, entry, 'events.jsonl');
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs: info.mtimeMs };
    } catch {
      continue;
    }
  }
  return newest?.path ?? null;
}

const READ_CHUNK = 1 << 20; // 1 MiB — bounds memory and dodges the max-string-length limit

/**
 * Follow a JSONL file, invoking `onLine` for each complete line — existing
 * history first, then appended lines as they arrive. Thin by design: the
 * classification and formatting it feeds are the tested parts. Polls via
 * watchFile so it works uniformly across platforms.
 *
 * Bytes are accumulated in a Buffer and split on the newline byte, so a
 * multibyte character straddling two reads is never decoded mid-sequence. The
 * `watchFile` listener is installed before the initial read so appends landing
 * during startup are not missed, and a `dirty` flag re-runs the pump when a
 * change arrives while one is already in flight.
 */
export async function followLog(
  path: string,
  onLine: (line: string) => void,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<void> {
  let position = 0;
  let inode: number | null = null;
  let carry = Buffer.alloc(0);
  let pumping = false;
  let dirty = false;
  let stopped = false;

  const emitCompleteLines = (): void => {
    let nl: number;
    while ((nl = carry.indexOf(0x0a)) >= 0) {
      if (stopped) return;
      const line = carry.subarray(0, nl).toString('utf8');
      carry = carry.subarray(nl + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      dirty = true; // a change arrived mid-pump; run again when this one finishes
      return;
    }
    pumping = true;
    try {
      do {
        dirty = false;
        if (stopped) break;
        let handle;
        try {
          handle = await open(path, 'r');
        } catch {
          break; // log not present yet; a later watch tick retries
        }
        try {
          const info = await handle.stat();
          if (inode !== null && info.ino !== inode) {
            position = 0; // file was replaced
            carry = Buffer.alloc(0);
          }
          inode = info.ino;
          if (info.size < position) {
            position = 0; // truncated
            carry = Buffer.alloc(0);
          }
          while (position < info.size) {
            if (stopped) break;
            const want = Math.min(READ_CHUNK, info.size - position);
            const buffer = Buffer.alloc(want);
            const { bytesRead } = await handle.read(buffer, 0, want, position);
            if (bytesRead <= 0) break;
            position += bytesRead;
            const chunk = buffer.subarray(0, bytesRead);
            carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
            emitCompleteLines();
          }
        } finally {
          await handle.close();
        }
      } while (dirty && !stopped);
    } finally {
      pumping = false;
    }
  };

  return new Promise<void>((resolvePromise) => {
    const interval = opts.intervalMs ?? 250;
    const listener = (): void => void pump();
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      unwatchFile(path, listener);
      resolvePromise();
    };
    if (opts.signal?.aborted) return stop();
    watchFile(path, { interval }, listener);
    if (opts.signal) opts.signal.addEventListener('abort', stop, { once: true });
    void pump();
  });
}

const HELP = `live-feed — tail a Slipstream capture log as scrolling colored lines

Usage:
  node tools/live-feed/cli.ts [dir] [options]

Options:
  --log <path>    tail this events.jsonl directly (skips discovery)
  --store <dir>   store dir to search (default: <dir>/.slipstream)
  --no-color      disable ANSI color
  --color         force ANSI color
  -h, --help      show this help

With no --log, the newest events.jsonl under <store>/sessions/ is followed.`;

async function main(): Promise<void> {
  const result = parseArgs(process.argv.slice(2), {
    cwd: process.cwd(),
    defaultColor: process.stdout.isTTY === true && !process.env.NO_COLOR,
  });
  if (!result.ok) {
    console.error(`live-feed: ${result.error}`);
    process.exitCode = 2;
    return;
  }
  const { options } = result;
  if (options.help) {
    console.log(HELP);
    return;
  }

  const logPath = options.logPath ?? (await discoverLog(options.storeDir));
  if (!logPath) {
    console.error(`live-feed: no events.jsonl found under ${join(options.storeDir, 'sessions')}`);
    console.error('live-feed: start a capture with `npm run slipstream -- watch <dir>` first,');
    console.error('live-feed: or point at a log with --log <path>.');
    process.exitCode = 1;
    return;
  }

  console.error(`live-feed: following ${logPath}`);
  console.error('live-feed: press Ctrl-C to stop');

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await followLog(logPath, (line) => {
    const rendered = formatEvent(parseLine(line), { color: options.color });
    if (rendered !== null) console.log(rendered);
  }, { signal: controller.signal });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
