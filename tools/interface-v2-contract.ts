/**
 * `projection-check interface-v2-contract`: validates the hand-written
 * `interface.v2` fixtures under contracts/interface/v2/cases/ (FUNCTION-CHANGES.md
 * §5.3). It proves shape and internal consistency, never extractor correctness:
 * every expected envelope validates against the schema, obeys the cross-field
 * invariants src/schema.ts cannot express, and agrees with its recorded history
 * (endpoint provenance, hashes, sizes, UTF-8 span boundaries). FD1–FD3 prove
 * correctness by reproducing the same cases.
 *
 * A case directory holds `history.json`, `request.txt`, and exactly one of
 * `expected.json` (a 200 body) or `expected-error.json` (`{http_status, headers?}`).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadAllSchemas, validate, type JsonSchema } from '../src/schema.ts';
import { SOURCE_PREFIX } from '../src/event.ts';

const CONTRACT_DIR = fileURLToPath(new URL('../contracts/interface/v2/', import.meta.url));
const CASES_DIR = join(CONTRACT_DIR, 'cases');

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2 } as const;
const SEQ = /^[1-9][0-9]*$/;
const CUTOFF = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LIMIT = 16;
const REQUEST_PARAMS = ['before_seq', 'after_seq', 'limit', 'path_prefix', 'after_path', 'include_identical'];
const ERROR_STATUSES = [400, 401, 404, 409, 410, 500];
const ROW_KIND_ORDER = ['removed', 'signatureChanged', 'added'];
const INCOMPLETE_REASONS = [
  'before-parse-error', 'before-unsupported-construct',
  'after-parse-error', 'after-unsupported-construct',
  'duplicate-declaration', 'ambiguous-correspondence',
];
const SKIPPED_FILE_REASONS = ['too-large', 'timeout', 'cancelled'];

type Obj = Record<string, unknown>;

export interface FixtureCase {
  name: string;
  history: unknown;
  request: string;
  expected?: unknown;
  expectedError?: unknown;
}

export interface Request {
  sessionId: string;
  before: bigint;
  after: bigint;
  limit: number;
  pathPrefix: string;
  afterPath: string | null;
  includeIdentical: boolean;
}

interface History {
  sessionId: string;
  durableSeq: bigint;
  events: Obj[];
  bySeq: Map<string, Obj>;
  blobs: Map<string, Uint8Array>;
  missing: Set<string>;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function extraKeys(o: Obj, allowed: readonly string[], where: string, errors: string[]): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) errors.push(`${where}: unexpected property '${key}'`);
}

/** The exact query-string grammar of `GET /v1/sessions/:id/interfaces`. Returns
 * the parsed request, or a reason it is malformed (the server's 400). */
