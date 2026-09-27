import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { compareV2 } from './interface-v2-core.ts';
import { extractSwiftSides, SWIFT_V1, SwiftExtractCancelled, SwiftExtractTimeout } from './swift-interface.ts';

const corpus = new URL('../contracts/interface/v2/cases/', import.meta.url);
type Snapshot = { kind: 'content'; sha256: string } | { kind: 'absent' };
type FixtureFile = { path: string; status: string; fallback_reason?: string; changes: unknown[];
  coverage?: { before: { state: string; reason?: string }; after: { state: string; reason?: string } } };
type HistoryEvent = { type: string; data: { path?: string; snapshot?: Snapshot; before?: Snapshot; after?: Snapshot } };

test('Swift v2 metadata publishes the narrow language scope', () => {
  assert.equal(SWIFT_V1.language, 'swift');
  assert.equal(SWIFT_V1.languageVersion, 'swift.v1');
  assert.deepEqual(SWIFT_V1.extensions, ['.swift']);
  assert.ok(SWIFT_V1.exclusions.includes('local functions'));
});

test('every applicable Swift v2 fixture is reproduced from its captured source bytes', async () => {
  const names = (await readdir(corpus)).filter((n) => n.startsWith('swift-')).sort();
  assert.equal(names.length, 23, 'new corpus cases require explicit disposition');
  const boundaryOnly = new Set(['swift-capture-unavailable', 'swift-missing-blob', 'swift-unknown-boundary']);
  for (const name of names) {
    const dir = new URL(`${name}/`, corpus);
    const history = JSON.parse(await readFile(new URL('history.json', dir), 'utf8')) as {
      blobs: Record<string, string>; events: HistoryEvent[];
    };
    const expected = JSON.parse(await readFile(new URL('expected.json', dir), 'utf8')) as { files: FixtureFile[] };
    for (const file of expected.files) {
      if (file.status === 'identical' || boundaryOnly.has(name)) continue;
      // Resolve this extraction pair from the INPUT history's first and last
      // records. Expected output supplies assertions only, never source bytes.
      const records = history.events.filter((event) => event.data.path === file.path);
      assert.ok(records.length > 0, `${name}: no source records`);
      const first = records[0]!, last = records.at(-1)!;
      const beforeSnapshot = first.data.snapshot ?? first.data.before;
      const afterSnapshot = last.data.after ?? last.data.snapshot;
      assert.ok(beforeSnapshot && afterSnapshot, `${name}: missing source endpoint`);
      const source = (snapshot: Snapshot): Uint8Array | null => {
        if (snapshot.kind === 'absent') return null;
        const text = history.blobs[snapshot.sha256];
        assert.notEqual(text, undefined, `${name}: fixture content missing`);
        return Buffer.from(text!, 'utf8');
      };
      const beforeBytes = source(beforeSnapshot), afterBytes = source(afterSnapshot);
      const sides = await extractSwiftSides([
        ...(beforeBytes === null ? [] : [{ id: 'before', bytes: beforeBytes }]),
        ...(afterBytes === null ? [] : [{ id: 'after', bytes: afterBytes }]),
      ]);
      const before = beforeBytes === null ? { status: 'complete' as const, declarations: [] } : sides.get('before')!;
      const after = afterBytes === null ? { status: 'complete' as const, declarations: [] } : sides.get('after')!;
      if (file.status === 'incomplete' && file.fallback_reason?.endsWith('parse-error')) {
        const refused = file.fallback_reason.startsWith('before-') ? before : after;
        assert.deepEqual(refused, { status: 'incomplete', reason: 'parse-error' }, name);
        for (const [id, side] of [['before', before], ['after', after]] as const) {
          const expectedSide = file.coverage?.[id];
          assert.ok(expectedSide, `${name} ${id} coverage missing`);
          assert.equal(side.status, expectedSide!.state, `${name} ${id} status`);
          if (side.status === 'incomplete') assert.equal(side.reason, expectedSide!.reason, `${name} ${id} reason`);
        }
        continue;
      }
      assert.equal(before.status, 'complete', `${name} before`);
      assert.equal(after.status, 'complete', `${name} after`);
      if (before.status !== 'complete' || after.status !== 'complete') continue;
      const result = compareV2(before.declarations, after.declarations);
      if (file.status === 'incomplete') {
        assert.deepEqual(result, { status: 'incomplete', reason: file.fallback_reason }, name);
      } else {
        assert.equal(result.status, 'ready', name);
        if (result.status === 'ready') assert.deepEqual(result.changes, file.changes, name);
      }
    }
  }
});

