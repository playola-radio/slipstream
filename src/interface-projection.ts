/**
 * The language-neutral core of the `interface.v1` projection: the declaration /
 * identity model, the D3 correspondence algorithm, the D10 status-precedence
 * table, D8 row ordering, and the response-envelope builder.
 *
 * This module is pure and has **zero imports** — no parser, no tree-sitter, no
 * worker, no I/O, and zero language branches. Per-language extraction feeds it
 * `Declaration`s and dispositions; how those are produced is not its concern.
 * See INTERFACE-PROJECTION.md for the full contract.
 */

export const INTERFACE_PROJECTION_VERSION = 'interface.v1';

/** A half-open range of UTF-8 byte offsets `[byteStart, byteEnd)` into a file. */
export interface ByteSpan {
  byteStart: number;
  byteEnd: number;
}

/** One enclosing scope, outermost → innermost (e.g. a class, then a nested type). */
export interface ScopeSegment {
  kind: string;
  name: string;
}

/**
 * A declaration's structured matching key. Compared field-by-field, never as a
 * joined string. `guards` records syntactic `#if` nesting (outer → inner), so a
 * declaration under `#if DEBUG` and one under `#else` are distinct identities.
 */
export interface Identity {
  kind: string;
  scope: ScopeSegment[];
  name: string;
  guards: string[];
}

/**
 * One extracted declaration. `signature` is an opaque string the core compares
 * only by exact equality; it never parses it.
 */
export interface Declaration {
  identity: Identity;
  displayName: string;
  signature: string;
  span: ByteSpan;
}

/** Per-side extraction outcome handed to the envelope builder. */
export type SideExtraction =
  | { status: 'complete'; declarations: Declaration[] }
  | { status: 'absent' }
  | { status: 'incomplete'; reason: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'notEvaluated' };

/** Everything the builder needs for one interface projection. */
export interface BuildInput {
  changeSeq: string;
  /** `null` iff there is no language module for the file. */
  language: string | null;
  /** `null` iff there is no language module for the file. */
  languageVersion: string | null;
  before: SideExtraction;
  after: SideExtraction;
  /** Whole-request skip disposition, when admission rejected/aborted the work. */
  admission?: 'overloaded' | 'timeout' | 'cancelled';
}

export type ChangeKind = 'added' | 'removed' | 'signatureChanged';

export type CoverageState =
  | 'complete'
  | 'absent'
  | 'incomplete'
  | 'unavailable'
  | 'unsupported'
  | 'notEvaluated';

export type ProjectionStatus =
  | 'ready'
  | 'incomplete'
  | 'unavailable'
  | 'unsupported'
  | 'skipped';

// ---- Public output shapes (the serialized contract; snake_case on the wire) --

export interface OutDeclaration {
  kind: string;
  display_name: string;
  signature: string;
  span: { byte_start: number; byte_end: number };
}

export interface OutIdentity {
  kind: string;
  scope: Array<{ kind: string; name: string }>;
  name: string;
  guards: string[];
}

export interface Change {
  kind: ChangeKind;
  identity: OutIdentity;
  before: OutDeclaration | null;
  after: OutDeclaration | null;
}

export interface CoverageSide {
  state: CoverageState;
  reason?: string;
}

export interface InterfaceProjection {
  change_seq: string;
  projection_version: 'interface.v1';
  language: string | null;
  language_version: string | null;
  status: ProjectionStatus;
  fallback_reason?: string;
  coverage: { before: CoverageSide; after: CoverageSide };
  changes: Change[];
}

// ---- Keys ------------------------------------------------------------------

/**
 * A collision-free string for an identity. Uses `JSON.stringify` over a
 * fixed-order structure so distinct identities never alias (JSON quoting makes
 * the encoding injective — unlike a delimiter join).
 */
function groupingKey(id: Identity): string {
  return JSON.stringify([
    id.kind,
    id.scope.map((s) => [s.kind, s.name]),
    id.name,
    id.guards,
  ]);
}

/** Identity plus signature: two declarations "are the same" iff these match. */
function exactKey(d: Declaration): string {
  return JSON.stringify([groupingKey(d.identity), d.signature]);
}

function hasDuplicate(decls: Declaration[]): boolean {
  const seen = new Set<string>();
  for (const d of decls) {
    const k = exactKey(d);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

// ---- Correspondence (D3) ---------------------------------------------------

export type CompareResult =
  | { ambiguous: false; changes: Change[] }
  | { ambiguous: true };

/**
 * Correspond two declaration lists. Callers must have already ruled out
 * per-side duplicates (status precedence 3); this assumes each `exactKey`
 * occurs at most once per side.
 */
export function compare(before: Declaration[], after: Declaration[]): CompareResult {
  const beforeExact = new Set(before.map(exactKey));
  const afterExact = new Set(after.map(exactKey));

  const unmatchedBefore = before.filter((d) => !afterExact.has(exactKey(d)));
  const unmatchedAfter = after.filter((d) => !beforeExact.has(exactKey(d)));

  const groups = new Map<string, { before: Declaration[]; after: Declaration[] }>();
  const groupOf = (d: Declaration) => {
    const k = groupingKey(d.identity);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { before: [], after: [] }));
    return g;
  };
  for (const d of unmatchedBefore) groupOf(d).before.push(d);
  for (const d of unmatchedAfter) groupOf(d).after.push(d);

  const changes: Change[] = [];
  for (const { before: b, after: a } of groups.values()) {
    if (b.length > 0 && a.length > 0) {
      if (b.length === 1 && a.length === 1) {
        changes.push(signatureChangedRow(b[0]!, a[0]!));
      } else {
        return { ambiguous: true };
      }
    } else if (b.length > 0) {
      for (const d of b) changes.push(removedRow(d));
    } else {
      for (const d of a) changes.push(addedRow(d));
    }
  }

  changes.sort(compareRows);
  return { ambiguous: false, changes };
}

