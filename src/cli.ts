#!/usr/bin/env node
/**
 * Stage 1 CLI: attach to a worktree, baseline it, watch it, and stream the
 * committed `file.changed` / `capture.gap` records to stdout as JSONL. This is
 * a thin view over the on-disk log — the log is the source of truth, this is
 * one client among possible many (see CLAUDE.md).
 *
 *   slipstream watch [dir] [--store <dir>] [--max-bytes <n>]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startCapture } from './session.ts';
import type { LoggedRecord } from './log.ts';

interface Args {
  dir: string;
  store: string;
  maxBytes?: number;
}

function parseArgs(argv: string[]): Args | null {
  if (argv[0] !== 'watch') return null;
  let dir = process.cwd();
  let store: string | undefined;
  let maxBytes: number | undefined;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--store') store = resolve(rest[++i] ?? '');
    else if (arg === '--max-bytes') maxBytes = Number(rest[++i]);
    else if (!arg.startsWith('--')) dir = resolve(arg);
  }
  return { dir, store: store ?? resolve(dir, '.slipstream'), maxBytes };
}

function usage(): void {
  console.error('Usage: slipstream watch [dir] [--store <dir>] [--max-bytes <n>]');
}

async function readRecords(logPath: string): Promise<LoggedRecord[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedRecord);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exitCode = 2;
    return;
  }

  const session = await startCapture({ root: args.dir, storeDir: args.store, maxBytes: args.maxBytes });
  console.error(`slipstream: watching ${args.dir}`);
  console.error(`slipstream: session ${session.sessionId}`);
  console.error(`slipstream: log ${session.logPath}`);
  console.error('slipstream: press Ctrl-C to stop\n');

  // Tail the log: emit each newly committed record as one JSON line. Polling is
  // deliberately simple and robust; the numbers in bench.ts show commit latency
  // already dominates, so a short poll interval adds no meaningful delay.
  let emitted = 0;
  const tail = setInterval(async () => {
    const recs = await readRecords(session.logPath);
    for (const rec of recs.slice(emitted)) console.log(JSON.stringify(rec));
    emitted = recs.length;
  }, 100);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(tail);
    await session.stop();
    const recs = await readRecords(session.logPath);
    for (const rec of recs.slice(emitted)) console.log(JSON.stringify(rec));
    console.error(`\nslipstream: stopped; ${recs.length} record(s) committed to ${session.logPath}`);
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
