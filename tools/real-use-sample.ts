/**
 * The real-use day sampler (docs/autocapture/real-use-check.md). Not a benchmark:
 * it records the daemon's CPU time and memory at a fixed interval while Brian
 * works normally, then summarizes them beside the store's own gap and stop
 * events. It gates nothing; the verdict is read by a person.
 *
 *   node tools/real-use-sample.ts [--store ~/.slipstream] [--interval 60] --out day.ndjson
 *   node tools/real-use-sample.ts [--store ~/.slipstream] --summary day.ndjson
 */
import { createReadStream } from 'node:fs';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

export interface Sample { at_ms: number; pid: number; cpu_s: number; rss_kib: number; log_bytes: number }

/** `ps -o cputime=`: `[[dd-]hh:]mm:ss[.ss]`, minutes may exceed 59. */
export function parseCpuTime(text: string): number {
  const [days, rest] = text.includes('-') ? text.trim().split('-') : ['0', text.trim()];
  const seconds = rest!.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  return Number(days) * 86400 + seconds;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const mib = (kib: number) => round(kib / 1024);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Averages over consecutive samples of one daemon process. An interval is idle
 * when no session log grew during it. */
export function summarize(samples: Sample[]) {
  let wall = 0, cpu = 0, idleWall = 0, idleCpu = 0, idleIntervals = 0, restarts = 0, maxGap = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    maxGap = Math.max(maxGap, (b.at_ms - a.at_ms) / 1000);
    if (a.pid !== b.pid) { restarts++; continue; }
    const dWall = (b.at_ms - a.at_ms) / 1000, dCpu = b.cpu_s - a.cpu_s;
    wall += dWall; cpu += dCpu;
    if (b.log_bytes === a.log_bytes) { idleWall += dWall; idleCpu += dCpu; idleIntervals++; }
  }
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const rss = samples.map((s) => s.rss_kib);
  return {
    hours: round((samples.at(-1)!.at_ms - samples[0]!.at_ms) / 3_600_000),
    samples: samples.length,
    max_gap_s: round(maxGap),
    cpu_pct_all: wall ? round((cpu / wall) * 100) : null,
    cpu_pct_idle: idleWall ? round((idleCpu / idleWall) * 100) : null,
    idle_intervals: idleIntervals,
    rss_max_mib: mib(Math.max(...rss)),
    rss_first_quarter_mib: mib(mean(rss.slice(0, quarter))),
    rss_last_quarter_mib: mib(mean(rss.slice(-quarter))),
    daemon_restarts: restarts,
  };
}

async function sessionLogs(storeDir: string): Promise<string[]> {
  const ids = await readdir(join(storeDir, 'sessions'));
  return ids.map((id) => join(storeDir, 'sessions', id, 'events.jsonl'));
}

/** A session that has not written its log yet has none; any other read failure is an error, never zero. */
async function unlessMissing<T>(read: Promise<T>, absent: T): Promise<T> {
  try { return await read; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return absent;
    throw err;
  }
}

/** Streams only newline-terminated JSONL records, so a concurrent append cannot
 * turn an incomplete final record into a malformed event. */
async function* completeLines(log: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    for await (const chunk of createReadStream(log)) {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.end();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/** `capture.gap` and `capture.stopped` events in [fromMs, toMs], by reason. */
export async function countLifecycle(storeDir: string, fromMs: number, toMs: number) {
  const gaps: Record<string, number> = {}, stops: Record<string, number> = {};
  for (const log of await sessionLogs(storeDir)) {
    for await (const line of completeLines(log)) {
      if (!line.includes('"slipstream.capture.gap.v1"') && !line.includes('"slipstream.capture.stopped.v1"')) continue;
      const e = JSON.parse(line) as { type: string; time: string; data: { reason: string } };
      const t = Date.parse(e.time);
      if (t < fromMs || t > toMs) continue;
      const into = e.type === 'slipstream.capture.gap.v1' ? gaps : stops;
      into[e.data.reason] = (into[e.data.reason] ?? 0) + 1;
    }
  }
  return { gaps, stops };
}

async function sample(storeDir: string): Promise<Sample> {
  const { pid } = JSON.parse(await readFile(join(storeDir, 'owner.lock'), 'utf8')) as { pid: number };
  const { stdout } = await promisify(execFile)('ps', ['-o', 'cputime=,rss=', '-p', String(pid)]);
  const [cpu, rss] = stdout.trim().split(/\s+/);
  let logBytes = 0;
  for (const log of await sessionLogs(storeDir)) logBytes += (await unlessMissing(stat(log).then((st) => st.size), 0));
  return { at_ms: Date.now(), pid, cpu_s: parseCpuTime(cpu!), rss_kib: Number(rss), log_bytes: logBytes };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    store: { type: 'string', default: join(homedir(), '.slipstream') },
    interval: { type: 'string', default: '60' },
    out: { type: 'string' },
    summary: { type: 'string' },
  } });
  if (values.summary) {
    const samples = (await readFile(values.summary, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Sample);
    if (samples.length < 2) throw new Error('need at least two samples');
    const lifecycle = await countLifecycle(values.store, samples[0]!.at_ms, samples.at(-1)!.at_ms);
    console.log(JSON.stringify({ ...summarize(samples), ...lifecycle }, null, 2));
    return;
  }
  if (!values.out) throw new Error('--out <file> or --summary <file> is required');
  const out = values.out;
  const tick = async () => {
    try { await appendFile(out, JSON.stringify(await sample(values.store)) + '\n'); } catch (err) {
      console.error(`sample skipped: ${(err as Error).message}`);
    }
  };
  await tick();
  setInterval(() => void tick(), Number(values.interval) * 1000);
}

if (import.meta.main) await main();