export function parseRequest(text: string): Request | string {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  const match = /^GET \/v1\/sessions\/([^/?\s]+)\/interfaces\?(\S*)$/.exec(line);
  if (!match) return 'not a single GET /v1/sessions/:session_id/interfaces line';
  const [, rawSession = '', query = ''] = match;
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return `malformed parameter '${pair}'`;
    const key = pair.slice(0, eq);
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return `undecodable value for '${key}'`;
    }
    if (!REQUEST_PARAMS.includes(key)) return `unknown parameter '${key}'`;
    if (params.has(key)) return `duplicate parameter '${key}'`;
    params.set(key, value);
  }
  const before = params.get('before_seq');
  const after = params.get('after_seq');
  if (before === undefined || after === undefined) return 'before_seq and after_seq are required';
  if (!CUTOFF.test(before) || !CUTOFF.test(after)) return 'cutoffs must be canonical decimal strings';
  if (BigInt(before) > BigInt(after)) return 'before_seq is greater than after_seq';
  const limitText = params.get('limit') ?? String(MAX_LIMIT);
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > MAX_LIMIT) return `limit must be 1..${MAX_LIMIT}`;
  const pathPrefix = params.get('path_prefix') ?? '';
  if (pathPrefix.startsWith('/') || pathPrefix.includes('\0') || pathPrefix.split('/').includes('..')) {
    return 'unsafe path_prefix';
  }
  const identical = params.get('include_identical');
  if (identical !== undefined && identical !== 'true') return "include_identical must be 'true' when present";
  return {
    sessionId: decodeURIComponent(rawSession),
    before: BigInt(before),
    after: BigInt(after),
    limit: Number(limitText),
    pathPrefix,
    afterPath: params.get('after_path') ?? null,
    includeIdentical: identical === 'true',
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function snapshotsOf(event: Obj): Obj[] {
  const data = event.data as Obj;
  if (event.type === 'slipstream.file.baselined.v1') return [data.snapshot as Obj];
  if (event.type === 'slipstream.file.changed.v1') return [data.before as Obj, data.after as Obj];
  return [];
}

function checkHistory(raw: unknown, schemas: Map<string, JsonSchema>, errors: string[]): History | null {
  if (!isObj(raw)) {
    errors.push('history: must be an object');
    return null;
  }
  extraKeys(raw, ['session_id', 'durable_seq', 'events', 'blobs', 'missing_blobs', 'harness'], 'history', errors);
  if (typeof raw.session_id !== 'string') errors.push('history.session_id: must be a string');
  if (typeof raw.durable_seq !== 'string' || !CUTOFF.test(raw.durable_seq)) errors.push('history.durable_seq: must be a decimal string');
  if (!Array.isArray(raw.events)) errors.push('history.events: must be an array');
  if (!isObj(raw.blobs)) errors.push('history.blobs: must be an object of sha256 → UTF-8 text');
  const missingList = raw.missing_blobs ?? [];
  if (!Array.isArray(missingList) || !missingList.every((s) => typeof s === 'string' && SHA256.test(s))) {
    errors.push('history.missing_blobs: must be an array of sha256 strings');
  }
  if (errors.length > 0) return null;

  const sessionId = raw.session_id as string;
  const events = raw.events as unknown[];
  const history: History = {
    sessionId,
    durableSeq: BigInt(raw.durable_seq as string),
    events: [],
    bySeq: new Map(),
    blobs: new Map(),
    missing: new Set(missingList as string[]),
  };

  let previous = 0n;
  events.forEach((event, i) => {
    const where = `history.events[${i}]`;
    if (!isObj(event) || typeof event.type !== 'string' || !schemas.has(event.type)) {
      errors.push(`${where}: not an event of a known public type`);
      return;
    }
    for (const e of validate(schemas.get(event.type)!, event)) errors.push(`${where}: ${e}`);
    if (typeof event.seq !== 'string' || !SEQ.test(event.seq)) return;
    const seq = BigInt(event.seq);
    if (seq <= previous) errors.push(`${where}: seq ${event.seq} is not strictly increasing`);
    previous = seq;
    if (event.id !== event.seq) errors.push(`${where}: id must equal seq`);
    if (event.source !== `${SOURCE_PREFIX}${sessionId}`) errors.push(`${where}: source does not name the history session`);
    if (!isObj(event.data) || event.data.session_id !== sessionId) errors.push(`${where}: data.session_id does not match the history session`);
    history.events.push(event);
    history.bySeq.set(event.seq, event);
  });
  if (previous > history.durableSeq) errors.push('history.durable_seq: is below the last event seq');

  const referenced = new Set<string>();
  for (const [key, text] of Object.entries(raw.blobs as Obj)) {
    if (typeof text !== 'string') {
      errors.push(`history.blobs.${key}: must be UTF-8 text`);
      continue;
    }
    const bytes = new TextEncoder().encode(text);
    if (sha256(bytes) !== key) errors.push(`history.blobs.${key}: key is not the sha256 of its bytes`);
    if (history.missing.has(key)) errors.push(`history.blobs.${key}: also listed in missing_blobs`);
    history.blobs.set(key, bytes);
  }
  for (const event of history.events) {
    for (const snapshot of snapshotsOf(event)) {
      if (snapshot?.kind !== 'content') continue;
      const key = snapshot.sha256 as string;
      referenced.add(key);
      const bytes = history.blobs.get(key);
      if (bytes === undefined && !history.missing.has(key)) {
        errors.push(`history: seq ${event.seq as string} references ${key}, which is neither stored nor declared missing`);
      }
      if (bytes !== undefined && bytes.length !== snapshot.size) {
        errors.push(`history: seq ${event.seq as string} records size ${String(snapshot.size)} for ${key}, but the blob has ${bytes.length} bytes`);
      }
    }
  }
  for (const key of [...history.blobs.keys(), ...history.missing]) {
    if (!referenced.has(key)) errors.push(`history: blob ${key} is not referenced by any event`);
  }
  checkHarness(raw.harness, errors);
  return history;
}

/** Test-only execution conditions a static history cannot express. */
function checkHarness(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!isObj(raw)) {
    errors.push('history.harness: must be an object');
    return;
  }
  extraKeys(raw, ['admission', 'interrupt', 'limits'], 'history.harness', errors);
  if (raw.admission !== undefined && raw.admission !== 'overloaded') errors.push("history.harness.admission: must be 'overloaded'");
  if (raw.interrupt !== undefined) {
    const i = raw.interrupt;
    if (!isObj(i) || typeof i.at_path !== 'string' || !['timeout', 'cancelled'].includes(i.reason as string)) {
      errors.push("history.harness.interrupt: must be {at_path, reason: 'timeout' | 'cancelled'}");
    } else {
      extraKeys(i, ['at_path', 'reason'], 'history.harness.interrupt', errors);
    }
  }
  if (raw.limits !== undefined) {
    const l = raw.limits;
    if (!isObj(l)) {
      errors.push('history.harness.limits: must be an object');
      return;
    }
    extraKeys(l, ['response_bytes', 'metadata_bytes'], 'history.harness.limits', errors);
    for (const [key, value] of Object.entries(l)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        errors.push(`history.harness.limits.${key}: must be a non-negative integer`);
      }
    }
  }
}

