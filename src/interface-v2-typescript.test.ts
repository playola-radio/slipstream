import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypeScriptInterfaceExtractor, verifyTypeScriptGrammarArtifact } from './interface-v2-typescript.ts';
import { compareStructuredExtractions as compareTypeScriptExtractions } from './interface-v2-comparison.ts';

test('extracts one written TypeScript function from whole source bytes', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('function f(x: number): void {}\n'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.declarations, [{
    identity: { kind: 'function', scope: [], name: 'f', guards: [] },
    displayName: 'f',
    span: { byteStart: 0, byteEnd: 30 },
    parameters: [{
      position: 0, label: null, name: 'x', binding: 'identifier',
      type: { state: 'written', text: 'number' }, optional: false,
      variadic: false, default: null, modifiers: [],
    }],
    result: { kind: 'return', type: { state: 'written', text: 'void' } },
    throws: { mode: 'notExpressible' },
    header: { modifiers: [], generic_parameters: [], constraints: [] },
    role: 'implementation',
  }]);
});

test('TSX named component binding has one written destructuring input and return', async () => {
  const extract = await createTypeScriptInterfaceExtractor('tsx');
  const result = extract(Buffer.from('export const Card = ({ title }: Props): JSX.Element => <div>{title}</div>;'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.equal(result.declarations.length, 1);
  assert.deepEqual(result.declarations[0]!.parameters[0], {
    position: 0, label: null, name: '{ title }', binding: 'pattern',
    type: { state: 'written', text: 'Props' }, optional: false,
    variadic: false, default: null, modifiers: [],
  });
  assert.deepEqual(result.declarations[0]!.result,
    { kind: 'return', type: { state: 'written', text: 'JSX.Element' } });
  assert.deepEqual(result.declarations[0]!.header.modifiers, ['export', 'const']);
  assert.deepEqual(result.declarations[0]!.span,
    { byteStart: 0, byteEnd: Buffer.byteLength('export const Card = ({ title }: Props): JSX.Element => <div>{title}</div>;') });
});

test('legal overload set keeps one changed signature separate from implementation', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f(x: number): number;\nfunction f(x: string): string;\nfunction f(x: unknown) { return x; }'));
  const after = extract(Buffer.from('function f(x: number): number;\nfunction f(x: boolean): boolean;\nfunction f(x: unknown) { return x; }'));
  const compared = compareTypeScriptExtractions(before, after);
  assert.equal(compared.status, 'ready');
  assert.equal(compared.changes.length, 1);
  assert.equal(compared.changes[0]!.kind, 'signatureChanged');
});

test('syntax token normalization preserves literal spaces and token boundaries', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f({a,b}: P, x: Array<string> = ["a b"]): Promise<void> {}'));
  const after = extract(Buffer.from('function f({ a , b }:P, x:Array < string > = ["a b"]):Promise < void > {}'));
  assert.equal(before.status, 'complete');
  assert.equal(after.status, 'complete');
  if (before.status !== 'complete' || after.status !== 'complete') return;
  assert.equal(before.declarations[0]!.parameters[0]!.name, '{ a, b }');
  assert.equal(after.declarations[0]!.parameters[1]!.type.state, 'written');
  assert.equal(compareTypeScriptExtractions(before, after).changes.length, 0);
  const changed = extract(Buffer.from('function f({a,b}: P, x: Array<string> = ["ab"]): Promise<void> {}'));
  assert.equal(compareTypeScriptExtractions(before, changed).changes.length, 1);
});

test('malformed sibling makes whole file incomplete and emits no rows', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function good(x: number): void {}\nfunction broken(x: {'));
  const after = extract(Buffer.from('function good(x: string): void {}'));
  assert.deepEqual(compareTypeScriptExtractions(before, after), {
    status: 'incomplete', fallback_reason: 'before-parse-error', changes: [],
  });
});

test('an unrepresentable named class field function makes the whole file incomplete', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  assert.deepEqual(extract(Buffer.from('class C { m = (x: number): void => {}; }')),
    { status: 'incomplete', reason: 'unsupported-construct' });
  assert.deepEqual(extract(Buffer.from('class C { m = ((x: number) => x); }')),
    { status: 'incomplete', reason: 'unsupported-construct' });
});

test('local named functions and anonymous callbacks are outside extraction scope', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('function outer(): void { function inner(): void {} [1].map(x => x); }'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations.map(d => d.identity.name), ['outer']);
});

test('named bindings accept single-parameter arrows and named function expressions', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('const one = x => x;\nlet two = function inner(y: string): string { return y; };'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.declarations.map(d => d.identity.name), ['one', 'two']);
  assert.deepEqual(result.declarations[0]!.parameters[0]!.name, 'x');
  assert.deepEqual(result.declarations[0]!.result,
    { kind: 'return', type: { state: 'unknown', reason: 'inferred-not-computed' } });
  assert.deepEqual(result.declarations[1]!.header.modifiers, ['let']);
});

