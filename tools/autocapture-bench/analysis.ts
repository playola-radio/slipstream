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

/** Parse `top -l N -s 1 -n 1000 -pid P -stats pid,cpu,th,mem,idlew,csw` output. #TH reads
 * `total/running` while a thread runs. */
export function parseTopLog(text: string, pid: number): TopSample[] {
  const samples: TopSample[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 6 || fields[0] !== String(pid)) continue;
    const [, cpu, th, mem, idlew, csw] = fields.map(strip);
    samples.push({
      cpuPercent: Number(cpu), threads: Number(th!.split('/')[0]), memBytes: parseMemSize(mem!),
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
export function evaluateGate(m: { threshold: number; measured?: number | null; lower?: number; upper?: number }): GateVerdict {
  if (m.measured === null || (m.measured !== undefined && !Number.isFinite(m.measured))) return 'UNMEASURED';
  if (m.measured !== undefined) return m.measured <= m.threshold ? 'PASS' : 'FAIL';
  if (m.lower === undefined || m.upper === undefined) return 'UNMEASURED';
  if (m.upper <= m.threshold) return 'PASS';
  if (m.lower > m.threshold) return 'FAIL';
  return 'INCONCLUSIVE';
}

/** Startup residue in an unsettled window only adds cost, so it can confirm a
 * pass on a cost gate but not a failure; a comparison gate is invalid either way. */
export function settledVerdict(verdict: GateVerdict, m: { settled: boolean; costOnly: boolean }): GateVerdict {
  if (m.settled) return verdict;
  return m.costOnly && verdict === 'PASS' ? 'PASS' : 'INCONCLUSIVE';
}

/** Share of writes (hrtime ns) that landed inside some interval. */
export function coveredFraction(writesNs: bigint[], intervals: { startNs: bigint; endNs: bigint }[]): number {
  if (writesNs.length === 0) return 0;
  const inside = writesNs.filter((w) => intervals.some((i) => w >= i.startNs && w <= i.endNs)).length;
  return inside / writesNs.length;
}

/** Lost writes or uncovered arm-B writes would let a clean-looking surviving p99 stand in for the whole arm. */
export const MAX_MISSING_FRACTION = 0.01;
export const MIN_BASELINE_COVERAGE = 0.95;

export function latencyVerdict(m: { regression: number | null; missingFractionA: number; missingFractionB: number; coverage: number }): { verdict: GateVerdict; note?: string } {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const [arm, f] of [['A', m.missingFractionA], ['B', m.missingFractionB]] as const) {
    if (f > MAX_MISSING_FRACTION) return { verdict: 'INCONCLUSIVE', note: `${pct(f)} of arm ${arm} writes never became durable (limit ${pct(MAX_MISSING_FRACTION)})` };
  }
  if (m.coverage < MIN_BASELINE_COVERAGE) return { verdict: 'INCONCLUSIVE', note: `only ${pct(m.coverage)} of arm B writes ran beside a baseline (need ${pct(MIN_BASELINE_COVERAGE)})` };
  return { verdict: evaluateGate({ threshold: 0.2, measured: m.regression }) };
}

export interface LatencyJoinInput {
  /** One write per unique payload, stamped with process.hrtime after it completed. */
  writes: { sessionId: string; sha256: string; writtenNs: bigint }[];
  /** file.changed records read back from each session's log (after.sha256). */
  changes: { sessionId: string; seq: bigint; sha256: string }[];
  /** Durable-seq advances seen by the subject, in hrtime (same monotonic clock). */
  timeline: { sessionId: string; seq: bigint; ns: bigint }[];
}

/** Write -> durable latency per write. A write with no change record of its own,
 * or no recorded durable advance covering it, is counted as missing. */
export function joinLatencies(input: LatencyJoinInput): { latenciesMs: number[]; perSessionMs: Record<string, number[]>; missing: number } {
  const seqBySha = new Map(input.changes.map((c) => [`${c.sessionId}\0${c.sha256}`, c.seq]));
  const timelines = new Map<string, { seq: bigint; ns: bigint }[]>();
  for (const t of input.timeline) {
    const list = timelines.get(t.sessionId) ?? [];
    list.push(t);
    timelines.set(t.sessionId, list);
  }
  const latenciesMs: number[] = [];
  const perSessionMs: Record<string, number[]> = {};
  let missing = 0;
  for (const w of input.writes) {
    const seq = seqBySha.get(`${w.sessionId}\0${w.sha256}`);
    const durable = seq === undefined ? undefined : timelines.get(w.sessionId)?.find((t) => t.seq >= seq);
    if (!durable) { missing++; continue; }
    const ms = Number(durable.ns - w.writtenNs) / 1e6;
    latenciesMs.push(ms);
    (perSessionMs[w.sessionId] ??= []).push(ms);
  }
  return { latenciesMs, perSessionMs, missing };
}