/** Whitespace-insensitive equality: `op: equal` compares token sequences, and
 * the display text may differ only in whitespace. */
function sameTokens(a: unknown, b: unknown): boolean {
  const strip = (v: unknown): unknown =>
    typeof v === 'string' ? v.replace(/\s+/g, '')
      : Array.isArray(v) ? v.map(strip)
      : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]))
      : v;
  return isDeepStrictEqual(strip(a), strip(b));
}

function checkDelta(delta: Obj, where: string, errors: string[]): void {
  const { op, before, after } = delta;
  if (op === 'added' && (before !== null || after === null)) errors.push(`${where}: added needs before null and after present`);
  if (op === 'removed' && (before === null || after !== null)) errors.push(`${where}: removed needs before present and after null`);
  if (op === 'equal' || op === 'changed') {
    if (before === null || after === null) {
      errors.push(`${where}: ${op as string} needs both sides`);
      return;
    }
    const same = sameTokens(before, after);
    if (op === 'equal' && !same) errors.push(`${where}: equal but the sides differ`);
    if (op === 'changed' && same) errors.push(`${where}: changed but the sides are equal`);
  }
}

function checkSpan(span: Obj, blob: Uint8Array | undefined, where: string, errors: string[]): void {
  if (blob === undefined) {
    errors.push(`${where}: a span needs this side's content blob`);
    return;
  }
  const start = span.byte_start as number;
  const end = span.byte_end as number;
  if (start > end || end > blob.length) {
    errors.push(`${where}: [${start}, ${end}) is outside the ${blob.length}-byte blob`);
    return;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(blob.subarray(start, end));
  } catch {
    errors.push(`${where}: [${start}, ${end}) does not slice whole UTF-8 characters`);
  }
}