test('class method preserves modifiers and generic constraints as written', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { public async m<T extends Item>(x: T): Promise<T> { return x; } }'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.declarations[0]!.identity,
    { kind: 'method', scope: [{ kind: 'class', name: 'C' }], name: 'm', guards: [] });
  assert.deepEqual(result.declarations[0]!.header,
    { modifiers: ['public', 'async'], generic_parameters: ['T extends Item'], constraints: [] });
  assert.deepEqual(result.declarations[0]!.result,
    { kind: 'return', type: { state: 'written', text: 'Promise<T>' } });
});

test('computed method names are an explicit unsupported construct', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  assert.deepEqual(extract(Buffer.from('class C { [Symbol.iterator](): void {} }')),
    { status: 'incomplete', reason: 'unsupported-construct' });
});

test('UTF-8 byte spans include a leading BOM and reject invalid bytes', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const source = Buffer.from('\uFEFFfunction f(): void {}');
  const result = extract(source);
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations[0]!.span,
    { byteStart: 3, byteEnd: source.length });
  assert.deepEqual(extract(Uint8Array.from([0xff, 0x66])),
    { status: 'incomplete', reason: 'parse-error' });
});

test('grammar loader rejects an artifact changed under typescript.v2', () => {
  assert.throws(() => verifyTypeScriptGrammarArtifact('typescript', '0'.repeat(64)), /hash mismatch/);
});

test('typed function binding uses its written function type', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('const f: (x: number) => string = x => String(x);'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.declarations[0]!.parameters[0]!.type,
    { state: 'written', text: 'number' });
  assert.deepEqual(result.declarations[0]!.result,
    { kind: 'return', type: { state: 'written', text: 'string' } });
});

test('an opaque binding type and a class expression do not silently lose written methods', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  assert.deepEqual(extract(Buffer.from('const f: Fn = (x: number) => x;')),
    { status: 'incomplete', reason: 'unsupported-construct' });
  assert.deepEqual(extract(Buffer.from('const C = class { m(): void {} };')),
    { status: 'incomplete', reason: 'unsupported-construct' });
});

test('export default is a written header change', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('export function f(): void {}'));
  const after = extract(Buffer.from('export default function f(): void {}'));
  const actual = compareTypeScriptExtractions(before, after);
  assert.equal(actual.status, 'ready');
  assert.equal(actual.changes.length, 1);
  assert.deepEqual(actual.changes[0]!.header, {
    op: 'changed',
    before: { modifiers: ['export'], generic_parameters: [], constraints: [] },
    after: { modifiers: ['export', 'default'], generic_parameters: [], constraints: [] },
  });
});

test('generator marker and optional method marker remain visible in headers', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const regular = extract(Buffer.from('function g(): void {}'));
  const generator = extract(Buffer.from('function* g(): void {}'));
  const changed = compareTypeScriptExtractions(regular, generator);
  assert.equal(changed.status, 'ready');
  assert.equal(changed.changes.length, 1);
  assert.deepEqual(changed.changes[0]!.header.after?.modifiers, ['*']);

  const optional = extract(Buffer.from('class C { m?(x: number): void; }'));
  const required = extract(Buffer.from('class C { m(x: number): void; }'));
  const method = compareTypeScriptExtractions(optional, required);
  assert.equal(method.status, 'ready');
  assert.equal(method.changes.length, 1);
  assert.deepEqual(method.changes[0]!.header.before?.modifiers, ['?']);
  assert.deepEqual(method.changes[0]!.before?.span, { byte_start: 10, byte_end: 30 });
});

test('a static method named constructor is a method, not the class constructor', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { static constructor(): number { return 1; } }'));
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.declarations[0]!.identity,
    { kind: 'method', scope: [{ kind: 'class', name: 'C' }], name: 'constructor', guards: [] });
  assert.deepEqual(result.declarations[0]!.result,
    { kind: 'return', type: { state: 'written', text: 'number' } });
});

test('constructor parameter properties keep their written modifiers', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { constructor(public readonly x: number) {} }'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations[0]!.parameters[0]!.modifiers,
    ['public', 'readonly']);
  const override = extract(Buffer.from('class C extends B { constructor(override readonly x: number) { super(); } }'));
  assert.equal(override.status, 'complete');
  if (override.status === 'complete') assert.deepEqual(override.declarations[0]!.parameters[0]!.modifiers,
    ['override', 'readonly']);
});

test('normalization keeps adjacent operator tokens from merging', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('function f(x: number = a + +b): void {}'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.match(result.declarations[0]!.parameters[0]!.default!, /\+\s+\+/);
});

test('comments in written headers are trivia, not missing types or unsupported parameters', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f(/*a*/ x: /** id */ string /*b*/, /*c*/ y: number): /* r */ Promise<void> {}'));
  const after = extract(Buffer.from('function f(x: number, y: number): Promise<User> {}'));
  assert.equal(before.status, 'complete');
  const result = compareTypeScriptExtractions(before, after);
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.parameters[0]!.before?.type,
    { state: 'written', text: 'string' });
  assert.deepEqual(result.changes[0]!.result?.before,
    { kind: 'return', type: { state: 'written', text: 'Promise<void>' } });
});

