#!/usr/bin/env node
/**
 * Stage 1 CLI: attach to a worktree, baseline it, watch it, and append
 * `file.changed` / `capture.gap` records to a JSONL log. The log is the source
 * of truth (see CLAUDE.md); tail it with `tail -f <log>` for a live view.
 *
 *   slipstream watch [dir] [--store <dir>]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCapture } from './session.ts';

interface Args {
  dir: string;
  store: string;
}

function parseArgs(argv: string[]): Args | null {
  if (argv[0] !== 'watch') return null;
  let dir = process.cwd();
  let store: string | undefined;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') store = resolve(rest[++i] ?? '');
    else if (!arg.startsWith('--')) dir = resolve(arg);
  }
  return { dir, store: store ?? resolve(dir, '.slipstream') };
}

async function countRecords(logPath: string): Promise<number> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.length > 0).length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('Usage: slipstream watch [dir] [--store <dir>]');
    process.exitCode = 2;
    return;
  }

  const session = await startCapture({ root: args.dir, storeDir: args.store });
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${session.sessionId}`);
  console.error(`slipstream: log ${session.logPath}`);
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
}

await main();
