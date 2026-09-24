import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSwiftParseChild, swiftFixturePath, SwiftChildError, SwiftFixtureError } from './swift-parse.ts';
import { EXPECTED_SHA256, EXPECTED_ABI } from '../src/swift-grammar.ts';
import type { HostResult } from './swift-parse-host.ts';

// End-to-end coverage for loading and parsing the Swift grammar. Every case runs
// inside the isolated --liftoff-only child (the test runner itself never loads
// Swift), so these live under test:tools and spawn a child per case.

function only<T extends HostResult['op']>(op: T, r: HostResult): Extract<HostResult, { op: T }> {
  assert.equal(r.op, op);
  return r as Extract<HostResult, { op: T }>;
}

test('loads the pinned artifact and parses clean Swift', async () => {
  const r = only('parse', await runSwiftParseChild({ op: 'parse', source: 'func greet(name: String) -> String { return name }\n' }));
  assert.equal(r.result.rootType, 'source_file');
  assert.equal(r.result.clean, true);
  assert.equal(r.result.diagnostics.length, 0);
  assert.equal(r.provenance.sha256, EXPECTED_SHA256);
  assert.equal(r.provenance.abiVersion, EXPECTED_ABI);
  assert.equal(r.provenance.grammar.license, 'MIT');
  assert.equal(r.provenance.wrapper.license, 'Unlicense');
});

test('reports ERROR diagnostics for malformed Swift', async () => {
  const r = only('parse', await runSwiftParseChild({ op: 'parse', source: 'func f( {\n' }));
  assert.equal(r.result.clean, false);
  assert.ok(r.result.diagnostics.length >= 1);
  assert.ok(r.result.diagnostics.some((d) => d.kind === 'error' || d.kind === 'missing'));
});

test('diagnostic spans are UTF-8 byte offsets, not UTF-16 indices', async () => {
  // 'let e = "😀"\n' is 15 UTF-8 bytes (the emoji is 4 bytes / 2 UTF-16 units);
  // the malformed 'func f( {' that follows must start at byte 15, not 13.
  const source = 'let e = "😀"\nfunc f( {\n';
  const r = only('parse', await runSwiftParseChild({ op: 'parse', source }));
  const buf = Buffer.from(source, 'utf8');
  const err = r.result.diagnostics.find((d) => d.kind === 'error');
  assert.ok(err, 'expected an ERROR diagnostic');
  assert.equal(err!.byteStart, 15);
  // The byte range round-trips to the exact malformed text, independent of how
  // the converter computed it.
  assert.equal(buf.subarray(err!.byteStart, err!.byteEnd).toString('utf8'), 'func f( {');
});

test('cancels an in-progress parse and recovers in a replacement worker', async () => {
  const pathological = 'func f() {\n' + '  if x {\n'.repeat(200_000);
  const r = only('cancel-demo', await runSwiftParseChild(
    { op: 'cancel-demo', pathologicalSource: pathological, cleanSource: 'struct S { func m() {} }\n' },
    { deadlineMs: 60_000 },
  ));
  assert.equal(r.startedBeforeCancel, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.replacement.clean, true);
  assert.equal(r.replacement.rootType, 'source_file');
});

test('survives past the observed OOM window under --liftoff-only', async () => {
  const r = only('survive', await runSwiftParseChild(
    { op: 'survive', source: 'func f() {}\n', holdMs: 2_800 },
    { deadlineMs: 15_000 },
  ));
  assert.equal(r.heldMs, 2_800);
  assert.equal(r.result.clean, true);
});

test('negative control: the default Node launch aborts on the same parse', async () => {
  await assert.rejects(
    runSwiftParseChild(
      { op: 'survive', source: 'func f() {}\n', holdMs: 2_800 },
      { deadlineMs: 15_000, liftoffOnly: false },
    ),
    (err: unknown) => {
      assert.ok(err instanceof SwiftChildError, 'expected SwiftChildError');
      assert.ok(err.detail.signal !== null || (err.detail.code ?? 0) !== 0, 'expected abnormal exit');
      return true;
    },
  );
});

test('swiftFixturePath rejects invalid case names', () => {
  assert.throws(() => swiftFixturePath('../etc'), SwiftFixtureError);
  assert.throws(() => swiftFixturePath('Bad_Name'), SwiftFixtureError);
});
