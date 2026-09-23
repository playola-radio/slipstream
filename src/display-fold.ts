/**
 * `display-fold.v1` — the canonical display projection of a session's published
 * records (D1): attributions, evidence, coverage, and gaps. Nothing else. Baseline
 * inventory and task grouping are deliberately outside this contract, so agreement
 * on these four components is never whole-session parity.
 *
 * Pure and I/O-free: a function of already-parsed records, composing the existing
 * public folds (`foldAttributions`, `foldEvidence`) rather than re-deriving them.
 * DISPLAY-FOLD.md is the normative description; the hand-written corpus under
 * contracts/display-fold/v1/ is its executable form.
 */
import { foldAttributions, foldEvidence } from './attribution.ts';
import type { AnyEvent } from './event.ts';

export const DISPLAY_FOLD_CONTRACT = 'display-fold.v1';

export interface EvidenceKeyRow {
  harness: string;
  harness_session_id: string;
  record_id: string;
}

export interface AttributionRow {
  source: string;
  change_seq: string;
  attribution_seq: string;
  policy_seq: string;
  status: string;
  reason: string;
  evidence_seqs: string[];
  excluded_conflicts?: EvidenceKeyRow[];
}

export interface EvidenceRow extends EvidenceKeyRow {
  source: string;
  evidence_seqs: string[];
  min_at_ms: number;
  max_at_ms: number;
  known_paths: string[];
  conflicted: boolean;
}

export interface CoverageRow {
  source: string;
  harness: string;
  seq: string;
  state: string;
  issues?: Array<{ kind: string; detail: string }>;
}

export interface GapRow {
  source: string;
  seq: string;
  reason: string;
  scope: { kind: 'session' } | { kind: string; path: string };
  episode_id?: string;
}

export interface DisplayState {
  attributions: AttributionRow[];
  evidence: EvidenceRow[];
  coverage: CoverageRow[];
  gaps: GapRow[];
}

type InvalidReason = 'invalid-record' | 'timestamp-out-of-range';

export type DisplayFoldResult =
  | { contract: typeof DISPLAY_FOLD_CONTRACT; result: 'ok'; state: DisplayState }
  | { contract: typeof DISPLAY_FOLD_CONTRACT; result: 'invalid'; error: { reason: InvalidReason; source?: string; seq?: string } }
  | { contract: typeof DISPLAY_FOLD_CONTRACT; result: 'corrupt'; error: { reason: 'conflicting-records'; source: string; seq: string } }
  | {
      contract: typeof DISPLAY_FOLD_CONTRACT;
      result: 'unsupported';
      error: { reason: 'unsupported-event-version'; source: string; seq: string; type: string };
    };

const FILE_CHANGED = 'slipstream.file.changed.v1';
const ATTRIBUTION = 'slipstream.change.attribution.v1';
const EVIDENCE = 'slipstream.harness.evidence.v1';
const COVERAGE = 'slipstream.enrichment.coverage.v1';
const GAP = 'slipstream.capture.gap.v1';
/** A family this contract interprets, at any version. Only `v1` is supported. */
const CONSUMED_FAMILY =
  /^slipstream\.(?:file\.changed|change\.attribution|harness\.evidence|enrichment\.coverage|capture\.gap)\.v([^.]+)$/;
const SEQ = /^[1-9][0-9]*$/;

const HARNESSES = ['claude-code', 'codex'];
const BASES = ['tool-start', 'tool-end', 'record-time'];
const STATUSES = ['heuristic', 'ambiguous', 'unknown'];
const ATTRIBUTION_REASONS = ['single-candidate', 'multiple-candidates', 'no-matching-evidence', 'observation-interval-unavailable'];
const COVERAGE_STATES = ['pending', 'readable', 'degraded', 'unavailable'];
const ISSUE_KINDS = ['missing', 'inaccessible', 'malformed', 'unsupported', 'discovery-limited'];
const GAP_REASONS = ['coalesced', 'baseline-unreadable', 'watcher-error', 'restart', 'storage'];

type Obj = Record<string, unknown>;
interface Rec {
  source: string;
  seq: string;
  type: string;
  data: Obj;
}
interface Identity {
  source: string;
  seq: string;
}

/** Exact string order by UTF-16 code units — never `localeCompare`, never normalized. */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numeric order of canonical decimal strings of any length. */
function compareSeq(a: string, b: string): number {
  return a.length - b.length || compareStr(a, b);
}

function compareIdentity(a: Identity, b: Identity): number {
  return compareStr(a.source, b.source) || compareSeq(a.seq, b.seq);
}

