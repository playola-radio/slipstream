/** Host-quiet evidence, wall caps and the append-only journal shared by FD5 runs. */
import { execFile } from 'node:child_process';
import type { open } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export interface HostLimits { preflightQuietSeconds: number; maxFiveMinuteLoadFractionOfPhysicalCores: number;
  maxSwapGrowthBytes: number; requireAcPower: boolean; requireNormalThermal: boolean;
  requireNoMemoryPressureWarning: boolean; sampleIntervalSeconds: number }
export const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item);

/** Every record is appended in order. Result/failure records are durably synced. */
export class Journal {
  private pending = Promise.resolve();
  private fault: Error | undefined;
  private readonly file: Awaited<ReturnType<typeof open>>;
  constructor(file: Awaited<ReturnType<typeof open>>) { this.file = file; }
  record(value: unknown, durable = false): Promise<void> {
    const next = this.pending.then(async () => {
      if (this.fault) return;
      await this.file.appendFile(encode(value) + '\n');
      if (durable) await this.file.sync();
    }).catch(error => { this.fault = error instanceof Error ? error : new Error(String(error)); });
    this.pending = next;
    return next;
  }
  async assertHealthy(): Promise<void> { await this.pending; if (this.fault) throw this.fault; }
  async close(): Promise<void> { await this.pending; await this.file.close(); if (this.fault) throw this.fault; }
}

export function startCap(seconds: number): { signal: AbortSignal; expired: () => boolean; close: () => void } {
  const controller = new AbortController();
  let hit = false;
  const timer = setTimeout(() => { hit = true; controller.abort(new Error('FD5 wall-time cap')); }, seconds * 1000);
  return { signal: controller.signal, expired: () => hit, close: () => clearTimeout(timer) };
}
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

export class CappedWorkDidNotSettleError extends Error {
  override cause: unknown;
  constructor(cause: unknown) {
    super(`capped work did not settle within its cleanup bound after abort: ${String(cause)}`);
    this.name = 'CappedWorkDidNotSettleError';
    this.cause = cause;
  }
}

/** Runs work under a wall cap. A cap hit or veto aborts the work's signal, then waits up to
 * settleMs for the work's own cleanup before failing, so nothing is removed underneath it. */
