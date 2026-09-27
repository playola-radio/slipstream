/** Pure interface.v2 declaration comparison. Language extractors supply written components. */
export interface V2Identity {
  kind: string;
  scope: { kind: string; name: string }[];
  name: string;
  guards: string[];
}
export interface V2Parameter {
  position: number;
  label: string | null;
  name: string;
  binding: 'identifier' | 'pattern' | 'wildcard';
  type: { state: 'written' | 'implicit'; text: string } | { state: 'unknown'; reason: 'inferred-not-computed' };
  optional: boolean;
  variadic: boolean;
  default: string | null;
  modifiers: string[];
}
export type V2Result = { kind: 'return'; type: V2Parameter['type'] } | { kind: 'initializer'; failable: '?' | '!' | null };
export interface V2Throws { mode: 'notExpressible' | 'none' | 'throws' | 'rethrows'; type?: string }
export interface V2Header { modifiers: string[]; generic_parameters: string[]; constraints: string[] }
export interface V2Declaration {
  identity: V2Identity;
  displayName: string;
  span: { byteStart: number; byteEnd: number };
  /** Canonical token encoding of every written header component, excluding the body. */
  signature: string;
  parameters: V2Parameter[];
  result: V2Result | null;
  throws: V2Throws;
  header: V2Header;
}
export type V2Op = 'equal' | 'added' | 'removed' | 'changed';
export interface V2Delta<T> { op: V2Op; before: T | null; after: T | null }
export interface V2Change {
  kind: 'added' | 'removed' | 'signatureChanged';
  identity: V2Identity;
  before: { display_name: string; span: { byte_start: number; byte_end: number } } | null;
  after: { display_name: string; span: { byte_start: number; byte_end: number } } | null;
  parameters: V2Delta<V2Parameter>[];
  result: V2Delta<V2Result> | null;
  throws: V2Delta<V2Throws>;
  header: V2Delta<V2Header>;
}
export type V2CompareResult = { status: 'ready'; changes: V2Change[] } |
  { status: 'incomplete'; reason: 'duplicate-declaration' | 'ambiguous-correspondence' };

const identityKey = (d: V2Declaration): string => JSON.stringify([
  d.identity.kind, d.identity.scope.map((s) => [s.kind, s.name]), d.identity.name, d.identity.guards,
]);
const exactKey = (d: V2Declaration): string => JSON.stringify([identityKey(d), d.signature]);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function delta<T>(before: T | null, after: T | null): V2Delta<T> {
  return { op: before === null ? 'added' : after === null ? 'removed' : equal(before, after) ? 'equal' : 'changed', before, after };
}
function side(d: V2Declaration | null): V2Change['before'] {
  return d && { display_name: d.displayName, span: { byte_start: d.span.byteStart, byte_end: d.span.byteEnd } };
}
function pairParameters(before: V2Parameter[], after: V2Parameter[]): V2Delta<V2Parameter>[] {
  const counts = (ps: V2Parameter[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const p of ps) if (p.binding === 'identifier') result.set(p.name, (result.get(p.name) ?? 0) + 1);
    return result;
  };
  const beforeCount = counts(before), afterCount = counts(after);
  const usable = (p: V2Parameter): boolean => p.binding === 'identifier' && beforeCount.get(p.name) === 1 && afterCount.get(p.name) === 1;
  const afterByName = new Map(after.filter(usable).map((p) => [p.name, p]));
  const rows = before.map((p) => delta(p, usable(p) ? afterByName.get(p.name)! : null));
  for (const p of after) if (!usable(p)) rows.push(delta<V2Parameter>(null, p));
  return rows;
}
function row(before: V2Declaration | null, after: V2Declaration | null): V2Change {
  const kind = before === null ? 'added' : after === null ? 'removed' : 'signatureChanged';
  return {
    kind, identity: (before ?? after)!.identity, before: side(before), after: side(after),
    parameters: pairParameters(before?.parameters ?? [], after?.parameters ?? []),
    result: (before?.result ?? null) === null && (after?.result ?? null) === null ? null : delta(before?.result ?? null, after?.result ?? null),
    throws: delta(before?.throws ?? null, after?.throws ?? null),
    header: delta(before?.header ?? null, after?.header ?? null),
  };
}
function cmp(a: string | number, b: string | number): number { return a < b ? -1 : a > b ? 1 : 0; }
function cmpArray(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const result = cmp(a[i]!, b[i]!);
    if (result) return result;
  }
  return cmp(a.length, b.length);
}
function order(a: V2Declaration, b: V2Declaration): number {
  const scopeOrder = cmpArray(a.identity.scope.flatMap((s) => [s.kind, s.name]),
    b.identity.scope.flatMap((s) => [s.kind, s.name]));
  const guardOrder = cmpArray(a.identity.guards, b.identity.guards);
  for (const [x, y] of [
    [a.displayName, b.displayName], [a.signature, b.signature], [a.identity.kind, b.identity.kind],
  ] as const) { const c = cmp(x, y); if (c) return c; }
  if (scopeOrder) return scopeOrder;
  const nameOrder = cmp(a.identity.name, b.identity.name);
  if (nameOrder) return nameOrder;
  if (guardOrder) return guardOrder;
  for (const [x, y] of [
    [a.span.byteStart, b.span.byteStart],
    [a.span.byteEnd, b.span.byteEnd],
  ] as const) { const c = cmp(x, y); if (c) return c; }
  return 0;
}

/** D3 exact-first correspondence, with whole-file refusal for duplicate or ambiguous groups. */
export function compareV2(before: V2Declaration[], after: V2Declaration[]): V2CompareResult {
  for (const side of [before, after]) {
    const keys = side.map(exactKey);
    if (new Set(keys).size !== keys.length) return { status: 'incomplete', reason: 'duplicate-declaration' };
  }
  const beforeExact = new Set(before.map(exactKey)), afterExact = new Set(after.map(exactKey));
  const groups = new Map<string, { before: V2Declaration[]; after: V2Declaration[] }>();
  for (const [side, values] of [
    ['before', before.filter((d) => !afterExact.has(exactKey(d)))],
    ['after', after.filter((d) => !beforeExact.has(exactKey(d)))],
  ] as const) {
    for (const d of values) {
      const key = identityKey(d);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { before: [], after: [] });
      group[side].push(d);
    }
  }
  const items: { before: V2Declaration | null; after: V2Declaration | null }[] = [];
  for (const group of groups.values()) {
    const b = group.before, a = group.after;
    if (b.length && a.length) {
      if (b.length !== 1 || a.length !== 1) return { status: 'incomplete', reason: 'ambiguous-correspondence' };
      items.push({ before: b[0]!, after: a[0]! });
    } else {
      for (const d of b) items.push({ before: d, after: null });
      for (const d of a) items.push({ before: null, after: d });
    }
  }
  const rank = { removed: 0, signatureChanged: 1, added: 2 } as const;
  items.sort((x, y) => {
    const xKind = x.before === null ? 'added' : x.after === null ? 'removed' : 'signatureChanged';
    const yKind = y.before === null ? 'added' : y.after === null ? 'removed' : 'signatureChanged';
    return rank[xKind] - rank[yKind] || order(x.before ?? x.after!, y.before ?? y.after!) ||
      (x.after && y.after ? order(x.after, y.after) : 0);
  });
  return { status: 'ready', changes: items.map(({ before: b, after: a }) => row(b, a)) };
}
