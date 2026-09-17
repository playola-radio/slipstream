#!/usr/bin/env node
/**
 * Stage 1/2 CLI: attach to a worktree, baseline it, watch it, and append
 * `file.changed` / `capture.gap` records to a JSONL log. The log is the source
 * of truth (see CLAUDE.md); tail it with `tail -f <log>` for a live view.
 *
 *   slipstream watch [dir] [--store <dir>]
 *   slipstream serve [dir] [--store <dir>]
 *   slipstream view ...
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCapture } from './session.ts';
import { startReaderServer } from './http-reader.ts';
import { runTui } from './tui.ts';
import { isMainModule } from './entrypoint.ts';

type Args =
  | { command: 'watch'; dir: string; store: string }
  | { command: 'serve'; dir: string; store: string }
  | { command: 'view' };

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

export function parseArgs(argv: string[]): Args | null {
  const command = argv[0];
  if (command === 'watch' || command === 'serve') {
    const parsed = parseDirAndStore(argv.slice(1));
    if (!parsed) return null;
    return { command, dir: parsed.dir, store: parsed.store };
  }
  if (command === 'view') return { command: 'view' };
  return null;
}

async function countRecords(logPath: string): Promise<number> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('Usage: slipstream watch [dir] [--store <dir>]');
    console.error('       slipstream serve [dir] [--store <dir>]');
    console.error('       slipstream view [--store <dir>] [--session <id>] [--disk]');
    process.exitCode = 2;
    return;
  }

  if (args.command === 'view') {
    await runTui(process.argv.slice(3), console.log);
    return;
  }

  const session = await startCapture({ root: args.dir, storeDir: args.store });
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${session.sessionId}`);
  console.error(`slipstream: log ${session.logPath}`);

  if (args.command === 'watch') {
    console.error('slipstream: press Ctrl-C to stop');

    // The active watcher subscription keeps the process alive; nothing else to do
    // until a signal. Stop cleanly so the log's tail append and drain complete.
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await session.stop();
      const n = await countRecords(session.logPath);
      console.error(`slipstream: stopped; ${n} record(s) committed to ${session.logPath}`);
      process.exit(0);
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  // args.command === 'serve'
  const server = await startReaderServer({
    storeDir: args.store,
    active: { id: session.sessionId, health: session.health, logPath: session.logPath },
  });
  console.error(`slipstream: reader ${server.url}`);
  console.error(`slipstream: reader descriptor ${server.descriptorPath}`);
  console.error('slipstream: press Ctrl-C to stop');

  // Stop accepting readers before tearing down capture, then let watch's own
  // stop message land last so both subsystems report cleanly.
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await server.close();
    await session.stop();
    const n = await countRecords(session.logPath);
    console.error(`slipstream: stopped; ${n} record(s) committed to ${session.logPath}`);
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
