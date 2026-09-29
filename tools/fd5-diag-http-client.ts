/** Parent-side owner for the isolated on-demand diagnostic HTTP client. */
import { Worker } from 'node:worker_threads';
import type { HistoricalChange, ClipResponse } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import type { InterfaceAttempt } from './fd5-score.ts';

export interface DiagnosticHttpClient {
  ready: Promise<void>;
  interface(url: string, token: string, page: CorpusPage, timeoutMs: number,
    signal: AbortSignal): Promise<InterfaceAttempt>;
  clip(url: string, token: string, change: HistoricalChange, timeoutMs: number,
    signal: AbortSignal): Promise<ClipResponse & { requestId: string }>;
  stop(): Promise<void>;
}
export function startDiagnosticHttpClient(): DiagnosticHttpClient {
  const worker = new Worker(new URL('./fd5-diag-http-rpc-worker.ts', import.meta.url));
  let nextId = 0, stopped = false, readySeen = false;
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void;
    signal: AbortSignal; onAbort: () => void }>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void, exitResolve!: (code: number) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exit = new Promise<number>(resolve => { exitResolve = resolve; });
  worker.on('message', (message: { type: string; id?: number; attempt?: unknown; error?: string }) => {
    if (message.type === 'ready') { readySeen = true; readyResolve(); return; }
    if (message.id === undefined) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    item.signal.removeEventListener('abort', item.onAbort);
    if (message.type === 'result') item.resolve(message.attempt as never);
    else item.reject(new Error(message.error ?? 'diagnostic HTTP client failed'));
  });
  worker.on('error', error => {
    if (!readySeen) readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  });
  worker.on('exit', code => {
    if (!readySeen) readyReject(new Error(`diagnostic HTTP client exited before ready (${code})`));
    for (const item of pending.values()) item.reject(new Error(`diagnostic HTTP client exited ${code}`));
    pending.clear();
    exitResolve(code);
  });
  function request<T>(kind: 'clip' | 'interface', url: string, token: string,
    payload: { change: HistoricalChange } | { page: CorpusPage }, timeoutMs: number, signal: AbortSignal): Promise<T> {
    if (stopped || signal.aborted) return Promise.reject(signal.reason ?? new Error('diagnostic HTTP client stopped'));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => worker.postMessage({ type: 'cancel', id });
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { resolve: resolve as (value: never) => void, reject, signal, onAbort });
      worker.postMessage({ type: 'request', id, kind, url, token, timeoutMs, ...payload });
    });
  }
  let stopPromise: Promise<void> | undefined;
  return { ready,
    interface: (url, token, page, timeoutMs, signal) =>
      request('interface', url, token, { page }, timeoutMs, signal),
    clip: (url, token, change, timeoutMs, signal) =>
      request('clip', url, token, { change }, timeoutMs, signal),
    stop: () => stopPromise ??= (async () => {
      stopped = true;
      worker.postMessage('stop');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let code: number;
      try { code = await Promise.race([exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic HTTP client exit timeout')), 5000);
      })]); }
      catch (error) { await worker.terminate(); throw error; }
      finally { if (timer) clearTimeout(timer); }
      if (code !== 0) throw new Error(`diagnostic HTTP client exited ${code}`);
    })(),
  };
}
