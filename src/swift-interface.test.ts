import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { compareV2 } from './interface-v2-core.ts';
import { extractSwiftSides, SWIFT_V1, SwiftExtractCancelled, SwiftExtractTimeout } from './swift-interface.ts';

const corpus = new URL('../contracts/interface/v2/cases/', import.meta.url);
type Snapshot = { kind: 'content'; sha256: string } | { kind: 'absent' };
type FixtureFile = { path: string; status: string; fallback_reason?: string; changes: unknown[] };
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
        assert.equal((file.fallback_reason.startsWith('before-') ? before : after).status, 'incomplete', name);
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

test('nested #if guards are syntactic and all branches are extracted', async () => {
  const source = '#if A\n#if B\nfunc f() {}\n#elseif C\nfunc g() {}\n#else\nfunc h() {}\n#endif\n#endif\n';
  const side = (await extractSwiftSides([{ id: 'one', bytes: Buffer.from(source) }])).get('one')!;
  assert.equal(side.status, 'complete');
  if (side.status !== 'complete') return;
  assert.deepEqual(side.declarations.map((d) => d.identity.guards), [
    ['A', 'B'], ['A', '!(B) && C'], ['A', '!(B) && !(C)'],
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
