/** Bounded FD5 diagnostics. The registered 12-arm campaign has a separate entry point. */
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isMainModule } from '../src/entrypoint.ts';

export const DIAGNOSTIC_MODES = ['smoke', 'overhead', 'unqueued', 'queue', 'w-pressure'] as const;
export type DiagnosticMode = typeof DIAGNOSTIC_MODES[number];
type ApprovalFields = { measurementWindow: unknown; tracingOverheadTolerance: unknown;
  diagnosticDeadlinePoints: unknown; wPressureRuntimeHook: unknown; clipHistoricalComparison: unknown };
export interface DiagnosticConfig {
  protocol: string; interfaceScorer: string; seed: string; maxPreparationSeconds: number;
  admission: { C: number; Q: number; W: number; clipDeadlineMs: number;
    interfaceDeadlineMs: number; conditionalInterfaceDeadlineMs: number };
  smoke: { scheduledWrites: number; burstWrites: number;
    clipSlots: number; interfaceSlots: number; coldKeysPerWorkload: number; maxArmSeconds: number;
    minRequestIntervalMs: number };
  overhead: { workloads: string[]; traceOrder: string[]; scheduledWritesPerArm: number;
    scheduledIntervalMs: number; burstWritesPerArm: number; slotsPerWorkload: number;
    coldKeysPerWorkload: number; maxAttemptsPerArm: number; maxArmSeconds: number; minRequestIntervalMs: number };
  unqueued: { C: number; Q: number; W: number; observationsPerCell: number;
    cells: Array<{ language: 'typescript' | 'tsx' | 'swift'; size: 'tiny' | 'representative';
      files: 1 | 4 | 16; warmth: 'fresh-worker' | 'initialized-worker-new-content' | 'fresh-child' }>;
    cacheControlRequestsPerVariant: number; maxRequestsIncludingConditional: number; maxSecondsPerCell: number };
  queue: { queueWaiterCells: Array<[number, number]>; repetitionsPerCell: number;
    clipSlots: number; interfaceSlots: number; scheduledWritesPerCell: number;
    scheduledIntervalMs: number; burstWritesPerCell: number; coldKeysPerWorkload: number; maxAttemptsPerCell: number;
    maxCellSecondsIncludingDrain: number; minRequestIntervalMs: number };
  wPressure: { C: number; Q: number; waiterCaps: number[]; groupsPerCap: number;
    sameKeyWaitersPerGroup: number; maxBarrierMs: number;
    maxSecondsPerCap: number; maxRequests: number };
  host: { preflightQuietSeconds: number; maxFiveMinuteLoadFractionOfPhysicalCores: number;
    maxSwapGrowthBytes: number; requireAcPower: boolean; requireNormalThermal: boolean;
    requireNoMemoryPressureWarning: boolean; sampleIntervalSeconds: number };
  approvalRequired: ApprovalFields;
}

const FIXED = JSON.parse(readFileSync(new URL('./fd5-diagnostic-config.json', import.meta.url), 'utf8')) as DiagnosticConfig;