test('Unicode before a declaration produces UTF-8 byte spans', async () => {
  const source = Buffer.from('let emoji = "😀"\nfunc f(_ x: Int) {}\n');
  const side = (await extractSwiftSides([{ id: 'one', bytes: source }])).get('one')!;
  assert.equal(side.status, 'complete');
  if (side.status !== 'complete') return;
  assert.deepEqual(side.declarations[0]!.span, { byteStart: 19, byteEnd: 38 });
});

test('typed throws and unsupported eligible constructs refuse the whole file', async () => {
  const cases = [
    ['typed', 'func f() throws(MyError) -> Int { 1 }\n', 'parse-error'],
    ['operator', 'func + (a: Int, b: Int) -> Int { a }\nfunc f() {}\n', 'unsupported-construct'],
  ];
  const results = await extractSwiftSides(cases.map(([id, source]) => ({ id: id!, bytes: Buffer.from(source!) })));
  for (const [id, , reason] of cases) assert.deepEqual(results.get(id!), { status: 'incomplete', reason });
});

test('token spacing and comments do not create a written-header change', async () => {
  const before = 'func f<T:Equatable>(_ x:T)->T where T:Hashable { x }\n';
  const after = 'func f<T: Equatable>(\n  _ x: T // parameter\n) -> T where T: Hashable { x }\n';
  const result = await extractSwiftSides([
    { id: 'before', bytes: Buffer.from(before) }, { id: 'after', bytes: Buffer.from(after) },
  ]);
  const b = result.get('before')!, a = result.get('after')!;
  assert.equal(b.status, 'complete');
  assert.equal(a.status, 'complete');
  if (b.status === 'complete' && a.status === 'complete') assert.deepEqual(compareV2(b.declarations, a.declarations), { status: 'ready', changes: [] });
});

test('parameter attributes and attributed return types produce visible component changes', async () => {
  const pairs = [
    ['func f(content: () -> Int) {}', 'func f(@ViewBuilder content: () -> Int) {}', 'parameters'],
    ['func f() -> @Sendable () -> Void { {} }',
      'func f() -> @Sendable (Int) -> String { { String($0) } }', 'result'],
  ] as const;
  for (const [before, after, component] of pairs) {
    const sides = await extractSwiftSides([
      { id: 'before', bytes: Buffer.from(before) }, { id: 'after', bytes: Buffer.from(after) },
    ]);
    const b = sides.get('before')!, a = sides.get('after')!;
    assert.equal(b.status, 'complete'); assert.equal(a.status, 'complete');
    if (b.status !== 'complete' || a.status !== 'complete') continue;
    const compared = compareV2(b.declarations, a.declarations);
    assert.equal(compared.status, 'ready');
    if (compared.status !== 'ready') continue;
    assert.equal(compared.changes.length, 1);
    const row = compared.changes[0]!;
    assert.equal(row.kind, 'signatureChanged');
    assert.equal(component === 'parameters' ? row.parameters[0]!.op : row.result?.op, 'changed');
  }
});

test('class func is a written header modifier and does not collide with an instance method', async () => {
  const sources = ['class C { func f() {} }', 'class C { class func f() {} }'];
  const sides = await extractSwiftSides(sources.map((source, i) => ({ id: String(i), bytes: Buffer.from(source) })));
  const b = sides.get('0')!, a = sides.get('1')!;
  assert.equal(b.status, 'complete'); assert.equal(a.status, 'complete');
  if (b.status !== 'complete' || a.status !== 'complete') return;
  const result = compareV2(b.declarations, a.declarations);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.deepEqual(result.changes[0]!.header.after?.modifiers, ['class']);
  const both = (await extractSwiftSides([{ id: 'both', bytes: Buffer.from('class C { func f() {}; class func f() {} }') }])).get('both')!;
  assert.equal(both.status, 'complete');
  if (both.status === 'complete') assert.equal(compareV2(both.declarations, []).status, 'ready');
  const staticSide = (await extractSwiftSides([{ id: 'static', bytes: Buffer.from('struct S { static func f() {} }') }])).get('static')!;
  assert.equal(staticSide.status, 'complete');
  if (staticSide.status === 'complete') assert.deepEqual(staticSide.declarations[0]!.header.modifiers, ['static']);
});

