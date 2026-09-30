/** Bounded client-worker owner. An attempt starts before fetch and is retained even if the worker dies. */
import { Worker } from 'node:worker_threads';
import type { HistoricalChange, ClipResponse } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import type { InterfaceAttempt } from './fd5-score.ts';

export type DiagnosticAttempt = { kind: 'clip'; attempt: ClipResponse & { requestId: string } }
  | { kind: 'interface'; attempt: InterfaceAttempt };
export type DiagnosticLoadSummary = { startedAtNs: bigint; stoppedAtNs: bigint;
  maxConcurrentRequests: number; corpusExhausted: boolean; attemptLimitReached: boolean;
  actualWorkerExit: boolean; incompleteRequestIds: string[] };
export type DiagnosticLoad = { ready: Promise<void>; stop: (abortInFlight?: boolean) => Promise<DiagnosticLoadSummary>;
  attempts: DiagnosticAttempt[] };

export function startDiagnosticLoad(input: { kind: 'clip' | 'interface'; url: string; token: string;
  corpus: HistoricalChange[] | CorpusPage[]; slots: number; maxAttempts: number;
  sharedCount: SharedArrayBuffer; minRequestIntervalMs: number; requestTimeoutMs: number;
  onEvidence?: (evidence: unknown) => void }): DiagnosticLoad {
  const worker = new Worker(new URL('./fd5-diag-load-worker.ts', import.meta.url), { workerData: {
    kind: input.kind, url: input.url, token: input.token, corpus: input.corpus, slots: input.slots,
    maxAttempts: input.maxAttempts, sharedCount: input.sharedCount,
    minRequestIntervalMs: input.minRequestIntervalMs, requestTimeoutMs: input.requestTimeoutMs,
  } });
  const attempts: DiagnosticAttempt[] = [];
  const pending = new Set<string>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let exitResolve!: (code: number) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exit = new Promise<number>(resolve => { exitResolve = resolve; });
  let summary: Omit<DiagnosticLoadSummary, 'actualWorkerExit' | 'incompleteRequestIds'> | undefined;
  let error: Error | undefined;
  let readySeen = false;
  worker.on('message', (message: { type: string; requestId?: string; attempt?: DiagnosticAttempt['attempt'];
    summary?: typeof summary; error?: string }) => {
    if (message.type === 'ready') { readySeen = true; readyResolve(); }
    if (message.type === 'start' && message.requestId) {
      pending.add(message.requestId); input.onEvidence?.(message);
    }
    if (message.type === 'attempt' && message.attempt) {
      pending.delete(message.attempt.requestId);
      const attempt = { kind: input.kind, attempt: message.attempt } as DiagnosticAttempt;
      attempts.push(attempt); input.onEvidence?.({ type: 'attempt', ...attempt });
    }
    if (message.type === 'summary') { summary = message.summary; input.onEvidence?.(message); }
    if (message.type === 'error') { error = new Error(message.error); input.onEvidence?.(message); }
  });
  worker.on('error', cause => { error = cause; if (!readySeen) readyReject(cause); });
  worker.on('exit', code => {
    if (!readySeen) readyReject(new Error(`diagnostic load worker exited before ready (${code})`));
    exitResolve(code);
  });
  let stopping: Promise<DiagnosticLoadSummary> | undefined;
  return { ready, attempts, stop: (abortInFlight = false) => stopping ??= (async () => {
    worker.postMessage(abortInFlight ? 'abort' : 'stop');
    let code: number;
    try { code = await Promise.race([exit, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('diagnostic load worker exit timeout')),
        input.requestTimeoutMs + 1000);
      void exit.finally(() => clearTimeout(timer));
    })]); }
    catch (cause) { await worker.terminate(); throw cause; }
    if (code !== 0 || error || !summary) throw error ?? new Error(`diagnostic load worker exited ${code} without summary`);
    return { ...summary, actualWorkerExit: true, incompleteRequestIds: [...pending] };
  })() };
}