test('abstract classes and abstract methods remain eligible', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('abstract class A { abstract m(x: number): void; n(x: number): void {} }'));
  const after = extract(Buffer.from('abstract class A { abstract m(x: string): void; n(x: string): void {} }'));
  assert.equal(before.status, 'complete');
  if (before.status === 'complete') assert.deepEqual(before.declarations.map(d => d.identity.name), ['m', 'n']);
  const result = compareTypeScriptExtractions(before, after);
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 2);
});

test('a decorator before an exported class does not remove its methods', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const plain = extract(Buffer.from('export class S { m(x: number): void {} }'));
  const decorated = extract(Buffer.from('@Injectable()\nexport class S { m(x: number): void {} }'));
  assert.equal(decorated.status, 'complete');
  assert.deepEqual(compareTypeScriptExtractions(plain, decorated).changes, []);
});

test('modified accessors remain excluded', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class A { static get x(): number { return 1 } public set y(v: number) {} m(): void {} }'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations.map(d => d.identity.name), ['m']);
});

test('adding override changes the written method header', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('class A extends B { m(): void {} }'));
  const after = extract(Buffer.from('class A extends B { override m(): void {} }'));
  const result = compareTypeScriptExtractions(before, after);
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.header.before?.modifiers, []);
  assert.deepEqual(result.changes[0]!.header.after?.modifiers, ['override']);
});

test('template literal types keep literal fragments', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f(x: `a-${string}`): void {}'));
  const after = extract(Buffer.from('function f(x: `b-${string}`): void {}'));
  const result = compareTypeScriptExtractions(before, after);
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.parameters[0]!.before?.type,
    { state: 'written', text: '`a-${string}`' });
});

test('template literal type substitution trivia is not a written change', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f(x: `a-${string}`): void {}'));
  const after = extract(Buffer.from('function f(x: `a-${ string }`): void {}'));
  assert.equal(compareTypeScriptExtractions(before, after).changes.length, 0);
});

test('typed binding keeps optional, rest, and generic clauses', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('const f: <T>(...a: T[]) => T = (...a) => a[0]!;'));
  const after = extract(Buffer.from('const f: <T extends object>(a?: T[]) => T = a => a![0]!;'));
  const result = compareTypeScriptExtractions(before, after);
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.header.before?.generic_parameters, ['T']);
  assert.deepEqual(result.changes[0]!.header.after?.generic_parameters, ['T extends object']);
  assert.equal(result.changes[0]!.parameters[0]!.before?.variadic, true);
  assert.equal(result.changes[0]!.parameters[0]!.after?.optional, true);
});

test('namespace members and wrapped function bindings fail visibly', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  for (const source of [
    'namespace N { export function f(): void {} }',
    'export namespace N { export function f(): void {} }',
    'module N { export function f(): void {} }',
    'declare module "x" { export function f(): void; }',
    'declare global { function f(): void; }',
  ]) assert.deepEqual(extract(Buffer.from(source)),
    { status: 'incomplete', reason: 'unsupported-construct' }, source);
  assert.deepEqual(extract(Buffer.from('const f = ((x: number) => x) as Fn;')),
    { status: 'incomplete', reason: 'unsupported-construct' });
  assert.deepEqual(extract(Buffer.from('const f = <Fn>((x: number) => x);')),
    { status: 'incomplete', reason: 'unsupported-construct' });
});

test('role-only declaration to implementation has no written input/output delta', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const before = extract(Buffer.from('function f(): void;'));
  const after = extract(Buffer.from('function f(): void {}'));
  assert.deepEqual(compareTypeScriptExtractions(before, after).changes, []);
});

test('deep syntax does not overflow normalization stack', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const source = `function f(x: ${'Array<'.repeat(20_000)}string${'>'.repeat(20_000)}): void {}`;
  assert.equal(extract(Buffer.from(source)).status, 'complete');
});

test('deeply nested template literal type substitutions do not overflow', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  let type = 'string';
  for (let i = 0; i < 20_000; i++) type = `\`x-\${${type}}\``;
  const source = `function f(x: ${type}): void {}`;
  const result = extract(Buffer.from(source));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') {
    assert.equal(result.declarations[0]!.parameters[0]!.type.state, 'written');
  }
});

test('a call wrapping a nested callback is not itself an unrepresentable class field', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { handler = register(() => {}); m(x: number): void {} }'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations.map(d => d.identity.name), ['m']);
});

test('legacy angle-bracket type-asserted function-valued class field is unsupported, not silently dropped', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { m = <Fn>((x: number) => x); }'));
  assert.deepEqual(result, { status: 'incomplete', reason: 'unsupported-construct' });
});
