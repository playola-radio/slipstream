/** HTTP attempts shared by the isolated diagnostic clients. */
import { randomUUID } from 'node:crypto';
import type { HistoricalChange, ClipResponse } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import type { InterfaceAttempt } from './fd5-score.ts';

export async function fetchDiagnosticClip(url: string, token: string, change: HistoricalChange,
  timeoutMs: number, signal: AbortSignal,
  onStart?: (requestId: string, routeKey: string, startedAtNs: bigint) => void):
  Promise<ClipResponse & { requestId: string }> {
  const routeKey = `/v1/sessions/${change.sessionId}/changes/${change.seq}/clips`;
  const startedAtNs = process.hrtime.bigint();
  const requestId = randomUUID();
  onStart?.(requestId, routeKey, startedAtNs);
  try {
    const response = await fetch(url + routeKey, { headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    const body = await response.json().catch(() => null) as { status?: unknown; fallback_reason?: unknown } | null;
    const completedAtNs = process.hrtime.bigint();
    return { httpStatus: response.status, status: typeof body?.status === 'string' ? body.status : 'invalid-response',
      ...(typeof body?.fallback_reason === 'string' ? { reason: body.fallback_reason } : {}),
      latencyMs: Number(completedAtNs - startedAtNs) / 1e6, routeKey, key: change.key, requestId,
      startedAtNs, completedAtNs };
  } catch (error) {
    const completedAtNs = process.hrtime.bigint();
    return { httpStatus: 0, status: 'request-error', error: String(error),
      latencyMs: Number(completedAtNs - startedAtNs) / 1e6, routeKey, key: change.key, requestId,
      startedAtNs, completedAtNs };
  }
}

export async function fetchDiagnosticInterface(url: string, token: string, page: CorpusPage,
  timeoutMs: number, signal: AbortSignal,
  onStart?: (requestId: string, routeKey: string, startedAtNs: bigint) => void): Promise<InterfaceAttempt> {
  const startedAtNs = process.hrtime.bigint();
  const requestId = randomUUID();
  onStart?.(requestId, page.expected.routeKey, startedAtNs);
  try {
    const response = await fetch(url + page.expected.routeKey,
      { headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    const body: unknown = await response.json().catch(() => null);
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(),
      httpStatus: response.status, body };
  } catch (error) {
    return { requestId, expected: page.expected, startedAtNs, completedAtNs: process.hrtime.bigint(), error: String(error) };
  }
}
