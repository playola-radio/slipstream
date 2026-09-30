/** D3 correspondence and component deltas for interface.v2 written declarations. */
import { compare, hasDuplicate, type Declaration, type Identity, type OutDeclaration } from './interface-projection.ts';

export type TypeRef =
  | { state: 'written' | 'implicit'; text: string }
  | { state: 'unknown'; reason: 'inferred-not-computed' };
export interface Parameter {
  position: number;
  label: string | null;
  name: string;
  binding: 'identifier' | 'pattern' | 'wildcard';
  type: TypeRef;
  optional: boolean;
  variadic: boolean;
  default: string | null;
  modifiers: string[];
}
export type Result = { kind: 'return'; type: TypeRef } | { kind: 'initializer'; failable: '?' | '!' | null };
export interface ThrowsClause { mode: 'notExpressible' | 'none' | 'throws' | 'rethrows'; type?: string }
export interface Header { modifiers: string[]; generic_parameters: string[]; constraints: string[] }
export interface StructuredDeclaration {
  identity: Identity;
  displayName: string;
  span: { byteStart: number; byteEnd: number };
  parameters: Parameter[];
  result: Result | null;
  throws: ThrowsClause;
  header: Header;
  /** Distinguishes a legal TypeScript overload signature from its implementation. */
  role?: 'signature' | 'implementation';
}
export type StructuredExtraction =
  | { status: 'complete'; declarations: StructuredDeclaration[] }
  | { status: 'absent' }
  | { status: 'incomplete'; reason: 'parse-error' | 'unsupported-construct' };

type Op = 'equal' | 'added' | 'removed' | 'changed';
interface Delta<T> { op: Op; before: T | null; after: T | null }
export interface StructuredChange {
  kind: 'added' | 'removed' | 'signatureChanged';
  identity: Identity;
  before: { display_name: string; span: { byte_start: number; byte_end: number } } | null;
  after: { display_name: string; span: { byte_start: number; byte_end: number } } | null;
  parameters: Delta<Parameter>[];
  result: Delta<Result> | null;
  throws: Delta<ThrowsClause>;
  header: Delta<Header>;
}
export type Comparison =
  | { status: 'ready'; changes: StructuredChange[]; fallback_reason?: never }
  | { status: 'incomplete'; fallback_reason: string; changes: [] };

/** v2 D8 excludes the private signature key used by the v1 matcher. */
function compareV2Rows(a: StructuredChange, b: StructuredChange): number {
  const rank = { removed: 0, signatureChanged: 1, added: 2 } as const;
  const byKind = rank[a.kind] - rank[b.kind];
  if (byKind) return byKind;
  const cmp = (x: string | number, y: string | number): number => x < y ? -1 : x > y ? 1 : 0;
  const cmpArray = (x: string[], y: string[]): number => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = cmp(x[i]!, y[i]!);
      if (c) return c;
    }
    return cmp(x.length, y.length);
  };
  const compareSide = (x: StructuredChange, y: StructuredChange, side: 'before' | 'after'): number => {
    const left = x[side], right = y[side];
    if (!left || !right) return left ? 1 : right ? -1 : 0;
    return cmp(left.display_name, right.display_name)
      || cmp(x.identity.kind, y.identity.kind)
      || cmpArray(x.identity.scope.flatMap(scope => [scope.kind, scope.name]),
        y.identity.scope.flatMap(scope => [scope.kind, scope.name]))
      || cmp(x.identity.name, y.identity.name)
      || cmpArray(x.identity.guards, y.identity.guards)
      || cmp(left.span.byte_start, right.span.byte_start)
      || cmp(left.span.byte_end, right.span.byte_end);
  };
  return compareSide(a, b, a.kind === 'added' ? 'after' : 'before') || compareSide(a, b, 'after');
}

function signature(d: StructuredDeclaration): string {
  return JSON.stringify([d.role ?? null, d.parameters.map(p => [p.name, p.label, p.binding,
    p.type, p.optional, p.variadic, p.default, p.modifiers]), d.result, d.throws, d.header]);
}

function delta<T>(before: T | null, after: T | null): Delta<T> {
  const op: Op = before === null ? 'added' : after === null ? 'removed'
    : JSON.stringify(before) === JSON.stringify(after) ? 'equal' : 'changed';
  return { op, before, after };
}

