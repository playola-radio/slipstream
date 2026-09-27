/**
 * `projection-check interface-v2-contract`: validates the hand-written
 * `interface.v2` fixtures under contracts/interface/v2/cases/ (FUNCTION-CHANGES.md
 * §5.3). It proves shape and internal consistency, never extractor correctness:
 * every expected envelope validates against the schema, obeys the cross-field
 * invariants src/schema.ts cannot express, and agrees with everything derivable
 * from its recorded history: endpoints, status precedence, page membership,
 * harness conditions, hashes, sizes and UTF-8 span boundaries. Only extraction
 * outcomes (rows, parse results) are taken on trust; FD1–FD3 prove those by
 * reproducing the same cases.
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
const ERROR_STATUSES = [400, 409, 500];
const POLICY_EXCLUSIONS = ['store-directory', '.git', 'symlinks'];
const BASELINED = 'slipstream.file.baselined.v1';
const CHANGED = 'slipstream.file.changed.v1';
const COMPLETED = 'slipstream.capture.baseline.completed.v1';
const ROW_KIND_ORDER = ['removed', 'signatureChanged', 'added'];
const INCOMPLETE_REASONS = [
  'before-parse-error', 'before-unsupported-construct',
  'after-parse-error', 'after-unsupported-construct',
  'duplicate-declaration', 'ambiguous-correspondence',
];

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
  blobs: Map<string, Uint8Array>;
  missing: Set<string>;
  /** The first `file.changed` whose `before` contradicts its path's recorded predecessor. */
  chainBreak: bigint | null;
  harness: Harness;
}

interface Harness {
  admissionOverloaded: boolean;
  interrupt: { atPath: string; reason: string } | null;
  noFileResultBudget: boolean;
  noMetadataBudget: boolean;
}

interface Endpoints {
  before: Obj;
  after: Obj;
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
  // Decoded exactly as the reader's other routes decode (URLSearchParams: '+' is a space).
  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(query)) {
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
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawSession);
  } catch {
    return 'undecodable session id';
  }
  return {
    sessionId,
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
  if (event.type === BASELINED) return [data.snapshot as Obj];
  if (event.type === CHANGED) return [data.before as Obj, data.after as Obj];
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
    blobs: new Map(),
    missing: new Set(missingList as string[]),
    chainBreak: null,
    harness: checkHarness(raw.harness, errors),
  };

  // A replayable session log: session.started first, seqs contiguous from 1.
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
    if (seq !== previous + 1n) errors.push(`${where}: seq ${event.seq} is not contiguous (expected ${previous + 1n})`);
    if ((i === 0) !== (event.type === 'slipstream.session.started.v1')) errors.push(`${where}: session.started must be the first record, and only the first`);
    previous = seq;
    if (event.id !== event.seq) errors.push(`${where}: id must equal seq`);
    if (event.source !== `${SOURCE_PREFIX}${sessionId}`) errors.push(`${where}: source does not name the history session`);
    if (!isObj(event.data) || event.data.session_id !== sessionId) errors.push(`${where}: data.session_id does not match the history session`);
    history.events.push(event);
  });
  if (previous !== history.durableSeq) errors.push('history.durable_seq: must be the last event seq');
  if (errors.length > 0) return null;

  const state = new Map<string, unknown>();
  for (const event of history.events) {
    const data = event.data as Obj;
    if (event.type === CHANGED && state.has(data.path as string) && !isDeepStrictEqual(state.get(data.path as string), data.before)) {
      history.chainBreak ??= BigInt(event.seq as string);
    }
    if (event.type === BASELINED) state.set(data.path as string, data.snapshot);
    if (event.type === CHANGED) state.set(data.path as string, data.after);
  }

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
  return history;
}

/** Test-only execution conditions a static history cannot express. A zero
 * budget is the only limit value, because it is the only one whose outcome is
 * derivable without serializing the response. */
