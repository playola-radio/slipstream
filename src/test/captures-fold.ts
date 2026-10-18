import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A second, independent reader of the capture table: the contracts.md §6 fold
 * computed only from what a client without the daemon can read — the intent
 * record (§8), each session log, and each ownership heartbeat (§7). It shares no
 * code with the daemon's projection, so agreement between the two is evidence
 * that the public files alone carry every public state.
 */

const STALE_MS = 12_000;

type Rec = { type: string; data: Record<string, unknown> };
type CaptureIntent = { session_id: string; root: string; intent: string; withdrawn_reason: string | null;
  capture_mode: string | null; last_failure: { reason: string; next_attempt_at_ms: number | null } | null };
type BindingIntent = { session_id: string; harness: string; harness_session_id: string; binding_generation: string;
  intent: string; unavailable: { reason: string; message: string } | null };

async function logOf(store: string, id: string): Promise<Rec[] | null> {
  let text: string;
  try { text = await readFile(join(store, 'sessions', id, 'events.jsonl'), 'utf8'); } catch { return null; }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Rec);
}

async function heartbeatOf(store: string, id: string): Promise<number | null> {
  try { return Math.trunc((await stat(join(store, 'sessions', id, 'owner.lock'))).mtimeMs); } catch { return null; }
}

const t = (name: string) => `slipstream.${name}.v1`;

export async function foldCaptures(store: string, asOfMs: number): Promise<Record<string, unknown>> {
  const intent = JSON.parse(await readFile(join(store, 'control', 'intent.json'), 'utf8')) as {
    captures: CaptureIntent[]; bindings: BindingIntent[] };
  const captures = await Promise.all(intent.captures.map(async (c) => {
    const log = await logOf(store, c.session_id);
    const begun = log?.findLastIndex((r) => r.type === t('session.started') || r.type === t('session.resumed')) ?? -1;
    const activation = log && begun >= 0 ? log.slice(begun) : [];
    const stop = activation.findLast((r) => r.type === t('capture.stopped'));
    const heartbeat = await heartbeatOf(store, c.session_id);
    const live = heartbeat !== null && asOfMs - heartbeat <= STALE_MS;
    let state: string; let reason: string | null = null;
    if (c.intent === 'withdrawn') {
      if (stop) [state, reason] = ['stopped', String(stop.data.reason)];
      else if (log === null) [state, reason] = ['stopped', c.withdrawn_reason];
      else [state, reason] = ['not_recording', 'stop-unconfirmed'];
    } else if (c.intent === 'waiting') [state, reason] = ['not_recording', 'capture-limit-reached'];
    else if (stop) [state, reason] = ['stopped', String(stop.data.reason)];
    else if (c.last_failure) [state, reason] = ['not_recording', c.last_failure.reason];
    else if (!live) [state, reason] = ['not_recording', 'daemon-unavailable'];
    else if (begun < 0) state = 'queued';
    else state = activation.some((r) => r.type === t('capture.ready')) ? 'recording' : 'baselining';
    const next = c.intent === 'running' ? c.last_failure?.next_attempt_at_ms : null;
    return { session_id: c.session_id, root: c.root, state, reason,
      retry: typeof next === 'number' ? { next_attempt_at_ms: next } : null,
      capture_mode: c.capture_mode, binding: bindingOf(intent.bindings, c.session_id, activation) };
  }));
  return { binding_slots: { used: intent.bindings.filter((b) => b.intent === 'linked').length, limit: 10 }, captures };
}

function bindingOf(bindings: BindingIntent[], id: string, activation: Rec[]): Record<string, unknown> | null {
  const b = bindings.findLast((entry) => entry.session_id === id);
  if (!b) return null;
  const row = { harness: b.harness, harness_session_id: b.harness_session_id, binding_generation: b.binding_generation };
  if (b.intent === 'revoked') return { ...row, state: 'unlinked', reason: null };
  if (b.unavailable) return { ...row, state: 'unavailable', reason: b.unavailable.reason, message: b.unavailable.message };
  const latest = activation.findLast((r) => r.type === t('agent.connection') && r.data.binding_generation === b.binding_generation);
  return { ...row, state: latest?.data.state ?? 'setup_pending', reason: null };
}

/** `GET /v1/captures` reduced to the fields the fold computes, rows by session id. */
export function comparable(projection: Record<string, unknown>): Record<string, unknown> {
  const rows = (projection.captures as Record<string, unknown>[])
    .map(({ heartbeat_ms: _h, ...row }) => row)
    .sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));
  return { binding_slots: projection.binding_slots, captures: rows };
}

/** Fetch `/v1/captures` and fold the store at the projection's own `as_of_ms`. */
export async function bothReaders(store: string, readerUrl: string, token: string):
  Promise<{ projection: Record<string, unknown>; fold: Record<string, unknown> }> {
  const res = await fetch(`${readerUrl}/v1/captures`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 200) throw new Error(`/v1/captures answered ${res.status}`);
  const projection = await res.json() as Record<string, unknown>;
  return { projection: comparable(projection), fold: comparable(await foldCaptures(store, projection.as_of_ms as number)) };
}
