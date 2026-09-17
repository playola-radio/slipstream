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

/**
 * Follow a JSONL file, invoking `onLine` for each complete line — existing
 * history first, then appended lines as they arrive. Thin by design: the
 * classification and formatting it feeds are the tested parts. Polls via
 * watchFile so it works uniformly across platforms.
 */
export async function followLog(
  path: string,
  onLine: (line: string) => void,
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<void> {
  let position = 0;
  let carry = '';
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      const handle = await open(path, 'r');
      try {
        const info = await handle.stat();
        if (info.size < position) {
          position = 0; // truncated or rotated
          carry = '';
        }
        if (info.size > position) {
          const length = info.size - position;
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          position += bytesRead;
          carry += buffer.subarray(0, bytesRead).toString('utf8');
          let nl: number;
          while ((nl = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, nl);
            carry = carry.slice(nl + 1);
            if (line.trim().length > 0) onLine(line);
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Log may not exist yet or momentarily be unreadable; retry on next tick.
    } finally {
      pumping = false;
    }
  };

  await pump();

  return new Promise<void>((resolvePromise) => {
    const interval = opts.intervalMs ?? 250;
    watchFile(path, { interval }, () => void pump());
    const stop = (): void => {
      unwatchFile(path);
      resolvePromise();
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener('abort', stop, { once: true });
    }
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