function checkParameters(rows: Obj[], where: string, errors: string[]): void {
  const beforeRows = rows.filter((r) => r.before !== null);
  const addedRows = rows.slice(beforeRows.length);
  if (addedRows.some((r) => r.op !== 'added')) errors.push(`${where}: rows with a before side must precede added rows`);
  const positions = (list: Obj[], side: 'before' | 'after'): number[] => list.map((r) => (r[side] as Obj).position as number);
  const ascending = (p: number[]): boolean => p.every((v, i) => i === 0 || (p[i - 1] as number) < v);
  if (!ascending(positions(beforeRows, 'before'))) errors.push(`${where}: before-side rows are not in before-position order`);
  if (!ascending(positions(addedRows, 'after'))) errors.push(`${where}: added rows are not in after-position order`);

  for (const side of ['before', 'after'] as const) {
    const present = rows.filter((r) => r[side] !== null).map((r) => r[side] as Obj);
    const sorted = present.map((p) => p.position as number).sort((a, b) => a - b);
    if (!sorted.every((p, i) => p === i)) errors.push(`${where}: ${side} positions are not exactly 0..${present.length - 1}`);
  }

  const names = (side: 'before' | 'after'): string[] =>
    rows.filter((r) => r[side] !== null).map((r) => r[side] as Obj).filter((p) => p.binding === 'identifier').map((p) => p.name as string);
  const beforeNames = names('before');
  const afterNames = names('after');
  const unique = (list: string[], n: string): boolean => list.filter((x) => x === n).length === 1;
  rows.forEach((r, i) => {
    if (r.before === null || r.after === null) return;
    const b = r.before as Obj;
    const a = r.after as Obj;
    const keyed = b.binding === 'identifier' && a.binding === 'identifier' && b.name === a.name;
    if (!keyed || !unique(beforeNames, b.name as string) || !unique(afterNames, a.name as string)) {
      errors.push(`${where}[${i}]: pairs parameters without a unique shared local name`);
    }
  });
  const pairable = (n: string): boolean => unique(beforeNames, n) && unique(afterNames, n);
  const unpairedBefore = rows.filter((r) => r.op === 'removed').map((r) => r.before as Obj);
  for (const p of unpairedBefore) {
    if (p.binding === 'identifier' && pairable(p.name as string)) errors.push(`${where}: '${p.name as string}' is removed but has a unique match to pair with`);
  }
}

function checkChange(change: Obj, blobs: { before?: Uint8Array; after?: Uint8Array }, where: string, errors: string[]): void {
  const kind = change.kind;
  const deltas: Array<[string, Obj]> = [
    ...((change.parameters as Obj[]).map((p, i) => [`${where}.parameters[${i}]`, p] as [string, Obj])),
    ...(change.result === null ? [] : [[`${where}.result`, change.result as Obj] as [string, Obj]]),
    [`${where}.throws`, change.throws as Obj],
    [`${where}.header`, change.header as Obj],
  ];
  for (const [w, d] of deltas) checkDelta(d, w, errors);
  if (kind === 'added' || kind === 'removed') {
    const [present, missing] = kind === 'added' ? ['after', 'before'] : ['before', 'after'];
    if (change[missing] !== null || change[present] === null) errors.push(`${where}: ${kind} row needs ${missing} null and ${present} present`);
    for (const [w, d] of deltas) if (d.op !== kind) errors.push(`${w}: every component of an ${kind} row must be ${kind}`);
  } else {
    if (change.before === null || change.after === null) errors.push(`${where}: signatureChanged needs both sides`);
    if (deltas.every(([, d]) => d.op === 'equal')) errors.push(`${where}: signatureChanged with every component equal`);
  }
  checkParameters(change.parameters as Obj[], `${where}.parameters`, errors);
  for (const side of ['before', 'after'] as const) {
    const decl = change[side];
    if (isObj(decl)) checkSpan(decl.span as Obj, blobs[side], `${where}.${side}.span`, errors);
  }
}

