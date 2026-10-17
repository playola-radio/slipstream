/** Pure parsing and scoring for the auto-capture overhead bench. */
import { percentile } from '../../src/bench.ts';

export interface TopSample {
  cpuPercent: number;
  threads: number;
  /** macOS `top` MEM column: physical footprint. */
  memBytes: number;
  /** Cumulative package idle wakeups (Activity Monitor "Idle Wake Ups"). */
  idleWakeups: number;
  /** Cumulative context switches, every thread, voluntary or not. */
  contextSwitches: number;
}

const UNITS: Record<string, number> = { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

export function parseMemSize(text: string): number {
  const m = /^([0-9.]+)([BKMGT])$/.exec(text);
  if (!m) throw new Error(`unrecognized top memory size: ${text}`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** `top` marks a changed value with a trailing `+` or `-`. */
const strip = (field: string): string => field.replace(/[+-]$/, '');

/** Parse `top -l N -s 1 -n 1000 -pid P -stats pid,cpu,th,mem,idlew,csw` output. */
export function parseTopLog(text: string, pid: number): TopSample[] {
  const samples: TopSample[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 6 || fields[0] !== String(pid)) continue;
    const [, cpu, th, mem, idlew, csw] = fields.map(strip);
    samples.push({
      cpuPercent: Number(cpu), threads: Number(th), memBytes: parseMemSize(mem!),
      idleWakeups: Number(idlew), contextSwitches: Number(csw),
    });
  }
  return samples;
}

export interface TopSummary {
  samples: number;
  cpuMeanPercent: number;
  cpuP95Percent: number;
  maxMemBytes: number;
  maxThreads: number;
  idleWakeupsPerSecond: number;
  contextSwitchesPerSecond: number;
}

/** CPU drops the first sample (no interval behind it); cumulative counters use
 * every sample, since their first reading is a valid starting point. */
export function summarizeTop(all: TopSample[], intervalSeconds: number): TopSummary {
  if (all.length < 2) throw new Error(`need at least two top samples, got ${all.length}`);
  const cpu = all.slice(1).map((s) => s.cpuPercent);
  const first = all[0]!;
  const last = all[all.length - 1]!;
  const elapsed = (all.length - 1) * intervalSeconds;
  return {
    samples: cpu.length,
    cpuMeanPercent: cpu.reduce((a, b) => a + b, 0) / cpu.length,
    cpuP95Percent: percentile([...cpu].sort((a, b) => a - b), 95),
    maxMemBytes: Math.max(...all.map((s) => s.memBytes)),
    maxThreads: Math.max(...all.map((s) => s.threads)),
    idleWakeupsPerSecond: (last.idleWakeups - first.idleWakeups) / elapsed,
    contextSwitchesPerSecond: (last.contextSwitches - first.contextSwitches) / elapsed,
  };
}

export interface LatencyStats { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }

export function latencyStats(values: number[]): LatencyStats {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95),
    p99: percentile(sorted, 99), max: sorted[sorted.length - 1]! };
}

export type GateVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNMEASURED';

/** A point measurement, or a [lower, upper] bracket from two imperfect sources.
 * A bracket passes only if its upper bound passes and fails only if its lower
 * bound fails; anything between is inconclusive, never rounded to a pass. */
export function evaluateGate(m: { threshold: number; measured?: number; lower?: number; upper?: number }): GateVerdict {
  if (m.measured !== undefined) return m.measured <= m.threshold ? 'PASS' : 'FAIL';
  if (m.lower === undefined || m.upper === undefined) return 'UNMEASURED';
  if (m.upper <= m.threshold) return 'PASS';
  if (m.lower > m.threshold) return 'FAIL';
  return 'INCONCLUSIVE';
}
