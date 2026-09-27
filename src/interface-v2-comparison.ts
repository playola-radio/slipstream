/** D3 correspondence and component deltas for interface.v2 written declarations. */
import { compare, type Declaration, type Identity, type OutDeclaration } from './interface-projection.ts';

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

function signature(d: StructuredDeclaration): string {
  return JSON.stringify([d.role ?? null, d.parameters.map(p => [p.name, p.label, p.binding,
    p.type, p.optional, p.variadic, p.default, p.modifiers]), d.result, d.throws, d.header]);
}

function key(d: StructuredDeclaration): string {
  return JSON.stringify([d.identity.kind, d.identity.scope, d.identity.name, d.identity.guards, signature(d)]);
}

function hasDuplicate(ds: StructuredDeclaration[]): boolean {
  const seen = new Set<string>();
  for (const d of ds) {
    const k = key(d);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

function delta<T>(before: T | null, after: T | null): Delta<T> {
  const op: Op = before === null ? 'added' : after === null ? 'removed'
    : JSON.stringify(before) === JSON.stringify(after) ? 'equal' : 'changed';
  return { op, before, after };
}

function parameterDeltas(before: Parameter[], after: Parameter[]): Delta<Parameter>[] {
  const count = (ps: Parameter[], name: string): number => ps.filter(p => p.binding === 'identifier' && p.name === name).length;
  const paired = new Set<number>();
  const rows: Delta<Parameter>[] = before.map(p => {
    if (p.binding !== 'identifier' || count(before, p.name) !== 1 || count(after, p.name) !== 1) {
      return delta(p, null);
    }
    const index = after.findIndex(a => a.binding === 'identifier' && a.name === p.name);
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
  if (hasDuplicate(b) || hasDuplicate(a)) return {
    status: 'incomplete', fallback_reason: 'duplicate-declaration', changes: [],
  };
  const asV1 = (d: StructuredDeclaration): Declaration => ({
    identity: d.identity, displayName: d.displayName, signature: signature(d), span: d.span,
  });
  const matched = compare(b.map(asV1), a.map(asV1));
  if (matched.ambiguous) return {
    status: 'incomplete', fallback_reason: 'ambiguous-correspondence', changes: [],
  };
  const find = (list: StructuredDeclaration[], row: OutDeclaration) =>
    list.find(d => d.displayName === row.display_name && signature(d) === row.signature &&
      d.span.byteStart === row.span.byte_start && d.span.byteEnd === row.span.byte_end) ?? null;
  return { status: 'ready', changes: matched.changes.map(row => {
    const left = row.before ? find(b, row.before) : null;
    const right = row.after ? find(a, row.after) : null;
    if ((row.before && !left) || (row.after && !right)) throw new Error('missing structured declaration');
    return toChange(row.kind, left, right);
  }) };
}

export const compareTypeScriptExtractions = compareStructuredExtractions;
