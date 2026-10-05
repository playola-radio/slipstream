import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSwiftParseChild, swiftFixturePath, SwiftChildError, SwiftFixtureError } from '../src/swift-parse.ts';
import { EXPECTED_SHA256, EXPECTED_ABI } from '../src/swift-grammar.ts';
import type { HostResult } from '../src/swift-parse-host.ts';
import { runInWorker } from '../src/swift-parse-host.ts';

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

test('reports a clean result for a valid synthetic tree larger than the former diagnostic budget', async () => {
  // One declaration produces several Tree-sitter nodes. This intentionally
  // exceeds the former 500,000-node diagnostic-walk cap without containing an
  // error: a large valid file must still receive its parse report.
  const source = Array.from({ length: 125_000 }, (_, i) => `let value${i} = ${i}\n`).join('');
  const r = only('parse', await runSwiftParseChild({ op: 'parse', source }, { deadlineMs: 60_000 }));
  assert.equal(r.result.clean, true);
  assert.deepEqual(r.result.diagnostics, []);
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
  assert.equal(r.inProgressAtCancel, true, 'the pathological parse must still be running when terminated');
  assert.ok(r.terminateMs >= 0, 'termination time must be measured');
  assert.equal(r.replacement.clean, true);
  assert.equal(r.replacement.rootType, 'source_file');
});

test('cancel-demo reports inProgressAtCancel:false when the parse finished first', async () => {
  // A trivially fast "pathological" source completes long before the 150ms beat.
  // The worker sets its shared progress flag the instant the parse returns, so
  // the host reads finished()===true regardless of its own event-loop timing and
  // must honestly report inProgressAtCancel:false rather than a false positive.
  const r = only('cancel-demo', await runSwiftParseChild(
    { op: 'cancel-demo', pathologicalSource: 'func f() {}\n', cleanSource: 'struct S {}\n' },
    { deadlineMs: 60_000 },
  ));
  assert.equal(r.startedBeforeCancel, true);
  assert.equal(r.inProgressAtCancel, false, 'a parse that finished before the beat must not be claimed as in-progress');
  assert.equal(r.replacement.clean, true);
});

test('an already-aborted signal never launches work', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runSwiftParseChild({ op: 'parse', source: 'func f() {}\n' }, { signal: controller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof SwiftChildError, 'expected SwiftChildError');
      assert.match(err.message, /aborted before start/);
      return true;
    },
  );
});

test('a worker startup error rejects the cancellation started-wait promptly', async () => {
  const crashingWorker = new URL('data:text/javascript,throw new Error("startup failed")');
  const parse = runInWorker('func f() {}\n', crashingWorker);
  await assert.rejects(parse.started, /startup failed/);
  await parse.worker.terminate();
});

test('cancelling mid-stdin-write rejects cleanly, never crashes the caller with EPIPE', async () => {
  // A ~10MB request that the deadline kills while stdin is still draining used to
  // surface an uncaught `write EPIPE`; it must now come back as a SwiftChildError.
  await assert.rejects(
    runSwiftParseChild({ op: 'parse', source: 'x'.repeat(10_000_000) }, { deadlineMs: 1 }),
    SwiftChildError,
  );
});

test('survives past the observed OOM window under --liftoff-only', async () => {
  const r = only('survive', await runSwiftParseChild(
    { op: 'survive', source: 'func f() {}\n', holdMs: 2_800 },
    { deadlineMs: 15_000 },
  ));
  assert.equal(r.heldMs, 2_800);
  assert.equal(r.result.clean, true);
});

// The delayed V8 tier-up OOM was observed empirically on darwin (arm64, Node
// 24.11.0); on ubuntu CI the default launch does NOT reproduce it — the same
// parse loads and survives the hold there (the `survive` test above passes on
// Linux too). So this negative control, which asserts the ABORT, is darwin-only;
// the --liftoff-only isolation is a darwin-motivated precaution applied
// uniformly. See SWIFT-GRAMMAR.md.
test('negative control: the default Node launch aborts on the same parse', { skip: process.platform !== 'darwin' ? 'the V8 tier-up OOM is a darwin-only observation; the default launch does not abort on Linux CI' : false }, async () => {
  await assert.rejects(
    runSwiftParseChild(
      { op: 'survive', source: 'func f() {}\n', holdMs: 2_800 },
      { deadlineMs: 15_000, liftoffOnly: false },
    ),
    (err: unknown) => {
      assert.ok(err instanceof SwiftChildError, 'expected SwiftChildError');
      // A V8 fatal OOM kills via a signal (observed SIGTRAP), never a clean
      // exit-2 (signal null) and never our deadline SIGKILL.
      assert.ok(err.detail.signal !== null, 'expected a fatal signal, not a clean exit');
      assert.notEqual(err.detail.signal, 'SIGKILL', 'a SIGKILL would be our deadline, not the OOM');
      return true;
    },
  );
});

test('swiftFixturePath rejects invalid case names', () => {
  assert.throws(() => swiftFixturePath('../etc'), SwiftFixtureError);
  assert.throws(() => swiftFixturePath('Bad_Name'), SwiftFixtureError);
});