function firstDifference(actual: unknown, expected: unknown, path = 'config'): string | null {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return path;
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  for (const key of Object.keys(a)) if (!(key in e)) return `${path}.${key}: unknown field`;
  for (const key of Object.keys(e)) if (!(key in a)) return `${path}.${key}: missing field`;
  for (const key of Object.keys(e)) {
    const difference = firstDifference(a[key], e[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return path;
}

export function validateDiagnosticConfig(raw: unknown): DiagnosticConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('diagnostic config must be an object');
  const object = raw as Record<string, unknown>;
  const approval = object.approvalRequired;
  if (!approval || typeof approval !== 'object' || Array.isArray(approval))
    throw new Error('diagnostic config approvalRequired must be an object');
  const approved = approval as Record<string, unknown>;
  const missing = firstDifference(Object.fromEntries(Object.keys(approved).map(key => [key, null])), FIXED.approvalRequired,
    'config.approvalRequired');
  if (missing) throw new Error(missing);
  const difference = firstDifference({ ...object, approvalRequired: FIXED.approvalRequired }, FIXED);
  if (difference) throw new Error(`diagnostic ${difference} differs from the committed bounded configuration`);
  return raw as DiagnosticConfig;
}

export function parseDiagnosticArgs(argv: string[]): { configPath: string; mode: DiagnosticMode;
  outputPath?: string; priorPath?: string; describe: boolean } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--describe' || flag === '--execute') {
      if (switches.has(flag)) throw new Error(`duplicate ${flag}`);
      switches.add(flag); continue;
    }
    if (!['--config', '--mode', '--out', '--prior'].includes(flag)) throw new Error(`unknown diagnostic argument ${flag}`);
    if (values.has(flag) || !argv[index + 1] || argv[index + 1]!.startsWith('--'))
      throw new Error(`missing or duplicate ${flag}`);
    values.set(flag, argv[++index]!);
  }
  const configPath = values.get('--config'), mode = values.get('--mode');
  if (!configPath || !DIAGNOSTIC_MODES.includes(mode as DiagnosticMode))
    throw new Error('diagnostic requires --config and one bounded --mode');
  const describe = switches.has('--describe');
  if (describe === switches.has('--execute')) throw new Error('choose exactly one of --describe or --execute');
  const outputPath = values.get('--out');
  if (!describe && !outputPath || describe && outputPath) throw new Error('--out is required only with --execute');
  const priorPath = values.get('--prior');
  if (describe && priorPath || !describe && mode !== 'smoke' && !priorPath || !describe && mode === 'smoke' && priorPath)
    throw new Error('each diagnostic mode after smoke requires its preceding report via --prior');
  return { configPath, mode: mode as DiagnosticMode, ...(outputPath ? { outputPath } : {}),
    ...(priorPath ? { priorPath } : {}), describe };
}

export function describeDiagnosticMode(config: DiagnosticConfig, mode: DiagnosticMode): Record<string, number> {
  switch (mode) {
    case 'smoke': return { arms: 2,
      writes: 2 * (config.smoke.scheduledWrites + config.smoke.burstWrites),
      maxRequests: config.smoke.coldKeysPerWorkload * 2 };
    case 'overhead': return { arms: config.overhead.workloads.length * config.overhead.traceOrder.length,
      writes: config.overhead.workloads.length * config.overhead.traceOrder.length
        * (config.overhead.scheduledWritesPerArm + config.overhead.burstWritesPerArm),
      maxRequests: config.overhead.workloads.length * config.overhead.traceOrder.length
        * Math.min(config.overhead.maxAttemptsPerArm, config.overhead.coldKeysPerWorkload),
      perArmGuard: config.overhead.maxAttemptsPerArm };
    case 'unqueued': return { cells: config.unqueued.cells.length,
      measured: config.unqueued.cells.length * config.unqueued.observationsPerCell,
      warmups: config.unqueued.cells.filter(cell => cell.warmth === 'initialized-worker-new-content').length,
      cacheControlsMaximum: 3 * config.unqueued.cacheControlRequestsPerVariant,
      conditionalSwiftMaximum: config.unqueued.cells.filter(cell => cell.language === 'swift').length
        * config.unqueued.observationsPerCell,
      maxRequests: config.unqueued.maxRequestsIncludingConditional };
    case 'queue': return { cells: config.queue.queueWaiterCells.length * config.queue.repetitionsPerCell,
      writes: config.queue.queueWaiterCells.length * config.queue.repetitionsPerCell
        * (config.queue.scheduledWritesPerCell + config.queue.burstWritesPerCell),
      maxRequests: config.queue.queueWaiterCells.length * config.queue.repetitionsPerCell
        * Math.min(config.queue.maxAttemptsPerCell, 2 * config.queue.coldKeysPerWorkload),
      perCellGuard: config.queue.maxAttemptsPerCell,
      maxCellSecondsIncludingDrain: config.queue.maxCellSecondsIncludingDrain };
    case 'w-pressure': return { groups: config.wPressure.waiterCaps.length * config.wPressure.groupsPerCap,
      maxRequests: config.wPressure.maxRequests, maxSecondsPerCap: config.wPressure.maxSecondsPerCap };
  }
}

async function main(): Promise<void> {
  const args = parseDiagnosticArgs(process.argv.slice(2));
  const config = validateDiagnosticConfig(JSON.parse(await readFile(args.configPath, 'utf8')));
  if (args.describe) { process.stdout.write(JSON.stringify({ mode: args.mode,
    bounds: describeDiagnosticMode(config, args.mode), d7Decision: 'pending' }) + '\n'); return; }
  const { runBoundedDiagnostic } = await import('./fd5-diag-run.ts');
  await runBoundedDiagnostic(config, args.mode, args.outputPath!, args.priorPath);
}
if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) await main();
