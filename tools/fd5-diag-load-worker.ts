/** Isolated, streaming HTTP client for bounded diagnostics. No overload retry. */
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import type { HistoricalChange } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import { fetchDiagnosticClip, fetchDiagnosticInterface } from './fd5-diag-http.ts';

type Input = { url: string; token: string; slots: number; maxAttempts: number;
  sharedCount: SharedArrayBuffer; minRequestIntervalMs: number; requestTimeoutMs: number } & (
  { kind: 'clip'; corpus: HistoricalChange[] } | { kind: 'interface'; corpus: CorpusPage[] });

if (!parentPort) throw new Error('FD5 diagnostic load worker needs a parent');
const port = parentPort;
const input = workerData as Input;
const count = new Int32Array(input.sharedCount);
const abort = new AbortController();
let stopping = false, corpusExhausted = false, attemptLimitReached = false;
let next = 0, active = 0, maxConcurrentRequests = 0;
const startedAtNs = process.hrtime.bigint();

port.on('message', message => {
  if (message === 'stop') stopping = true;
  if (message === 'abort') { stopping = true; abort.abort(); }
});

function reserve(): boolean {
  while (true) {
    const previous = Atomics.load(count, 0);
    if (previous >= input.maxAttempts) { attemptLimitReached = true; return false; }
    if (Atomics.compareExchange(count, 0, previous, previous + 1) === previous) return true;
  }
}

async function slot(): Promise<void> {
  while (!stopping) {
    const item = input.corpus[next++];
    if (!item) { corpusExhausted = true; return; }
    if (!reserve()) return;
    active++;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, active);
    try {
      const onStart = (requestId: string, routeKey: string, atNs: bigint): void => {
        port.postMessage({ type: 'start', requestId, routeKey, kind: input.kind, startedAtNs: atNs });
      };
      const attempt = input.kind === 'clip' ? await fetchDiagnosticClip(input.url, input.token,
        item as HistoricalChange, input.requestTimeoutMs, abort.signal, onStart)
        : await fetchDiagnosticInterface(input.url, input.token, item as CorpusPage,
          input.requestTimeoutMs, abort.signal, onStart);
      port.postMessage({ type: 'attempt', kind: input.kind, attempt });
    } finally { active--; }
    if (input.minRequestIntervalMs) {
      try { await delay(input.minRequestIntervalMs, undefined, { signal: abort.signal }); }
      catch { return; }
    }
  }
}

try {
  if (!Number.isInteger(input.slots) || input.slots < 1 || !Number.isInteger(input.maxAttempts)
    || input.maxAttempts < 1 || !Number.isInteger(input.requestTimeoutMs) || input.requestTimeoutMs < 1)
    throw new Error('invalid bounded load worker configuration');
  port.postMessage({ type: 'ready' });
  await Promise.all(Array.from({ length: input.slots }, () => slot()));
  port.postMessage({ type: 'summary', summary: { startedAtNs, stoppedAtNs: process.hrtime.bigint(),
    maxConcurrentRequests, corpusExhausted, attemptLimitReached } });
} catch (error) {
  port.postMessage({ type: 'error', error: String(error) });
} finally { port.close(); }