function checkHarness(raw: unknown, errors: string[]): Harness {
  const harness: Harness = { admissionOverloaded: false, interrupt: null, noFileResultBudget: false, noMetadataBudget: false };
  if (raw === undefined) return harness;
  if (!isObj(raw)) {
    errors.push('history.harness: must be an object');
    return harness;
  }
  extraKeys(raw, ['admission', 'interrupt', 'limits'], 'history.harness', errors);
  if (raw.admission !== undefined) {
    if (raw.admission !== 'overloaded') errors.push("history.harness.admission: must be 'overloaded'");
    harness.admissionOverloaded = true;
  }
  if (raw.interrupt !== undefined) {
    const i = raw.interrupt;
    if (!isObj(i) || typeof i.at_path !== 'string' || !['timeout', 'cancelled'].includes(i.reason as string)) {
      errors.push("history.harness.interrupt: must be {at_path, reason: 'timeout' | 'cancelled'}");
    } else {
      extraKeys(i, ['at_path', 'reason'], 'history.harness.interrupt', errors);
      harness.interrupt = { atPath: i.at_path, reason: i.reason as string };
    }
  }
  if (raw.limits !== undefined) {
    const l = raw.limits;
    if (!isObj(l)) {
      errors.push('history.harness.limits: must be an object');
      return harness;
    }
    extraKeys(l, ['file_result_bytes', 'metadata_bytes'], 'history.harness.limits', errors);
    for (const [key, value] of Object.entries(l)) if (value !== 0) errors.push(`history.harness.limits.${key}: must be 0`);
    harness.noFileResultBudget = l.file_result_bytes !== undefined;
    harness.noMetadataBudget = l.metadata_bytes !== undefined;
  }
  return harness;
}

/** Component texts are the extractor's normalized token text, so `equal` means
 * the sides are identical, never "identical after stripping whitespace". */