test('guard trivia has no effect and elseif disjunction remains grouped', async () => {
  const before = '#if A&&B\nfunc f() {}\n#endif\n';
  const after = '#if A && B // note\nfunc f() {}\n#endif\n';
  const sides = await extractSwiftSides([{ id: 'b', bytes: Buffer.from(before) }, { id: 'a', bytes: Buffer.from(after) }]);
  const b = sides.get('b')!, a = sides.get('a')!;
  assert.equal(b.status, 'complete'); assert.equal(a.status, 'complete');
  if (b.status === 'complete' && a.status === 'complete') assert.deepEqual(compareV2(b.declarations, a.declarations), { status: 'ready', changes: [] });
  const branch = (await extractSwiftSides([{ id: 'branch', bytes: Buffer.from('#if A\n#elseif B || C\nfunc g() {}\n#endif\n') }])).get('branch')!;
  assert.equal(branch.status, 'complete');
  if (branch.status === 'complete') assert.deepEqual(branch.declarations[0]!.identity.guards, ['!(A) && (B || C)']);
});

test('different operator tokens and backtick spelling cannot hide a written change', async () => {
  const sides = await extractSwiftSides([
    { id: 'b', bytes: Buffer.from('func f(x: Bool = a && b) {}') },
    { id: 'a', bytes: Buffer.from('func f(x: Bool = a & & b) {}') },
  ]);
  const b = sides.get('b')!, a = sides.get('a')!;
  assert.equal(b.status, 'complete'); assert.equal(a.status, 'complete');
  if (b.status === 'complete' && a.status === 'complete') {
    const result = compareV2(b.declarations, a.declarations);
    assert.equal(result.status, 'ready');
    if (result.status === 'ready') assert.equal(result.changes[0]?.parameters[0]?.op, 'changed');
  }
  const escaped = await extractSwiftSides([
    { id: 'b', bytes: Buffer.from('func `f`() {}') }, { id: 'a', bytes: Buffer.from('func f() {}') },
  ]);
  const e1 = escaped.get('b')!, e2 = escaped.get('a')!;
  assert.equal(e1.status, 'complete'); assert.equal(e2.status, 'complete');
  if (e1.status === 'complete' && e2.status === 'complete') assert.deepEqual(compareV2(e1.declarations, e2.declarations), { status: 'ready', changes: [] });
});

test('deep type syntax in one side does not prevent a sibling from extracting', async () => {
  const deep = 'func f(_ x: ' + '['.repeat(5_000) + 'Int' + ']'.repeat(5_000) + ') {}';
  const sides = await extractSwiftSides([
    { id: 'deep', bytes: Buffer.from(deep) }, { id: 'clean', bytes: Buffer.from('func g() {}') },
  ], { limits: { syntaxVisits: 50_000 }, deadlineMs: 30_000 });
  assert.equal(sides.get('deep')?.status, 'complete');
  assert.equal(sides.get('clean')?.status, 'complete');
});

test('non-function operator declarations and constrained named types do not refuse contained functions', async () => {
  const sources = ['infix operator +++\nfunc f() {}', 'struct S<T> where T: Equatable { func f() {} }'];
  for (const source of sources) {
    const side = (await extractSwiftSides([{ id: 'one', bytes: Buffer.from(source) }])).get('one')!;
    assert.equal(side.status, 'complete');
    if (side.status === 'complete') assert.equal(side.declarations.length, 1);
  }
});