function compareStrings(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = compareStr(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf(v: unknown, values: readonly string[]): boolean {
  return typeof v === 'string' && values.includes(v);
}

function isSeq(v: unknown): v is string {
  return typeof v === 'string' && SEQ.test(v);
}

function isEvidenceKey(v: unknown): boolean {
  return (
    isObj(v) && oneOf(v.harness, HARNESSES) && typeof v.harness_session_id === 'string' && typeof v.record_id === 'string'
  );
}

/** Structural JSON-value equality: object key order is irrelevant, array order is not. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

function identityOf(r: unknown): Identity | undefined {
  if (!isObj(r) || typeof r.source !== 'string' || r.source === '' || !isSeq(r.seq)) return undefined;
  return { source: r.source, seq: r.seq };
}

function attributionValid(d: Obj): boolean {
  return (
    typeof d.change_seq === 'string' &&
    isSeq(d.policy_seq) &&
    oneOf(d.status, STATUSES) &&
    oneOf(d.reason, ATTRIBUTION_REASONS) &&
    Array.isArray(d.evidence_seqs) &&
    d.evidence_seqs.every(isSeq) &&
    (d.excluded_conflicts === undefined || (Array.isArray(d.excluded_conflicts) && d.excluded_conflicts.every(isEvidenceKey)))
  );
}

function evidenceProblem(d: Obj): InvalidReason | undefined {
  const ts = d.timestamp;
  const scope = d.file_scope;
  const scopeValid =
    isObj(scope) &&
    ((scope.kind === 'paths' && Array.isArray(scope.paths) && scope.paths.every((p) => typeof p === 'string')) ||
      (scope.kind === 'unknown' && typeof scope.reason === 'string'));
  if (
    !isEvidenceKey(d.evidence_key) ||
    typeof d.tool_name !== 'string' ||
    !isObj(ts) ||
    !oneOf(ts.basis, BASES) ||
    typeof ts.at_ms !== 'number' ||
    !Number.isInteger(ts.at_ms) ||
    !scopeValid
  ) {
    return 'invalid-record';
  }
  if (ts.at_ms < 0 || ts.at_ms > Number.MAX_SAFE_INTEGER) return 'timestamp-out-of-range';
  return undefined;
}

function coverageValid(d: Obj): boolean {
  return (
    oneOf(d.harness, HARNESSES) &&
    oneOf(d.state, COVERAGE_STATES) &&
    (d.issues === undefined ||
      (Array.isArray(d.issues) && d.issues.every((i) => isObj(i) && oneOf(i.kind, ISSUE_KINDS) && typeof i.detail === 'string')))
  );
}

function gapValid(d: Obj): boolean {
  const scope = d.scope;
  return (
    oneOf(d.reason, GAP_REASONS) &&
    isObj(scope) &&
    (scope.kind === 'session' || ((scope.kind === 'directory' || scope.kind === 'path') && typeof scope.path === 'string')) &&
    (d.episode_id === undefined || typeof d.episode_id === 'string')
  );
}

/** What is wrong with an identified record, judged only on the fields this contract interprets. */
function recordProblem(r: Obj): InvalidReason | undefined {
  const { type, data } = r;
  if (typeof type !== 'string' || !isObj(data)) return 'invalid-record';
  switch (type) {
    case ATTRIBUTION:
      return attributionValid(data) ? undefined : 'invalid-record';
    case EVIDENCE:
      return evidenceProblem(data);
    case COVERAGE:
      return coverageValid(data) ? undefined : 'invalid-record';
    case GAP:
      return gapValid(data) ? undefined : 'invalid-record';
    default:
      return undefined;
  }
}

function first<T>(items: T[], compare: (a: T, b: T) => number): T | undefined {
  return items.reduce<T | undefined>((min, x) => (min === undefined || compare(x, min) < 0 ? x : min), undefined);
}

function projectKey(k: Obj): EvidenceKeyRow {
  return { harness: k.harness as string, harness_session_id: k.harness_session_id as string, record_id: k.record_id as string };
}

function keyTuple(k: EvidenceKeyRow): string[] {
  return [k.harness, k.harness_session_id, k.record_id];
}

function foldAttributionRows(records: readonly Rec[]): AttributionRow[] {
  const rows: AttributionRow[] = [];
  for (const { seq, source, data } of foldAttributions(records as unknown as AnyEvent[]).values()) {
    const row: AttributionRow = {
      source,
      change_seq: data.change_seq,
      attribution_seq: seq.toString(),
      policy_seq: data.policy_seq,
      status: data.status,
      reason: data.reason,
      evidence_seqs: [...data.evidence_seqs].sort(compareSeq),
    };
    if (data.excluded_conflicts !== undefined) {
      row.excluded_conflicts = data.excluded_conflicts
        .map((k) => projectKey(k as unknown as Obj))
        .sort((a, b) => compareStrings(keyTuple(a), keyTuple(b)));
    }
    rows.push(row);
  }
  return rows.sort((a, b) => compareStr(a.source, b.source) || compareSeq(a.change_seq, b.change_seq));
}

/** Evidence is folded per source (D8): the same evidence key in two sessions is two invocations. */
function foldEvidenceRows(records: readonly Rec[]): EvidenceRow[] {
  const bySource = new Map<string, Rec[]>();
  for (const r of records) {
    if (r.type !== EVIDENCE) continue;
    const group = bySource.get(r.source);
    if (group) group.push(r);
    else bySource.set(r.source, [r]);
  }
  const rows: EvidenceRow[] = [];
  for (const [source, group] of bySource) {
    for (const inv of foldEvidence(group as unknown as AnyEvent[]).values()) {
      rows.push({
        source,
        ...projectKey(inv.key as unknown as Obj),
        evidence_seqs: inv.evidenceSeqs.map(String),
        min_at_ms: inv.minAtMs,
        max_at_ms: inv.maxAtMs,
        known_paths: [...inv.knownPaths],
        conflicted: inv.conflicted,
      });
    }
  }
  return rows.sort((a, b) => compareStrings([a.source, ...keyTuple(a)], [b.source, ...keyTuple(b)]));
}

/** Highest seq per `(source, harness)` replaces wholesale. No record means health is unknown — no row. */
function foldCoverageRows(records: readonly Rec[]): CoverageRow[] {
  const latest = new Map<string, Rec>();
  for (const r of records) {
    if (r.type !== COVERAGE) continue;
    const k = JSON.stringify([r.source, r.data.harness]);
    const cur = latest.get(k);
    if (!cur || compareSeq(r.seq, cur.seq) > 0) latest.set(k, r);
  }
  const rows: CoverageRow[] = [];
  for (const { source, seq, data } of latest.values()) {
    const row: CoverageRow = { source, harness: data.harness as string, seq, state: data.state as string };
    if (data.issues !== undefined) {
      row.issues = (data.issues as Obj[])
        .map((i) => ({ kind: i.kind as string, detail: i.detail as string }))
        .sort((a, b) => compareStrings([a.kind, a.detail], [b.kind, b.detail]));
    }
    rows.push(row);
  }
  return rows.sort((a, b) => compareStrings([a.source, a.harness], [b.source, b.harness]));
}

/** Published gaps only, as recorded — never inferred, healed, or scored. */
function foldGapRows(records: readonly Rec[]): GapRow[] {
  const rows: GapRow[] = [];
  for (const { source, seq, type, data } of records) {
    if (type !== GAP) continue;
    const scope = data.scope as Obj;
    const row: GapRow = {
      source,
      seq,
      reason: data.reason as string,
      scope: scope.kind === 'session' ? { kind: 'session' } : { kind: scope.kind as string, path: scope.path as string },
    };
    if (data.episode_id !== undefined) row.episode_id = data.episode_id as string;
    rows.push(row);
  }
  return rows.sort(compareIdentity);
}

/**
 * Fold parsed records into the canonical display state, or refuse with a
 * distinguishable reason. A refusal carries no state: a partial fold is never
 * presented as good. Precedence is invalid > corrupt > unsupported, and within a
 * class the smallest `(source, seq)` is reported, so the result never depends on
 * delivery order.
 */
export function foldDisplay(records: readonly unknown[]): DisplayFoldResult {
  let unidentified = false;
  const invalid: Array<Identity & { reason: InvalidReason }> = [];
  const conflicts: Identity[] = [];
  const seen = new Map<string, unknown>();
  const unique: Rec[] = [];

  for (const r of records) {
    const id = identityOf(r);
    if (!id) {
      unidentified = true;
      continue;
    }
    const problem = recordProblem(r as Obj);
    if (problem) invalid.push({ ...id, reason: problem });
    const k = JSON.stringify([id.source, id.seq]);
    if (!seen.has(k)) {
      seen.set(k, r);
      if (!problem) unique.push(r as Rec);
    } else if (!jsonEqual(seen.get(k), r)) {
      conflicts.push(id);
    }
  }

  const contract = DISPLAY_FOLD_CONTRACT;
  if (unidentified) return { contract, result: 'invalid', error: { reason: 'invalid-record' } };
  const bad = first(invalid, (a, b) => compareIdentity(a, b) || compareStr(a.reason, b.reason));
  if (bad) return { contract, result: 'invalid', error: { reason: bad.reason, source: bad.source, seq: bad.seq } };
  const conflict = first(conflicts, compareIdentity);
  if (conflict) return { contract, result: 'corrupt', error: { reason: 'conflicting-records', ...conflict } };
  const unsupported = first(
    unique.filter((r) => {
      const version = CONSUMED_FAMILY.exec(r.type)?.[1];
      return version !== undefined && version !== '1';
    }),
    compareIdentity,
  );
  if (unsupported) {
    const { source, seq, type } = unsupported;
    return { contract, result: 'unsupported', error: { reason: 'unsupported-event-version', source, seq, type } };
  }

  return {
    contract,
    result: 'ok',
    state: {
      attributions: foldAttributionRows(unique),
      evidence: foldEvidenceRows(unique),
      coverage: foldCoverageRows(unique),
      gaps: foldGapRows(unique),
    },
  };
}

/**
 * Canonical serialization: object keys sorted by UTF-16 code units, array order
 * kept, no whitespace, `JSON.stringify` string escaping (lone surrogates escaped),
 * numbers only as safe integers. Anything else is a caller bug and throws rather
 * than being coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: ${value} is not a safe integer`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (isObj(value)) {
    const keys = Object.keys(value).sort(compareStr);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}