function parameterDeltas(before: Parameter[], after: Parameter[]): Delta<Parameter>[] {
  const counts = (ps: Parameter[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const p of ps) if (p.binding === 'identifier') result.set(p.name, (result.get(p.name) ?? 0) + 1);
    return result;
  };
  const beforeCounts = counts(before);
  const afterCounts = counts(after);
  const afterByName = new Map(after.map((p, index) => [p.name, index]));
  const paired = new Set<number>();
  const rows: Delta<Parameter>[] = before.map(p => {
    if (p.binding !== 'identifier' || beforeCounts.get(p.name) !== 1 || afterCounts.get(p.name) !== 1) {
      return delta(p, null);
    }
    const index = afterByName.get(p.name)!;
    paired.add(index);
    return delta(p, after[index]!);
  });
  after.forEach((p, i) => { if (!paired.has(i)) rows.push(delta(null, p)); });
  return rows;
}

function outSide(d: StructuredDeclaration | null): StructuredChange['before'] {
  if (!d) return null;
  return { display_name: d.displayName, span: { byte_start: d.span.byteStart, byte_end: d.span.byteEnd } };
}

function toChange(kind: StructuredChange['kind'], before: StructuredDeclaration | null,
  after: StructuredDeclaration | null): StructuredChange {
  const subject = before ?? after!;
  const result = before?.result ?? null;
  const nextResult = after?.result ?? null;
  return {
    kind,
    identity: subject.identity,
    before: outSide(before), after: outSide(after),
    parameters: parameterDeltas(before?.parameters ?? [], after?.parameters ?? []),
    result: result === null && nextResult === null ? null : delta(result, nextResult),
    throws: delta(before?.throws ?? null, after?.throws ?? null),
    header: delta(before?.header ?? null, after?.header ?? null),
  };
}

/** Compare already extracted sides. Endpoint selection and file provenance belong to FD3/FD4. */
export function compareStructuredExtractions(before: StructuredExtraction,
  after: StructuredExtraction): Comparison {
  if (before.status === 'incomplete') return {
    status: 'incomplete', fallback_reason: `before-${before.reason}`, changes: [],
  };
  if (after.status === 'incomplete') return {
    status: 'incomplete', fallback_reason: `after-${after.reason}`, changes: [],
  };
  const b = before.status === 'absent' ? [] : before.declarations;
  const a = after.status === 'absent' ? [] : after.declarations;
  const asV1 = (d: StructuredDeclaration): Declaration => ({
    identity: d.identity, displayName: d.displayName, signature: signature(d), span: d.span,
  });
  const beforeV1 = b.map(asV1);
  const afterV1 = a.map(asV1);
  if (hasDuplicate(beforeV1) || hasDuplicate(afterV1)) return {
    status: 'incomplete', fallback_reason: 'duplicate-declaration', changes: [],
  };
  const matched = compare(beforeV1, afterV1);
  if (matched.ambiguous) return {
    status: 'incomplete', fallback_reason: 'ambiguous-correspondence', changes: [],
  };
  const lookupKey = (identity: Identity, name: string, signatureText: string,
    byteStart: number, byteEnd: number): string => JSON.stringify([
      identity.kind, identity.scope, identity.name, identity.guards,
      name, signatureText, byteStart, byteEnd,
    ]);
  const index = (original: StructuredDeclaration[], converted: Declaration[]): Map<string, StructuredDeclaration> =>
    new Map(converted.map((d, i) => [lookupKey(d.identity, d.displayName, d.signature,
      d.span.byteStart, d.span.byteEnd), original[i]!]));
  const beforeIndex = index(b, beforeV1);
  const afterIndex = index(a, afterV1);
  const find = (map: Map<string, StructuredDeclaration>, row: OutDeclaration, identity: Identity) =>
    map.get(lookupKey(identity, row.display_name, row.signature,
      row.span.byte_start, row.span.byte_end)) ?? null;
  const changes: StructuredChange[] = [];
  for (const row of matched.changes) {
    const left = row.before ? find(beforeIndex, row.before, row.identity) : null;
    const right = row.after ? find(afterIndex, row.after, row.identity) : null;
    if ((row.before && !left) || (row.after && !right)) throw new Error('missing structured declaration');
    const change = toChange(row.kind, left, right);
    // Overload role is an internal disambiguator, not a written input/output
    // component. A role-only transition has no public delta.
    if (row.kind === 'signatureChanged' && change.parameters.every(p => p.op === 'equal')
      && (change.result === null || change.result.op === 'equal')
      && change.throws.op === 'equal' && change.header.op === 'equal') continue;
    changes.push(change);
  }
  changes.sort(compareV2Rows);
  return { status: 'ready', changes };
}