export async function runCapped<T>(seconds: number, settleMs: number,
  work: (signal: AbortSignal, veto: (reason: Error) => void) => Promise<T>): Promise<T> {
  const cap = startCap(seconds);
  const vetoed = new AbortController();
  const signal = AbortSignal.any([cap.signal, vetoed.signal]);
  const running = work(signal, reason => vetoed.abort(reason));
  try { return await bounded(running, signal); }
  catch (error) {
    if (signal.aborted) {
      try { await bounded(running.then(() => {}, () => {}), AbortSignal.timeout(settleMs)); }
      catch { throw new CappedWorkDidNotSettleError(error); }
    }
    throw error;
  } finally { cap.close(); }
}
export async function cleanupWithin<T>(work: Promise<T>): Promise<T> {
  return bounded(work, AbortSignal.timeout(5_000));
}
export async function acquireWithin<T>(work: Promise<T>, signal: AbortSignal,
  cleanup: (value: T) => Promise<void>): Promise<T> {
  try { return await bounded(work, signal); }
  catch (error) {
    if (signal.aborted) {
      const lateCleanup = work.then(cleanup);
      void lateCleanup.catch(() => {});
      await cleanupWithin(lateCleanup).catch(() => {});
    }
    throw error;
  }
}
const execFileAsync = promisify(execFile);
async function command(binary: string, args: string[]): Promise<string | null> {
  try { return (await execFileAsync(binary, args, { encoding: 'utf8', timeout: 2000,
    maxBuffer: 64 * 1024 })).stdout.trim(); }
  catch { return null; }
}
async function hostEvidence(host: HostLimits): Promise<{ at: string; load5: number; physicalCores: number | null;
  acPower: boolean | null; normalThermal: boolean | null; noMemoryWarning: boolean | null;
  swapUsedBytes: number | null; faults: string[] }> {
  const [batt, therm, memoryLevel, swap, cores] = await Promise.all([
    command('pmset', ['-g', 'batt']), command('pmset', ['-g', 'therm']),
    command('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    command('sysctl', ['vm.swapusage']), command('sysctl', ['-n', 'hw.physicalcpu']),
  ]);
  const used = swap?.match(/used\s*=\s*([\d.]+)([KMG])/i);
  const scale = used?.[2]?.toUpperCase() === 'G' ? 2 ** 30 : used?.[2]?.toUpperCase() === 'M' ? 2 ** 20 : 2 ** 10;
  const swapUsedBytes = used ? Math.round(Number(used[1]) * scale) : null;
  const load5 = loadavg()[1]!;
  const physicalCores = cores !== null && Number.isSafeInteger(Number(cores)) && Number(cores) > 0
    ? Number(cores) : null;
  const acPower = batt === null ? null : batt.includes('AC Power');
  const normalThermal = therm === null ? null :
    therm.includes('No thermal warning level has been recorded') &&
    therm.includes('No performance warning level has been recorded');
  const noMemoryWarning = memoryLevel === null ? null : memoryLevel === '1';
  const faults = [
    ...(physicalCores === null ? ['physical core count unverified'] :
      load5 >= host.maxFiveMinuteLoadFractionOfPhysicalCores * physicalCores ? ['host load veto'] : []),
    ...(host.requireAcPower && acPower !== true ? ['AC power unverified or absent'] : []),
    ...(host.requireNormalThermal && normalThermal !== true ? ['normal thermal state unverified'] : []),
    ...(host.requireNoMemoryPressureWarning && noMemoryWarning !== true ? ['memory pressure unverified or warned'] : []),
    ...(swapUsedBytes === null ? ['swap usage unverified'] : []),
  ];
  return { at: new Date().toISOString(), load5, physicalCores, acPower, normalThermal,
    noMemoryWarning, swapUsedBytes, faults };
}
export async function preflight(host: HostLimits, windowEndUtc: string, journal: Journal): Promise<void> {
  let first: Awaited<ReturnType<typeof hostEvidence>> | undefined;
  for (let i = 0; i <= host.preflightQuietSeconds; i++) {
    const sample = await hostEvidence(host);
    if (Date.now() >= Date.parse(windowEndUtc)) throw new Error('approved measurement window ended during preflight');
    if (!first) first = sample;
    const swapGrowth = first.swapUsedBytes !== null && sample.swapUsedBytes !== null
      ? sample.swapUsedBytes - first.swapUsedBytes : null;
    await journal.record({ type: 'preflight-sample', sample, swapGrowthBytes: swapGrowth });
    await journal.assertHealthy();
    if (sample.faults.length || swapGrowth === null || swapGrowth > host.maxSwapGrowthBytes)
      throw new Error(`host preflight veto: ${[...sample.faults, ...(swapGrowth === null ? ['swap growth unknown'] :
        swapGrowth > host.maxSwapGrowthBytes ? ['swap growth'] : [])].join(', ')}`);
    if (i < host.preflightQuietSeconds) await delay(1000);
  }
}
export function monitorHost(host: HostLimits, windowEndUtc: string, journal: Journal,
  onFault?: (fault: string) => void): { stop: () => Promise<string[]> } {
  const faults: string[] = [];
  const fault = (reason: string): void => { faults.push(reason); onFault?.(reason); };
  let previousSwap: number | null = null;
  let previousSampleAt: bigint | undefined;
  let pending = Promise.resolve();
  let sampling = false;
  const sample = async (): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    if (previousSampleAt !== undefined && Number(startedAt - previousSampleAt) / 1e9 >
      host.sampleIntervalSeconds * 1.5) fault('host sample interval exceeded');
    previousSampleAt = startedAt;
    const item = await hostEvidence(host);
    if (Date.now() >= Date.parse(windowEndUtc)) fault('approved measurement window ended');
    const hadPrevious = previousSwap !== null;
    const growth = hadPrevious && item.swapUsedBytes !== null ? item.swapUsedBytes - previousSwap! : null;
    previousSwap = item.swapUsedBytes;
    item.faults.forEach(fault);
    if (hadPrevious && (growth === null || growth > host.maxSwapGrowthBytes))
      fault('host swap growth unknown or positive');
    await journal.record({ type: 'host-sample', sample: item, swapGrowthBytes: growth });
    await journal.assertHealthy().catch(error => fault(`journal cannot record evidence: ${error}`));
  };
  const schedule = (): void => {
    if (sampling) { fault('host sample missed its interval'); return; }
    sampling = true;
    pending = sample().catch(error => { fault(`host sample: ${error}`); })
      .finally(() => { sampling = false; });
  };
  schedule();
  const timer = setInterval(schedule, host.sampleIntervalSeconds * 1000);
  return { stop: async () => { clearInterval(timer); await pending;
    await journal.record({ type: 'host-monitor-ended' });
    return [...new Set(faults)]; } };
}
