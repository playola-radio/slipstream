/** Isolated on-demand HTTP client for sequential and same-key diagnostic cells. */
import { parentPort } from 'node:worker_threads';
import type { HistoricalChange } from '../src/clip-bench.ts';
import type { CorpusPage } from './fd5-bench.ts';
import { fetchDiagnosticClip, fetchDiagnosticInterface } from './fd5-diag-http.ts';

if (!parentPort) throw new Error('diagnostic HTTP client needs a parent');
const port = parentPort;
const active = new Map<number, AbortController>();
let stopping = false;
function finishIfStopped(): void { if (stopping && active.size === 0) { port.postMessage({ type: 'stopped' }); port.close(); } }
port.on('message', (message: string | { type: string; id?: number; url?: string; token?: string;
  timeoutMs?: number; kind?: 'clip' | 'interface'; change?: HistoricalChange; page?: CorpusPage }) => {
  if (message === 'stop') { stopping = true; finishIfStopped(); return; }
  if (typeof message === 'string') return;
  if (message.type === 'stop') { stopping = true; finishIfStopped(); return; }
  if (message.type === 'cancel') { if (message.id !== undefined) active.get(message.id)?.abort(); return; }
  if (message.type !== 'request' || stopping || message.id === undefined || active.has(message.id)
    || !message.url || !message.token || !message.timeoutMs) return;
  const controller = new AbortController();
  active.set(message.id, controller);
  const id = message.id;
  const work = message.kind === 'clip' && message.change
    ? fetchDiagnosticClip(message.url, message.token, message.change, message.timeoutMs, controller.signal)
    : message.kind === 'interface' && message.page
      ? fetchDiagnosticInterface(message.url, message.token, message.page, message.timeoutMs, controller.signal)
      : Promise.reject(new Error('invalid diagnostic HTTP request'));
  void work.then(attempt => port.postMessage({ type: 'result', id, attempt }), error =>
    port.postMessage({ type: 'error', id, error: String(error) }))
    .finally(() => { active.delete(id); finishIfStopped(); });
});
port.postMessage({ type: 'ready' });
