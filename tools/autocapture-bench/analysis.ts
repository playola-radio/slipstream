/** Pure parsing and scoring for the auto-capture overhead bench. */
import { percentile } from '../../src/bench.ts';

export interface TopSample {
  cpuPercent: number;
  threads: number;
  /** macOS `top` MEM column: physical footprint. */
  memBytes: number;
  /** Cumulative package idle wakeups (Activity Monitor "Idle Wake Ups"). */
  idleWakeups: number;
}

const UNITS: Record<string, number> = { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

export function parseMemSize(text: string): number {
  const m = /^([0-9.]+)([BKMGT])$/.exec(text);
  if (!m) throw new Error(`unrecognized top memory size: ${text}`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** `top` marks a changed value with a trailing `+` or `-`. */
const strip = (field: string): string => field.replace(/[+-]$/, '');

/** Parse `top -l N -s 1 -n 1000 -pid P -stats pid,cpu,th,mem,idlew` output. #TH reads
 * `total/running` while a thread runs. */
export function parseTopLog(text: string, pid: number): TopSample[] {
  const samples: TopSample[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== String(pid)) continue;
    const [, cpu, th, mem, idlew] = fields.map(strip);
    samples.push({
      cpuPercent: Number(cpu), threads: Number(th!.split('/')[0]), memBytes: parseMemSize(mem!),
      idleWakeups: Number(idlew),
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

export const MIN_BASELINE_COVERAGE = 0.95;

interface Arm { latenciesMs: number[]; missing: number }

/** p99 with each lost write standing in at `as` ms. */
const p99With = (arm: Arm, as: number) => latencyStats([...arm.latenciesMs, ...Array<number>(arm.missing).fill(as)]).p99;

/** A lost write's latency is unknown, so it brackets the regression: the pass
 * bound counts arm B's lost writes as unboundedly slow and arm A's as instant,
 * the fail bound the reverse. With nothing lost the bracket is a point. */
export function latencyVerdict(m: { a: Arm; b: Arm; coverage: number }): { verdict: GateVerdict; note?: string } {
  if (m.a.latenciesMs.length === 0 || m.b.latenciesMs.length === 0) return { verdict: 'UNMEASURED' };
  if (m.coverage < MIN_BASELINE_COVERAGE) {
    return { verdict: 'INCONCLUSIVE', note: `only ${(m.coverage * 100).toFixed(1)}% of arm B writes ran beside a baseline (need ${MIN_BASELINE_COVERAGE * 100}%)` };
  }
  const upper = p99With(m.b, Infinity)! / p99With(m.a, 0)! - 1;
  const lower = p99With(m.b, 0)! / p99With(m.a, Infinity)! - 1;
  const verdict = evaluateGate({ threshold: 0.2, lower, upper });
  const lost = m.a.missing + m.b.missing;
  return lost === 0 ? { verdict } : { verdict, note: `${lost} lost writes (A ${m.a.missing}, B ${m.b.missing}) bracket the regression` };
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