/** The coverage a side's endpoint forces, independent of extraction outcome. */
function forcedCoverage(endpoint: Obj, history: History): Obj | null {
  if (endpoint.kind === 'unknownBoundary') return { state: 'unavailable', reason: 'unknown-boundary' };
  const snapshot = endpoint.snapshot as Obj;
  if (snapshot.kind === 'absent') return { state: 'absent' };
  if (snapshot.kind === 'unavailable') return { state: 'unavailable', reason: snapshot.reason };
  if (history.missing.has(snapshot.sha256 as string)) return { state: 'unavailable', reason: 'blob-missing' };
  return null;
}

function checkEndpoint(endpoint: Obj, side: 'before' | 'after', path: string, req: Request, history: History, where: string, errors: string[]): void {
  if (endpoint.kind === 'unknownBoundary') {
    if (side === 'after') errors.push(`${where}: only a before endpoint can be an unknown boundary`);
    const earlier = history.events.some((e) => (e.data as Obj).path === path && snapshotsOf(e).length > 0 && BigInt(e.seq as string) <= req.before);
    if (earlier) errors.push(`${where}: unknown boundary although the path has a record at or before before_seq`);
    return;
  }
  const record = history.bySeq.get(endpoint.record_seq as string);
  if (record === undefined || (record.data as Obj).path !== path) {
    errors.push(`${where}: record_seq ${endpoint.record_seq as string} is not a record for ${path}`);
    return;
  }
  const seq = BigInt(endpoint.record_seq as string);
  const cutoff = side === 'before' ? req.before : req.after;
  const firstChangeRule = side === 'before' && endpoint.field === 'before' && seq > req.before && seq <= req.after;
  if (seq > cutoff && !firstChangeRule) errors.push(`${where}: record_seq is after the ${side} cutoff`);
  const data = record.data as Obj;
  const isChanged = record.type === 'slipstream.file.changed.v1';
  const expectedField = isChanged ? ['before', 'after'] : ['snapshot'];
  if (!expectedField.includes(endpoint.field as string)) {
    errors.push(`${where}: field ${endpoint.field as string} does not exist on ${record.type as string}`);
    return;
  }
  if (!isDeepStrictEqual(endpoint.snapshot, data[endpoint.field as string])) errors.push(`${where}: snapshot differs from the recorded ${endpoint.field as string}`);
  if (endpoint.observation !== (isChanged ? data.observation : undefined)) errors.push(`${where}: observation must copy the file.changed record`);
  if (endpoint.gap_ref !== (isChanged ? data.gap_ref : undefined)) errors.push(`${where}: gap_ref must copy the file.changed record`);
}

function endpointsEqual(before: Obj, after: Obj): boolean {
  if (before.kind !== 'recorded' || after.kind !== 'recorded') return false;
  const b = before.snapshot as Obj;
  const a = after.snapshot as Obj;
  if (b.kind === 'absent' && a.kind === 'absent') return true;
  return b.kind === 'content' && a.kind === 'content' && b.sha256 === a.sha256;
}

