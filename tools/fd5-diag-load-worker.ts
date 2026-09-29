/** Isolated, streaming HTTP client for bounded diagnostics. No overload retry. */
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import type { HistoricalChange, ClipResponse } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import type { InterfaceAttempt } from './fd5-score.ts';

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
  if (message === 'stop') { stopping = true; abort.abort(); }
});

function reserve(): boolean {
  while (true) {
    const previous = Atomics.load(count, 0);
    if (previous >= input.maxAttempts) { attemptLimitReached = true; return false; }
    if (Atomics.compareExchange(count, 0, previous, previous + 1) === previous) return true;
  }
}

async function requestClip(change: HistoricalChange): Promise<ClipResponse & { requestId: string }> {
  const routeKey = `/v1/sessions/${change.sessionId}/changes/${change.seq}/clips`;
  const started = process.hrtime.bigint();
  const requestId = randomUUID();
  port.postMessage({ type: 'start', requestId, routeKey, kind: 'clip', startedAtNs: started });
  try {
    const response = await fetch(input.url + routeKey, { headers: { authorization: `Bearer ${input.token}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(input.requestTimeoutMs)]) });
    const body = await response.json().catch(() => null) as { status?: unknown; fallback_reason?: unknown } | null;
    const completedAtNs = process.hrtime.bigint();
    return { httpStatus: response.status, status: typeof body?.status === 'string' ? body.status : 'invalid-response',
      ...(typeof body?.fallback_reason === 'string' ? { reason: body.fallback_reason } : {}),
      latencyMs: Number(completedAtNs - started) / 1e6, routeKey, key: change.key, requestId,
      startedAtNs: started, completedAtNs };
  } catch (error) {
    const completedAtNs = process.hrtime.bigint();
    return { httpStatus: 0, status: 'request-error', error: String(error),
      latencyMs: Number(completedAtNs - started) / 1e6, routeKey, key: change.key, requestId,
      startedAtNs: started, completedAtNs };
  }
}

async function requestInterface(page: CorpusPage): Promise<InterfaceAttempt> {
  const startedAtNs = process.hrtime.bigint();
  const requestId = randomUUID();
  port.postMessage({ type: 'start', requestId, routeKey: page.expected.routeKey, kind: 'interface', startedAtNs });
  try {
    const response = await fetch(input.url + page.expected.routeKey,
      { headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(input.requestTimeoutMs)]) });
    const body: unknown = await response.json().catch(() => null);
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(),
      httpStatus: response.status, body };
  } catch (error) {
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(), error: String(error) };
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
      const attempt = input.kind === 'clip' ? await requestClip(item as HistoricalChange)
        : await requestInterface(item as CorpusPage);
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
