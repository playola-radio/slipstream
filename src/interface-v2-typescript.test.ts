import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypeScriptInterfaceExtractor, verifyTypeScriptGrammarArtifact } from './interface-v2-typescript.ts';
import { compareTypeScriptExtractions } from './interface-v2-comparison.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const corpus = fileURLToPath(new URL('../contracts/interface/v2/cases/', import.meta.url));

test('reproduces each source-bearing TypeScript v2 case from captured blobs', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const cases = (await readdir(corpus)).sort();
  const checked: string[] = [];
  for (const name of cases) {
    const dir = join(corpus, name);
    let expectedBytes: string;
    try {
      expectedBytes = await readFile(join(dir, 'expected.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const history = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')) as {
      blobs: Record<string, string>;
    };
    const expected = JSON.parse(expectedBytes) as {
      files: Array<{
        path: string;
        before: { kind: string; snapshot?: { kind: string; sha256?: string } };
        after: { kind: string; snapshot?: { kind: string; sha256?: string } };
        status: string;
        fallback_reason?: string;
        changes: unknown[];
      }>;
    };
    for (const file of expected.files) {
      if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx')) continue;
      if (file.status !== 'ready' && file.status !== 'incomplete') continue;
      const side = (endpoint: typeof file.before) => {
        if (endpoint.snapshot?.kind === 'absent') return { status: 'absent' as const };
        const text = endpoint.snapshot?.sha256 && history.blobs[endpoint.snapshot.sha256];
        assert.notEqual(text, undefined, `${name}: missing captured source`);
        return extract(Buffer.from(text!));
      };
      const actual = compareTypeScriptExtractions(side(file.before), side(file.after));
      assert.equal(actual.status, file.status, name);
      assert.equal(actual.fallback_reason, file.fallback_reason, name);
      assert.deepEqual(actual.changes, file.changes, name);
      checked.push(`${name}/${file.path}`);
    }
  }
  assert.deepEqual(checked, [
    'range-all-failed-page/src/a.ts',
    'range-cancelled-mid-page/src/a.ts',
    'range-deadline-mid-page/src/a.ts',
    'range-gap-before-b/src/f.ts', 'range-gap-cap/src/f.ts',
    'range-page-boundary-first/src/a.ts', 'range-page-boundary-second/src/b.ts',
    'range-rename/src/a.ts', 'range-rename/src/b.ts',
    'range-restart-reconciliation/src/f.ts', 'range-unknown-scopes/src/f.ts',
    'ts-added-file/src/f.ts', 'ts-added-function/src/f.ts',
    'ts-constructor-change/src/f.ts', 'ts-destructured-param/src/f.ts',
    'ts-inferred-return/src/f.ts', 'ts-known-path-incomplete-baseline/src/f.ts',
    'ts-optional-rest-default/src/f.ts', 'ts-overload-ambiguity/src/f.ts',
    'ts-parameter-change/src/f.ts', 'ts-parameter-reorder/src/f.ts',
    'ts-parse-failure/src/f.ts', 'ts-removed-file/src/f.ts',
    'ts-removed-function/src/f.ts', 'ts-return-change/src/f.ts',
    'ts-shared-type-only/src/types/user.ts', 'ts-unchanged-signature/src/f.ts',
    'ts-unicode-span/src/f.ts',
  ]);
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
  assert.doesNotThrow(() => verifyTypeScriptGrammarArtifact('typescript'));
  assert.doesNotThrow(() => verifyTypeScriptGrammarArtifact('tsx'));
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

test('constructor parameter properties keep their written modifiers', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('class C { constructor(public readonly x: number) {} }'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.declarations[0]!.parameters[0]!.modifiers,
    ['public', 'readonly']);
});

test('normalization keeps adjacent operator tokens from merging', async () => {
  const extract = await createTypeScriptInterfaceExtractor('typescript');
  const result = extract(Buffer.from('function f(x: number = a + +b): void {}'));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.match(result.declarations[0]!.parameters[0]!.default!, /\+\s+\+/);
});