function checkFile(file: Obj, req: Request, history: History, where: string, errors: string[]): void {
  const path = file.path as string;
  const status = file.status as string;
  const reason = file.fallback_reason as string | undefined;
  const before = file.before as Obj;
  const after = file.after as Obj;
  const coverage = file.coverage as Record<'before' | 'after', Obj>;
  const changes = file.changes as Obj[];

  if (!path.startsWith(req.pathPrefix)) errors.push(`${where}: path is outside path_prefix`);
  if (req.afterPath !== null && !(path > req.afterPath)) errors.push(`${where}: path is not after after_path`);
  checkEndpoint(before, 'before', path, req, history, `${where}.before`, errors);
  checkEndpoint(after, 'after', path, req, history, `${where}.after`, errors);

  const needsReason = ['incomplete', 'unavailable', 'unsupported', 'skipped'].includes(status);
  if (needsReason !== (reason !== undefined)) errors.push(`${where}: fallback_reason must be present exactly for incomplete/unavailable/unsupported/skipped`);
  if (status !== 'ready' && changes.length > 0) errors.push(`${where}: only a ready file may carry changes`);
  if ((file.language === null) !== (file.language_version === null)) errors.push(`${where}: language and language_version must be null together`);

  for (const side of ['before', 'after'] as const) {
    const cov = coverage[side];
    const hasReason = cov.reason !== undefined;
    if (hasReason !== ['incomplete', 'unavailable'].includes(cov.state as string)) {
      errors.push(`${where}.coverage.${side}: reason must be present exactly for incomplete/unavailable`);
    }
    const forced = forcedCoverage(side === 'before' ? before : after, history);
    if (forced !== null && !isDeepStrictEqual(cov, forced)) errors.push(`${where}.coverage.${side}: must be ${JSON.stringify(forced)} for this endpoint`);
    if (forced === null && !['complete', 'incomplete', 'unsupported', 'notEvaluated'].includes(cov.state as string)) {
      errors.push(`${where}.coverage.${side}: a retained content side cannot be ${cov.state as string}`);
    }
  }

  const equal = endpointsEqual(before, after) && forcedCoverage(before, history)?.state !== 'unavailable';
  if (equal !== (status === 'identical')) errors.push(`${where}: status must be identical exactly when the endpoints are equal and retained`);
  if (status === 'identical') {
    const state = ((before.snapshot as Obj).kind === 'absent') ? 'absent' : 'notEvaluated';
    if (coverage.before.state !== state || coverage.after.state !== state) errors.push(`${where}: identical coverage must be ${state} on both sides`);
    if (!req.includeIdentical) errors.push(`${where}: identical results are listed only with include_identical=true`);
  }
  if (status === 'incomplete') {
    if (!INCOMPLETE_REASONS.includes(reason ?? '')) errors.push(`${where}: '${reason ?? ''}' is not an incomplete reason`);
    const side = reason?.startsWith('before-') ? 'before' : reason?.startsWith('after-') ? 'after' : null;
    if (side !== null && coverage[side].state !== 'incomplete') errors.push(`${where}: ${reason as string} needs ${side} coverage incomplete`);
  }
  if (status === 'unavailable') {
    const side = coverage.before.state === 'unavailable' ? 'before' : 'after';
    const want = `${side}-${String(coverage[side].reason)}`;
    if (reason !== want) errors.push(`${where}: unavailable must report '${want}'`);
  }
  if (status === 'unsupported' && (reason !== 'unsupported-language' || file.language !== null)) {
    errors.push(`${where}: unsupported means unsupported-language with a null language`);
  }
  if (status === 'skipped' && !SKIPPED_FILE_REASONS.includes(reason ?? '')) errors.push(`${where}: '${reason ?? ''}' is not a file skip reason`);
  if (status === 'ready' && (file.language === null || ['incomplete', 'unavailable', 'unsupported', 'notEvaluated'].includes(coverage.before.state as string)
    || ['incomplete', 'unavailable', 'unsupported', 'notEvaluated'].includes(coverage.after.state as string))) {
    errors.push(`${where}: ready needs a language module and both sides complete or absent`);
  }

  const blobOf = (endpoint: Obj): Uint8Array | undefined =>
    endpoint.kind === 'recorded' && (endpoint.snapshot as Obj).kind === 'content'
      ? history.blobs.get((endpoint.snapshot as Obj).sha256 as string)
      : undefined;
  let lastKind = 0;
  changes.forEach((change, i) => {
    const kindIndex = ROW_KIND_ORDER.indexOf(change.kind as string);
    if (kindIndex < lastKind) errors.push(`${where}.changes[${i}]: rows must be ordered removed, signatureChanged, added`);
    lastKind = Math.max(lastKind, kindIndex);
    checkChange(change, { before: blobOf(before), after: blobOf(after) }, `${where}.changes[${i}]`, errors);
  });
}