function checkDelta(delta: Obj, where: string, errors: string[]): void {
  const { op, before, after } = delta;
  if (op === 'added' && (before !== null || after === null)) errors.push(`${where}: added needs before null and after present`);
  if (op === 'removed' && (before === null || after !== null)) errors.push(`${where}: removed needs before present and after null`);
  if (op === 'equal' || op === 'changed') {
    if (before === null || after === null) {
      errors.push(`${where}: ${op as string} needs both sides`);
      return;
    }
    const same = isDeepStrictEqual(before, after);
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

/** Language facts §4.5 fixes regardless of extraction: which declaration kinds
 * exist, when the result slot is null, and which throws modes are expressible. */
function checkLanguageRules(change: Obj, language: string, where: string, errors: string[]): void {
  if (language !== 'typescript' && language !== 'swift') {
    errors.push(`${where}: no change rows are defined for language '${language}'`);
    return;
  }
  const ts = language === 'typescript';
  const kind = (change.identity as Obj).kind as string;
  if (!(ts ? ['function', 'method', 'constructor'] : ['function', 'method', 'initializer']).includes(kind)) {
    errors.push(`${where}.identity.kind: '${kind}' is not a ${language} declaration kind`);
  }
  const sides = (delta: unknown): Obj[] => (isObj(delta) ? [delta.before, delta.after].filter(isObj) : []);
  if (ts && (change.result === null) !== (kind === 'constructor')) errors.push(`${where}.result: null exactly for a TypeScript constructor`);
  if (!ts && change.result === null) errors.push(`${where}.result: a Swift declaration always has a result slot`);
  for (const r of sides(change.result)) {
    if (ts ? r.kind !== 'return' : (r.kind === 'initializer') !== (kind === 'initializer')) errors.push(`${where}.result: '${r.kind as string}' does not fit a ${language} ${kind}`);
  }
  const modes = ts ? ['notExpressible'] : ['none', 'throws', 'rethrows'];
  for (const t of sides(change.throws)) if (!modes.includes(t.mode as string)) errors.push(`${where}.throws: '${t.mode as string}' is not a ${language} throws mode`);
  if (ts) {
    for (const p of (change.parameters as Obj[]).flatMap(sides)) if (p.label !== null) errors.push(`${where}.parameters: TypeScript parameters have no label`);
  }
}

function checkChange(change: Obj, language: string, blobs: { before?: Uint8Array; after?: Uint8Array }, where: string, errors: string[]): void {
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
  checkLanguageRules(change, language, where, errors);
  for (const side of ['before', 'after'] as const) {
    const decl = change[side];
    if (isObj(decl)) checkSpan(decl.span as Obj, blobs[side], `${where}.${side}.span`, errors);
  }
}

function recordedEndpoint(event: Obj, field: string): Obj {
  const data = event.data as Obj;
  const endpoint: Obj = { kind: 'recorded', record_seq: event.seq, field, snapshot: data[field] };
  if (event.type === CHANGED) {
    endpoint.observation = data.observation;
    if (data.gap_ref !== undefined) endpoint.gap_ref = data.gap_ref;
  }
  return endpoint;
}

/** §2.2 endpoint resolution, including the first-change predecessor rule.
 * Null when the path has no record at or before `after_seq`. */
function resolveEndpoints(path: string, req: Request, history: History): Endpoints | null {
  const records = history.events.filter((e) => (e.data as Obj).path === path && snapshotsOf(e).length > 0);
  const latest = (cutoff: bigint): Obj | undefined => records.filter((e) => BigInt(e.seq as string) <= cutoff).at(-1);
  const stateField = (e: Obj): string => (e.type === BASELINED ? 'snapshot' : 'after');
  const last = latest(req.after);
  if (last === undefined) return null;
  const after = recordedEndpoint(last, stateField(last));
  const prior = latest(req.before);
  if (prior !== undefined) return { before: recordedEndpoint(prior, stateField(prior)), after };
  const first = records.find((e) => BigInt(e.seq as string) > req.before) as Obj;
  const baselineDone = history.events.some((e) => e.type === COMPLETED && BigInt(e.seq as string) <= req.before);
  return { before: baselineDone && first.type === CHANGED ? recordedEndpoint(first, 'before') : { kind: 'unknownBoundary' }, after };
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

/** §4.4 row 0: equal endpoints whose content is still retained. */
function isIdentical(endpoints: Endpoints, history: History): boolean {
  const { before, after } = endpoints;
  if (before.kind !== 'recorded' || after.kind !== 'recorded') return false;
  const b = before.snapshot as Obj;
  const a = after.snapshot as Obj;
  if (b.kind === 'absent' && a.kind === 'absent') return true;
  return b.kind === 'content' && a.kind === 'content' && b.sha256 === a.sha256 && !history.missing.has(b.sha256 as string);
}

/** The §4.4 status the first established condition forces. Extraction-only
 * outcomes (rows 3–4) are accepted as written when nothing outranks them. */
function derivedStatus(file: Obj, endpoints: Endpoints, history: History, forcedSkip: string | null): [string, string?] {
  if (isIdentical(endpoints, history)) return ['identical'];
  const coverage = file.coverage as Record<'before' | 'after', Obj>;
  for (const side of ['before', 'after'] as const) {
    if (coverage[side].state === 'incomplete') return ['incomplete', `${side}-${String(coverage[side].reason)}`];
  }
  const extracted = file.language !== null && ['complete', 'absent'].includes(coverage.before.state as string) && ['complete', 'absent'].includes(coverage.after.state as string);
  if (extracted && file.status === 'incomplete' && ['duplicate-declaration', 'ambiguous-correspondence'].includes(file.fallback_reason as string)) {
    return ['incomplete', file.fallback_reason as string];
  }
  for (const side of ['before', 'after'] as const) {
    if (coverage[side].state === 'unavailable') return ['unavailable', `${side}-${String(coverage[side].reason)}`];
  }
  if (file.language === null) return ['unsupported', 'unsupported-language'];
  if (forcedSkip !== null) return ['skipped', forcedSkip];
  return ['ready'];
}

function checkFile(file: Obj, req: Request, history: History, forcedSkip: string | null, where: string, errors: string[]): void {
  const path = file.path as string;
  const status = file.status as string;
  const reason = file.fallback_reason as string | undefined;
  const coverage = file.coverage as Record<'before' | 'after', Obj>;
  const changes = file.changes as Obj[];

  const endpoints = resolveEndpoints(path, req, history);
  if (endpoints === null) {
    errors.push(`${where}: ${path} has no record at or before after_seq`);
    return;
  }
  for (const side of ['before', 'after'] as const) {
    if (!isDeepStrictEqual(file[side], endpoints[side])) errors.push(`${where}.${side}: §2.2 resolves ${JSON.stringify(endpoints[side])}`);
  }

  const needsReason = ['incomplete', 'unavailable', 'unsupported', 'skipped'].includes(status);
  if (needsReason !== (reason !== undefined)) errors.push(`${where}: fallback_reason must be present exactly for incomplete/unavailable/unsupported/skipped`);
  if (status !== 'ready' && changes.length > 0) errors.push(`${where}: only a ready file may carry changes`);
  if ((file.language === null) !== (file.language_version === null)) errors.push(`${where}: language and language_version must be null together`);

  for (const side of ['before', 'after'] as const) {
    const cov = coverage[side];
    const forced = forcedCoverage(endpoints[side], history);
    if (forced !== null) {
      if (!isDeepStrictEqual(cov, forced)) errors.push(`${where}.coverage.${side}: must be ${JSON.stringify(forced)} for this endpoint`);
      continue;
    }
    // A side the deadline, cancellation or a per-file limit cut off stays notEvaluated (D10).
    const allowed = status === 'identical' ? ['notEvaluated']
      : file.language === null ? ['unsupported']
      : forcedSkip !== null ? ['complete', 'incomplete', 'notEvaluated']
      : ['complete', 'incomplete'];
    if (!allowed.includes(cov.state as string)) errors.push(`${where}.coverage.${side}: a retained content side of a ${status} file cannot be ${cov.state as string}`);
    if ((cov.reason !== undefined) !== (cov.state === 'incomplete')) errors.push(`${where}.coverage.${side}: reason must be present exactly for incomplete`);
    if (cov.state === 'incomplete' && !INCOMPLETE_REASONS.includes(`${side}-${String(cov.reason)}`)) errors.push(`${where}.coverage.${side}: '${String(cov.reason)}' is not an incomplete reason`);
  }

  const [wantStatus, wantReason] = derivedStatus(file, endpoints, history, forcedSkip);
  if (status !== wantStatus || reason !== wantReason) {
    errors.push(`${where}: §4.4 precedence gives ${wantStatus}${wantReason === undefined ? '' : ` / ${wantReason}`}, not ${status}${reason === undefined ? '' : ` / ${reason}`}`);
  }
  if (status === 'identical' && !req.includeIdentical) errors.push(`${where}: identical results are listed only with include_identical=true`);

  const blobOf = (endpoint: Obj): Uint8Array | undefined =>
    endpoint.kind === 'recorded' && (endpoint.snapshot as Obj).kind === 'content'
      ? history.blobs.get((endpoint.snapshot as Obj).sha256 as string)
      : undefined;
  let lastKind = 0;
  changes.forEach((change, i) => {
    const kindIndex = ROW_KIND_ORDER.indexOf(change.kind as string);
    if (kindIndex < lastKind) errors.push(`${where}.changes[${i}]: rows must be ordered removed, signatureChanged, added`);
    lastKind = Math.max(lastKind, kindIndex);
    checkChange(change, file.language as string, { before: blobOf(endpoints.before), after: blobOf(endpoints.after) }, `${where}.changes[${i}]`, errors);
  });
}

/** Every path the page may list, in UTF-16 order: a record at or before
 * `after_seq`, inside the filter and cursor, and not hidden as identical. */
function eligiblePaths(req: Request, history: History): string[] {
  const paths = new Set<string>();
  for (const e of history.events) {
    if (snapshotsOf(e).length > 0 && BigInt(e.seq as string) <= req.after) paths.add((e.data as Obj).path as string);
  }
  return [...paths]
    .filter((p) => p.startsWith(req.pathPrefix) && (req.afterPath === null || p > req.afterPath))
    .filter((p) => req.includeIdentical || !isIdentical(resolveEndpoints(p, req, history) as Endpoints, history))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function checkMetadataList(listed: unknown[], complete: unknown, recorded: unknown[], capped: boolean, where: string, errors: string[]): void {
  const want = capped ? [] : recorded;
  if (!isDeepStrictEqual(listed, want)) errors.push(`${where}: must be ${capped ? 'empty under a zero metadata budget' : 'the full recorded list'}`);
  if (complete !== (want.length === recorded.length)) errors.push(`${where}_complete: disagrees with the listed entries`);
}

function checkEnvelope(body: Obj, req: Request, history: History, errors: string[]): void {
  const { harness } = history;
  if (body.session_id !== req.sessionId) errors.push('expected.session_id: does not match the request');
  const range = body.range as Obj;
  if (range.before_seq !== req.before.toString() || range.after_seq !== req.after.toString()) errors.push('expected.range: does not match the request');

  const completed = history.events.find((e) => e.type === COMPLETED && BigInt(e.seq as string) <= req.after);
  const inventory = body.inventory as Obj;
  if (inventory.baseline_completed_seq !== (completed?.seq ?? null)) errors.push('expected.inventory.baseline_completed_seq: does not match the history');
  if (!isDeepStrictEqual(inventory.policy_exclusions, POLICY_EXCLUSIONS)) errors.push(`expected.inventory.policy_exclusions: must be ${JSON.stringify(POLICY_EXCLUSIONS)}`);
  const scopes = [...((completed?.data as Obj | undefined)?.unknown_scopes as string[] | undefined ?? [])].sort();
  checkMetadataList(inventory.unknown_scopes as unknown[], inventory.unknown_scopes_complete, scopes, harness.noMetadataBudget, 'expected.inventory.unknown_scopes', errors);
  const recordedGaps = history.events
    .filter((e) => e.type === 'slipstream.capture.gap.v1' && BigInt(e.seq as string) <= req.after)
    .map((e) => ({ seq: e.seq, reason: (e.data as Obj).reason, scope: (e.data as Obj).scope }));
  checkMetadataList(body.gaps as unknown[], body.gaps_complete, recordedGaps, harness.noMetadataBudget, 'expected.gaps', errors);

  const files = body.files as Obj[];
  const page = body.page as Obj;
  if ((body.status === 'skipped') !== (body.fallback_reason !== undefined)) errors.push('expected.fallback_reason: must be present exactly when status is skipped');
  if (harness.admissionOverloaded) {
    if (body.status !== 'skipped' || body.fallback_reason !== 'overloaded') errors.push('expected: an overloaded admission is a skipped page with fallback_reason overloaded');
    if (files.length > 0 || page.complete !== false || page.next_after_path !== req.afterPath) errors.push('expected: a skipped page has no files, is not complete and does not move the cursor');
    return;
  }
  if (body.status === 'skipped') errors.push('expected.status: only a harness admission rejection makes a fixture page skipped');

  // Page membership: eligible paths in order, ended by the limit, an
  // interrupt (§4.3), or a zero file-result budget (§4.7).
  const eligible = eligiblePaths(req, history);
  let count = Math.min(req.limit, eligible.length);
  let endedEarly = false;
  if (harness.interrupt !== null) {
    const at = eligible.indexOf(harness.interrupt.atPath);
    if (at < 0 || at >= req.limit) errors.push('history.harness.interrupt: at_path is not a path this page reaches');
    else [count, endedEarly] = [at + 1, true];
  }
  if (harness.noFileResultBudget) count = Math.min(count, 1);
  const paths = files.map((f) => f.path);
  if (!isDeepStrictEqual(paths, eligible.slice(0, count))) errors.push(`expected.files: must list ${JSON.stringify(eligible.slice(0, count))}`);
  const complete = !endedEarly && count === eligible.length;
  if (page.complete !== complete) errors.push(`expected.page.complete: must be ${String(complete)}`);
  const cursor = complete ? null : (eligible[count - 1] ?? req.afterPath);
  if (page.next_after_path !== cursor) errors.push(`expected.page.next_after_path: must be ${JSON.stringify(cursor)}`);

  const { interrupt } = harness;
  files.forEach((f, i) => {
    const forcedSkip = interrupt !== null && interrupt.atPath === f.path ? interrupt.reason
      : harness.noFileResultBudget && i === 0 ? 'too-large'
      : null;
    checkFile(f, req, history, forcedSkip, `expected.files[${i}]`, errors);
  });
  const settled = files.every((f) => f.status === 'ready' || f.status === 'identical');
  if (body.status !== (settled ? 'ready' : 'partial')) errors.push(`expected.status: must be ${settled ? 'ready' : 'partial'} for these file statuses`);
}

/** The HTTP status the request and history force: 400, then 409, then 500 for
 * a predecessor chain broken at or before `after_seq`, otherwise 200. */
function expectedHttpStatus(req: Request | string, history: History): number {
  if (typeof req === 'string') return 400;
  if (req.after > history.durableSeq) return 409;
  if (history.chainBreak !== null && history.chainBreak <= req.after) return 500;
  return 200;
}

function checkError(raw: unknown, req: Request | string, history: History, errors: string[]): void {
  if (!isObj(raw) || !ERROR_STATUSES.includes(raw.http_status as number)) {
    errors.push(`expected-error.json: http_status must be one of ${ERROR_STATUSES.join(', ')}`);
    return;
  }
  extraKeys(raw, ['http_status', 'headers'], 'expected-error', errors);
  const want = expectedHttpStatus(req, history);
  if (raw.http_status !== want) errors.push(`expected-error: the request and history give ${want}, not ${String(raw.http_status)}`);
  const header = isObj(raw.headers) ? raw.headers['slipstream-durable-seq'] : undefined;
  if (raw.http_status === 409 && header !== history.durableSeq.toString()) errors.push('expected-error: 409 must carry slipstream-durable-seq equal to the durable high-water');
  if (raw.http_status !== 409 && raw.headers !== undefined) errors.push('expected-error: only a 409 carries headers');
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
  const want = expectedHttpStatus(req, history);
  if (typeof req === 'string' || want !== 200) {
    errors.push(`expected.json: the request and history give ${want}${typeof req === 'string' ? ` (${req})` : ''}`);
    return errors;
  }
  const shapeErrors = validate(projectionSchema, c.expected).map((e) => `expected: ${e}`);
  if (shapeErrors.length > 0) return [...errors, ...shapeErrors];
  checkEnvelope(c.expected as Obj, req, history, errors);
  return errors;
}

export async function loadProjectionSchema(): Promise<JsonSchema> {
  return JSON.parse(await readFile(join(CONTRACT_DIR, 'schema.json'), 'utf8')) as JsonSchema;
}

export async function loadCases(): Promise<FixtureCase[]> {
  const dir = CASES_DIR;
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