function outDecl(d: Declaration): OutDeclaration {
  return {
    kind: d.identity.kind,
    display_name: d.displayName,
    signature: d.signature,
    span: { byte_start: d.span.byteStart, byte_end: d.span.byteEnd },
  };
}

function outIdentity(id: Identity): OutIdentity {
  return {
    kind: id.kind,
    scope: id.scope.map((s) => ({ kind: s.kind, name: s.name })),
    name: id.name,
    guards: [...id.guards],
  };
}

function removedRow(d: Declaration): Change {
  return { kind: 'removed', identity: outIdentity(d.identity), before: outDecl(d), after: null };
}

function addedRow(d: Declaration): Change {
  return { kind: 'added', identity: outIdentity(d.identity), before: null, after: outDecl(d) };
}

function signatureChangedRow(b: Declaration, a: Declaration): Change {
  return {
    kind: 'signatureChanged',
    identity: outIdentity(b.identity),
    before: outDecl(b),
    after: outDecl(a),
  };
}

// ---- Ordering (D8) ---------------------------------------------------------

type Cmp = string | number | Cmp[];

/** UTF-16 code-unit strings, numeric offsets, lexicographic arrays (shorter
 * prefix first). No normalization, no locale. */
function cmp(a: Cmp, b: Cmp): number {
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i]!, b[i]!);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  throw new Error('interface projection: cmp type mismatch');
}

const KIND_RANK: Record<ChangeKind, number> = { removed: 0, signatureChanged: 1, added: 2 };

/** The D(d) ordering tuple for one output declaration. */
function orderTuple(d: OutDeclaration, id: OutIdentity): Cmp {
  const scopePairs: Cmp = id.scope.flatMap((s) => [s.kind, s.name]);
  return [
    d.display_name,
    d.signature,
    id.kind,
    scopePairs,
    id.name,
    id.guards,
    d.span.byte_start,
    d.span.byte_end,
  ];
}

function anchor(row: Change): OutDeclaration {
  return row.kind === 'added' ? row.after! : row.before!;
}

function counterpart(row: Change): OutDeclaration | null {
  return row.kind === 'signatureChanged' ? row.after : null;
}

function compareRows(x: Change, y: Change): number {
  const byKind = KIND_RANK[x.kind] - KIND_RANK[y.kind];
  if (byKind !== 0) return byKind;

  const byAnchor = cmp(orderTuple(anchor(x), x.identity), orderTuple(anchor(y), y.identity));
  if (byAnchor !== 0) return byAnchor;

  const cx = counterpart(x);
  const cy = counterpart(y);
  if (cx === null && cy === null) return 0;
  if (cx === null) return -1; // null counterpart sorts first
  if (cy === null) return 1;
  return cmp(orderTuple(cx, x.identity), orderTuple(cy, y.identity));
}

// ---- Status precedence (D10) + envelope ------------------------------------

function coverageSide(side: SideExtraction, input: BuildInput): CoverageSide {
  switch (side.status) {
    case 'complete':
      return { state: 'complete' };
    case 'absent':
      return { state: 'absent' };
    case 'incomplete':
      return { state: 'incomplete', reason: side.reason };
    case 'unavailable':
      return { state: 'unavailable', reason: side.reason };
    case 'notEvaluated':
      if (!input.admission && input.language === null) return { state: 'unsupported' };
      return { state: 'notEvaluated' };
  }
}

function classify(input: BuildInput): { status: ProjectionStatus; reason?: string; changes: Change[] } {
  const { before, after } = input;

  if (before.status === 'incomplete') return { status: 'incomplete', reason: before.reason, changes: [] };
  if (after.status === 'incomplete') return { status: 'incomplete', reason: after.reason, changes: [] };

  if (before.status === 'complete' && hasDuplicate(before.declarations)) {
    return { status: 'incomplete', reason: 'duplicate-declaration', changes: [] };
  }
  if (after.status === 'complete' && hasDuplicate(after.declarations)) {
    return { status: 'incomplete', reason: 'duplicate-declaration', changes: [] };
  }

  const bComparable = before.status === 'complete' || before.status === 'absent';
  const aComparable = after.status === 'complete' || after.status === 'absent';
  if (bComparable && aComparable) {
    const bd = before.status === 'complete' ? before.declarations : [];
    const ad = after.status === 'complete' ? after.declarations : [];
    const result = compare(bd, ad);
    if (result.ambiguous) return { status: 'incomplete', reason: 'ambiguous-correspondence', changes: [] };
    return { status: 'ready', changes: result.changes };
  }

  if (before.status === 'unavailable') return { status: 'unavailable', reason: before.reason, changes: [] };
  if (after.status === 'unavailable') return { status: 'unavailable', reason: after.reason, changes: [] };

  if (input.language === null) return { status: 'unsupported', reason: 'unsupported-language', changes: [] };
  if (input.admission) return { status: 'skipped', reason: input.admission, changes: [] };

  throw new Error('interface projection: incoherent disposition inputs');
}

export function buildInterfaceProjection(input: BuildInput): InterfaceProjection {
  const { status, reason, changes } = classify(input);
  const projection: InterfaceProjection = {
    change_seq: input.changeSeq,
    projection_version: INTERFACE_PROJECTION_VERSION,
    language: input.language,
    language_version: input.languageVersion,
    status,
    coverage: {
      before: coverageSide(input.before, input),
      after: coverageSide(input.after, input),
    },
    changes,
  };
  if (status !== 'ready') projection.fallback_reason = reason;
  return projection;
}