function checkEnvelope(body: Obj, req: Request, history: History, errors: string[]): void {
  if (body.session_id !== req.sessionId) errors.push('expected.session_id: does not match the request');
  const range = body.range as Obj;
  if (range.before_seq !== req.before.toString() || range.after_seq !== req.after.toString()) errors.push('expected.range: does not match the request');

  const completed = history.events.find((e) => e.type === 'slipstream.capture.baseline.completed.v1' && BigInt(e.seq as string) <= req.after);
  const inventory = body.inventory as Obj;
  if (inventory.baseline_completed_seq !== (completed?.seq ?? null)) errors.push('expected.inventory.baseline_completed_seq: does not match the history');
  const scopes = (completed?.data as Obj | undefined)?.unknown_scopes as string[] | undefined ?? [];
  const listed = inventory.unknown_scopes as string[];
  const sortedScopes = [...scopes].sort();
  if (!isDeepStrictEqual(listed, sortedScopes.slice(0, listed.length))) errors.push('expected.inventory.unknown_scopes: must be an ordered prefix of the recorded scopes');
  if (inventory.unknown_scopes_complete !== (listed.length === scopes.length)) errors.push('expected.inventory.unknown_scopes_complete: disagrees with the listed scopes');

  const recordedGaps = history.events
    .filter((e) => e.type === 'slipstream.capture.gap.v1' && BigInt(e.seq as string) <= req.after)
    .map((e) => ({ seq: e.seq, reason: (e.data as Obj).reason, scope: (e.data as Obj).scope }));
  const gaps = body.gaps as Obj[];
  if (!isDeepStrictEqual(gaps, recordedGaps.slice(0, gaps.length))) errors.push('expected.gaps: must be an ordered prefix of the recorded gaps at or before after_seq');
  if (body.gaps_complete !== (gaps.length === recordedGaps.length)) errors.push('expected.gaps_complete: disagrees with the listed gaps');

  const files = body.files as Obj[];
  const status = body.status;
  const page = body.page as Obj;
  if ((status === 'skipped') !== (body.fallback_reason !== undefined)) errors.push('expected.fallback_reason: must be present exactly when status is skipped');
  if (files.length > req.limit) errors.push(`expected.files: more than limit ${req.limit}`);
  files.forEach((f, i) => {
    if (i > 0 && !((files[i - 1]?.path as string) < (f.path as string))) errors.push(`expected.files[${i}]: not in strict UTF-16 path order`);
    checkFile(f, req, history, `expected.files[${i}]`, errors);
  });
  const settled = files.every((f) => f.status === 'ready' || f.status === 'identical');
  if (status === 'ready' && !settled) errors.push('expected.status: ready needs every file ready or identical');
  if (status === 'partial' && (files.length === 0 || settled)) errors.push('expected.status: partial needs a file that is not ready or identical');
  if (status === 'skipped') {
    if (files.length > 0 || page.complete !== false) errors.push('expected: a skipped page has no files and is not complete');
    if (page.next_after_path !== req.afterPath) errors.push('expected.page.next_after_path: a skipped page must not move the cursor');
  } else if (page.complete === true) {
    if (page.next_after_path !== null) errors.push('expected.page.next_after_path: must be null on the last page');
  } else if (files.length === 0 || page.next_after_path !== files[files.length - 1]?.path) {
    errors.push('expected.page.next_after_path: an incomplete page moves the cursor to its last returned file');
  }
}

function checkError(raw: unknown, req: Request | string, history: History, errors: string[]): void {
  if (!isObj(raw) || !ERROR_STATUSES.includes(raw.http_status as number)) {
    errors.push(`expected-error.json: http_status must be one of ${ERROR_STATUSES.join(', ')}`);
    return;
  }
  extraKeys(raw, ['http_status', 'headers'], 'expected-error', errors);
  const status = raw.http_status as number;
  if ((status === 400) !== (typeof req === 'string')) errors.push('expected-error: 400 exactly when the request is malformed');
  if (status === 409) {
    const header = isObj(raw.headers) ? raw.headers['slipstream-durable-seq'] : undefined;
    if (header !== history.durableSeq.toString()) errors.push('expected-error: 409 must carry slipstream-durable-seq equal to the durable high-water');
    if (typeof req !== 'string' && req.after <= history.durableSeq) errors.push('expected-error: 409 needs after_seq beyond the durable high-water');
  }
}