test('nested #if guards are syntactic and all branches are extracted', async () => {
  const source = '#if A\n#if B\nfunc f() {}\n#elseif C\nfunc g() {}\n#else\nfunc h() {}\n#endif\n#endif\n';
  const side = (await extractSwiftSides([{ id: 'one', bytes: Buffer.from(source) }])).get('one')!;
  assert.equal(side.status, 'complete');
  if (side.status !== 'complete') return;
  assert.deepEqual(side.declarations.map((d) => d.identity.guards), [
    ['A', 'B'], ['A', '!(B) && (C)'], ['A', '!(B) && !(C)'],
  ]);
});

test('the child returns syntax and declaration limit outcomes without rows', async () => {
  const bytes = Buffer.from('func f() {}\n');
  for (const [limits, limit] of [
    [{ inputBytes: 0 }, 'inputBytes'], [{ declarations: 0 }, 'declarations'], [{ syntaxVisits: 0 }, 'syntaxVisits'],
  ] as const) {
    const side = (await extractSwiftSides([{ id: 'one', bytes }], { limits })).get('one');
    assert.deepEqual(side, { status: 'tooLarge', limit });
  }
});

test('a known parse error outranks a syntax-visit limit', async () => {
  const side = (await extractSwiftSides([{ id: 'bad', bytes: Buffer.from('func f(_ x: \n') }],
    { limits: { syntaxVisits: 0 } })).get('bad');
  assert.deepEqual(side, { status: 'incomplete', reason: 'parse-error' });
});

test('invalid UTF-8 refuses that side while a valid sibling still extracts', async () => {
  const results = await extractSwiftSides([
    { id: 'bad', bytes: Uint8Array.of(0xff) },
    { id: 'good', bytes: Buffer.from('func f() {}\n') },
  ]);
  assert.deepEqual(results.get('bad'), { status: 'incomplete', reason: 'parse-error' });
  assert.equal(results.get('good')?.status, 'complete');
});

test('init! keeps the failable marker and a protocol requirement span includes its semicolon', async () => {
  const source = 'struct P { init!(x: Int) {} }\nprotocol Q { func f() -> Int; func g() }\n';
  const side = (await extractSwiftSides([{ id: 'one', bytes: Buffer.from(source) }])).get('one')!;
  assert.equal(side.status, 'complete');
  if (side.status !== 'complete') return;
  assert.deepEqual(side.declarations[0]!.result, { kind: 'initializer', failable: '!' });
  const requirement = side.declarations[1]!;
  assert.equal(Buffer.from(source).subarray(requirement.span.byteStart, requirement.span.byteEnd).toString(), 'func f() -> Int;');
});

test('actor members and protocol initializers retain scope while a BOM shifts byte spans', async () => {
  const source = '\uFEFFactor A { func f() {} }\nprotocol P { init?(x: Int) }\n';
  const side = (await extractSwiftSides([{ id: 'one', bytes: Buffer.from(source) }])).get('one')!;
  assert.equal(side.status, 'complete');
  if (side.status !== 'complete') return;
  assert.deepEqual(side.declarations.map((d) => d.identity.scope), [
    [{ kind: 'actor', name: 'A' }], [{ kind: 'protocol', name: 'P' }],
  ]);
  assert.equal(side.declarations[0]!.span.byteStart, 13);
  assert.deepEqual(side.declarations[1]!.result, { kind: 'initializer', failable: '?' });
});

test('abort and deadline kill isolated extraction, then a replacement succeeds', async () => {
  const pathological = Buffer.from('func f() {\n' + '  if x {\n'.repeat(200_000));
  const controller = new AbortController();
  const pending = extractSwiftSides([{ id: 'slow', bytes: pathological }], { signal: controller.signal, deadlineMs: 60_000 });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, SwiftExtractCancelled);
  await assert.rejects(extractSwiftSides([{ id: 'slow', bytes: pathological }], { deadlineMs: 1 }), SwiftExtractTimeout);
  const replacement = await extractSwiftSides([{ id: 'clean', bytes: Buffer.from('func f() {}\n') }]);
  assert.equal(replacement.get('clean')?.status, 'complete');
});

test('an already aborted batch is cancelled even when every side has invalid UTF-8', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractSwiftSides([{ id: 'bad', bytes: Uint8Array.of(0xff) }],
    { signal: controller.signal }), SwiftExtractCancelled);
});
