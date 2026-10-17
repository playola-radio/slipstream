/**
 * The measured process for the auto-capture overhead bench: one store lock, the
 * real shared reader, and N CaptureSessions, all in one Node process, driven by
 * the parent (cli.ts) over IPC. The daemon's control server is not started (no
 * control traffic during the measured windows); that omission is disclosed.
 *
 * Probes are installed before any product module loads, so every product import
 * below is dynamic.
 */
import { readdirSync } from 'node:fs';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { configureProbeRoots, installProbes, readProbeCounters, resetProbeCounters } from './probes.ts';

await installProbes();
const { startCapture } = await import('../../src/session.ts');
const { acquireSessionLock } = await import('../../src/lock.ts');
const { startReaderServer } = await import('../../src/http-reader.ts');
const { createBoundaryRegistry } = await import('../../src/boundary-registry.ts');
const { liveBoundary } = await import('../../src/reader-runtime.ts');
type CaptureSession = Awaited<ReturnType<typeof startCapture>>;
type CaptureOptions = Parameters<typeof startCapture>[0];

export type Request =
  | { op: 'init'; storeDir: string; roots: { worktrees: string; store: string; transcripts: string } }
  | { op: 'start'; root: string; sessionId: string; storeDir?: string;
      transcript?: CaptureOptions['transcript']; enrichmentPolicy?: CaptureOptions['enrichmentPolicy'] }
  | { op: 'stopSession'; sessionId: string }
  | { op: 'track'; sessionIds: string[] }
  | { op: 'timeline' }
  | { op: 'snapshot' }
  | { op: 'reset' }
  | { op: 'eld'; on: boolean }
  | { op: 'baselineLoop'; roots: string[] }
  | { op: 'stopBaselineLoop' }
  | { op: 'shutdown' };

const registry = createBoundaryRegistry();
const sessions = new Map<string, CaptureSession>();
const compromised: string[] = [];
let storeLock: Awaited<ReturnType<typeof acquireSessionLock>> | undefined;
let reader: Awaited<ReturnType<typeof startReaderServer>> | undefined;
let defaultStore = '';
let tracked = new Set<string>();
let timeline: { sessionId: string; seq: string; ns: string }[] = [];
let eld: IntervalHistogram | undefined;
type BaselineRun = { root: string; ms: number; startNs: string; endNs: string };
let loop: { state: { stop: boolean }; done: Promise<{ runs: BaselineRun[]; error?: string }> } | undefined;

async function start(req: Extract<Request, { op: 'start' }>): Promise<{ ms: number; logPath: string }> {
  registry.reserve(req.sessionId);
  const t0 = performance.now();
  const session = await startCapture({
    root: req.root,
    storeDir: req.storeDir ?? defaultStore,
    sessionId: req.sessionId,
    onCompromised: (reason) => compromised.push(`${req.sessionId}: ${reason}`),
    ...(req.enrichmentPolicy ? { enrichmentPolicy: req.enrichmentPolicy } : {}),
    ...(req.transcript ? { transcript: req.transcript } : {}),
  });
  const ms = performance.now() - t0;
  sessions.set(req.sessionId, session);
  registry.activate(req.sessionId, liveBoundary(session.health));
  session.health.subscribe(() => {
    if (tracked.has(req.sessionId)) {
      timeline.push({ sessionId: req.sessionId, seq: session.health.snapshot().durable_seq, ns: process.hrtime.bigint().toString() });
    }
  });
  return { ms, logPath: session.logPath };
}

async function stopSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`unknown session ${id}`);
  await session.stop();
  sessions.delete(id);
  registry.freeze(id, BigInt(session.health.snapshot().durable_seq));
}

/** Each run spans start through stop, so the parent can test which of its
 * writes landed while a baseline was in flight. A failure ends the loop and is
 * reported with the runs so far rather than thrown into the void. */
async function baselineLoop(roots: string[], state: { stop: boolean }): Promise<{ runs: BaselineRun[]; error?: string }> {
  const runs: BaselineRun[] = [];
  try {
    for (let i = 0; !state.stop; i++) {
      const root = roots[i % roots.length]!;
      const sessionId = crypto.randomUUID();
      const startNs = process.hrtime.bigint();
      const { ms } = await start({ op: 'start', root, sessionId });
      await stopSession(sessionId);
      runs.push({ root, ms, startNs: startNs.toString(), endNs: process.hrtime.bigint().toString() });
    }
    return { runs };
  } catch (err) {
    return { runs, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

function snapshot() {
  const health: Record<string, number> = {};
  let durableSeqTotal = 0n;
  for (const s of sessions.values()) {
    const snap = s.health.snapshot();
    health[snap.state] = (health[snap.state] ?? 0) + 1;
    durableSeqTotal += BigInt(snap.durable_seq);
  }
  return {
    hrtimeNs: process.hrtime.bigint().toString(),
    counters: readProbeCounters(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    resource: process.resourceUsage(),
    fds: readdirSync('/dev/fd').length,
    sessions: sessions.size,
    health,
    durableSeqTotal: durableSeqTotal.toString(),
    compromised: [...compromised],
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'init':
      defaultStore = req.storeDir;
      configureProbeRoots(req.roots);
      storeLock = await acquireSessionLock(req.storeDir, { onCompromised: (r) => compromised.push(`store: ${r}`) });
      reader = await startReaderServer({ storeDir: req.storeDir, registry });
      return { pid: process.pid };
    case 'start': return start(req);
    case 'stopSession': await stopSession(req.sessionId); return {};
    case 'track': tracked = new Set(req.sessionIds); timeline = []; return {};
    case 'timeline': { const t = timeline; timeline = []; tracked = new Set(); return t; }
    case 'snapshot': return snapshot();
    case 'reset': resetProbeCounters(); return {};
    case 'eld':
      if (req.on) { eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable(); return {}; }
      if (!eld) throw new Error('event-loop delay monitor was not started');
      eld.disable();
      { const h = eld; eld = undefined;
        return { p50Ms: h.percentile(50) / 1e6, p99Ms: h.percentile(99) / 1e6, maxMs: h.max / 1e6, meanMs: h.mean / 1e6 }; }
    case 'baselineLoop': {
      const state = { stop: false };
      loop = { state, done: baselineLoop(req.roots, state) };
      return {};
    }
    case 'stopBaselineLoop': {
      if (!loop) throw new Error('no baseline loop running');
      loop.state.stop = true;
      const result = await loop.done;
      loop = undefined;
      return result;
    }
    case 'shutdown':
      for (const id of [...sessions.keys()]) await stopSession(id);
      await reader?.close();
      await storeLock?.release();
      setImmediate(() => process.exit(0));
      return {};
  }
}

process.on('message', (msg: { id: number; req: Request }) => {
  handle(msg.req).then(
    (result) => process.send!({ id: msg.id, ok: true, result }),
    (err: Error) => process.send!({ id: msg.id, ok: false, error: `${err.name}: ${err.message}` }),
  );
});
process.send!({ ready: true });