/** Every error found in one case; empty means the case is valid. */
export function checkCase(c: FixtureCase, projectionSchema: JsonSchema, eventSchemas: Map<string, JsonSchema>): string[] {
  const errors: string[] = [];
  const history = checkHistory(c.history, eventSchemas, errors);
  const req = parseRequest(c.request);
  if (history === null) return errors;
  if (typeof req !== 'string' && req.sessionId !== history.sessionId) errors.push('request.txt: session does not match history.session_id');
  if ((c.expected === undefined) === (c.expectedError === undefined)) {
    errors.push('case: needs exactly one of expected.json or expected-error.json');
    return errors;
  }
  if (c.expectedError !== undefined) {
    checkError(c.expectedError, req, history, errors);
    return errors;
  }
  if (typeof req === 'string') {
    errors.push(`request.txt: ${req}`);
    return errors;
  }
  if (req.after > history.durableSeq) errors.push('request.txt: after_seq is beyond the durable high-water, which is a 409');
  const shapeErrors = validate(projectionSchema, c.expected).map((e) => `expected: ${e}`);
  if (shapeErrors.length > 0) return [...errors, ...shapeErrors];
  checkEnvelope(c.expected as Obj, req, history, errors);
  return errors;
}

export async function loadProjectionSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(join(CONTRACT_DIR, 'schema.json'), 'utf8')) as JsonSchema;
}

export async function loadCases(dir = CASES_DIR): Promise<FixtureCase[]> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return Promise.all(names.map(async (name) => {
    const files = await readdir(join(dir, name));
    const read = async (f: string): Promise<unknown> => (files.includes(f) ? JSON.parse(await readFile(join(dir, name, f), 'utf8')) : undefined);
    const unexpected = files.filter((f) => !['history.json', 'request.txt', 'expected.json', 'expected-error.json'].includes(f));
    if (unexpected.length > 0) throw new Error(`case ${name}: unexpected files ${unexpected.join(', ')}`);
    return {
      name,
      history: await read('history.json'),
      request: await readFile(join(dir, name, 'request.txt'), 'utf8'),
      expected: await read('expected.json'),
      expectedError: await read('expected-error.json'),
    };
  }));
}

/** Declaring a valid 200 envelope skipped without changing its files must be
 * rejected; if it is not, the validator has gone vacuous. */
function negativeControl(c: FixtureCase): FixtureCase {
  const expected = structuredClone(c.expected) as Obj;
  expected.status = 'skipped';
  expected.fallback_reason = 'timeout';
  return { ...c, expected };
}

export async function runInterfaceV2Contract(io: { argv: readonly string[]; stdout: (l: string) => void; stderr: (l: string) => void }): Promise<number> {
  if (io.argv.length > 0) {
    io.stderr(`interface-v2-contract: unexpected argument '${io.argv[0]}' (takes none)`);
    return EXIT.USAGE;
  }
  let cases: FixtureCase[];
  let schema: JsonSchema;
  let eventSchemas: Map<string, JsonSchema>;
  try {
    [cases, schema, eventSchemas] = await Promise.all([loadCases(), loadProjectionSchema(), loadAllSchemas()]);
  } catch (err) {
    io.stderr(`interface-v2-contract: cannot load the contract: ${(err as Error).message}`);
    return EXIT.USAGE;
  }
  const failures = cases
    .map((c) => ({ case: c.name, errors: checkCase(c, schema, eventSchemas) }))
    .filter((f) => f.errors.length > 0);
  const control = cases.find((c) => c.expected !== undefined && (c.expected as Obj).status !== 'skipped');
  const controlRejected = control !== undefined && checkCase(negativeControl(control), schema, eventSchemas).length > 0;
  io.stdout(JSON.stringify({ cases: cases.length, failures, negative_control_rejected: controlRejected }));
  return failures.length === 0 && controlRejected ? EXIT.PASS : EXIT.FAIL;
}
