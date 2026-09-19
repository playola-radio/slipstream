import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { projectClips as core, type SideInput, type ProjectOptions } from './clip-projection.ts';

import { createFunctionIndexer } from './clip-function-parser.ts';
import { languageForPath, type ClipLanguage } from './clip-language.ts';
const indexers = new Map(await Promise.all(
  (['javascript', 'jsx', 'typescript', 'tsx', 'unsupported'] as const)
    .map(async language => [language, await createFunctionIndexer(language)] as const),
));
const indexFunctions = (text: string, language: ClipLanguage) => indexers.get(language)!(text);
const projectClips = (before: SideInput, after: SideInput, opts: ProjectOptions) => core(before, after, { language: 'tsx', ...opts }, indexFunctions);

const bytes = (text: string): SideInput => ({ kind: 'bytes', bytes: Buffer.from(text) });
const project = (before: string, after: string) => projectClips(bytes(before), bytes(after), { changeSeq: '42' });

// These assertions test syntax/selection, not host scheduling. Keep the parser's
// cooperative clock deterministic; the worker/deadline suites and live benchmark
// exercise the real wall-clock limit. A separate test below advances this clock.
beforeEach(() => { mock.method(performance, 'now', () => 0); });
afterEach(() => { mock.restoreAll(); });

test('WASM progress cancellation returns a timeout and leaves the next parse usable', t => {
  let ticks = 0;
  t.mock.method(performance, 'now', () => ticks++ === 0 ? 0 : 21);
  const timed = indexFunctions('function f() {\n' + 'let a=1;\n'.repeat(1000) + '}\n', 'typescript');
  assert.equal(timed.reason, 'timeout');
  t.mock.method(performance, 'now', () => 0);
  assert.equal(indexFunctions('function f() { return 1; }', 'typescript').functions.length, 1);
});

test('extracts the enclosing function for JavaScript, JSX, TypeScript and TSX syntax', () => {
  for (const [language, source] of [
    ['javascript', 'function greet() {\n  return "old";\n}\n'],
    ['jsx', 'const Greet = () => {\n  return <div>old</div>;\n};\n'],
    ['typescript', 'function greet(name: string): string {\n  return "old";\n}\n'],
    ['tsx', 'const Greet = (props: {name: string}) => {\n  return <div>old</div>;\n};\n'],
  ] as const) {
    const after = source.replace('old', 'new');
    const p = projectClips(bytes(source), bytes(after), { changeSeq: '42', language });
    assert.equal(p.status, 'ready', source);
    assert.equal(p.projection_version, 'clip.v3');
    assert.equal(p.fallback_reason, undefined);
    assert.equal(p.clips.length, 1);
    for (const side of ['before', 'after'] as const) {
      assert.equal(p.clips[0]![side].method, 'function');
      assert.equal(p.clips[0]![side].span!.line_start, 1);
      assert.equal(p.clips[0]![side].span!.line_end, 3);
    }
  }
});

test('language selection is a closed set and unsupported files keep bounded fallback', () => {
  for (const [path, language] of Object.entries({
    'a.js': 'javascript', 'a.mjs': 'javascript', 'a.cjs': 'javascript',
    'a.jsx': 'jsx', 'a.ts': 'typescript', 'a.mts': 'typescript', 'a.cts': 'typescript',
    'a.tsx': 'tsx', 'A.TSX': 'tsx', 'a.py': 'unsupported', 'README': 'unsupported',
  })) assert.equal(languageForPath(path), language);
  const p = projectClips(bytes('def f():\n  return 1\n'), bytes('def f():\n  return 2\n'),
    { changeSeq: '42', language: 'unsupported' });
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'unsupported-language');
  assert.equal(p.clips[0]!.after.reason, 'unsupported-language');
});

test('a supported source above 32 KiB still extracts', () => {
  const source = '// ' + 'x'.repeat(40_000) + '\nfunction f() {\n  return 1;\n}\n';
  const p = project(source, source.replace('return 1', 'return 2'));
  assert.equal(p.status, 'ready');
  assert.equal(p.clips[0]!.after.span!.line_start, 2);
});

test('function expressions, generators and methods retain enclosing function spans', () => {
  for (const language of ['javascript', 'typescript', 'tsx'] as const) {
    for (const source of [
      'const f = function() {\n  return 1;\n};\n',
      'const f = function*() {\n  yield 1;\n};\n',
      'function* f() {\n  yield 1;\n}\n',
      'class C {\n  f() {\n    return 1;\n  }\n}\n',
    ]) {
      const p = projectClips(bytes(source), bytes(source.replace('1;', '2;')),
        { changeSeq: '42', language });
      assert.equal(p.status, 'ready', `${language}: ${source}`);
      assert.equal(p.clips[0]!.after.method, 'function');
      assert.equal(p.clips[0]!.after.span!.line_start, source.startsWith('class') ? 2 : 1);
      assert.equal(p.clips[0]!.after.span!.line_end, source.startsWith('class') ? 4 : 3);
    }
  }
});

test('shared-line top-level edits fall back instead of borrowing a preceding function', () => {
  const before = 'function f() { return 0; } const x = 1;\n';
  const after = 'function f() { return 0; } const x = ;\n';
  const p = project(before, after);
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'no-enclosing-function');
  assert.equal(p.clips[0]!.before.method, 'changed-range');
  assert.equal(p.clips[0]!.before.reason, 'no-enclosing-function');
  assert.equal(p.clips[0]!.after.method, 'changed-range');
  assert.equal(p.clips[0]!.after.reason, 'parse-error-in-enclosing-scope');
});

test('a shared-line function rename does not omit the following function body', () => {
  const before = 'function a() {return 1;} function b() {\n return 2;\n}\n';
  const after = before.replace('function b', 'function c');
  const p = project(before, after);
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'no-enclosing-function');
  assert.equal(p.clips[0]!.after.method, 'changed-range');
  assert.equal(p.clips[0]!.after.span!.line_end, 3);
});

test('a shared-line top-level edit beside an assigned arrow falls back', () => {
  const before = 'const fn = () => 1; const top = 2;\n';
  const after = before.replace('top = 2', 'top = 3');
  const p = project(before, after);
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'no-enclosing-function');
  assert.equal(p.clips[0]!.after.method, 'changed-range');
});

test('a contiguous top-level edit on a function closing line remains a fallback', () => {
  const before = 'function f() {\n return 1;\n} const x = 1;\n';
  const after = before.replace('return 1', 'return 2').replace('x = 1', 'x = 2');
  const p = project(before, after);
  assert.equal(p.status, 'fallback');
  assert.ok(p.clips.some(c => c.after.method === 'changed-range' && c.after.span?.line_end === 3));
});

test('indented CRLF method boundaries remain function-derived', () => {
  const before = 'class C {\r\n  method() {\r\n    return 1;\r\n  }\r\n}\r\n';
  const p = project(before, before.replace('method', 'renamed'));
  assert.equal(p.status, 'ready');
  assert.equal(p.clips[0]!.after.method, 'function');
  assert.equal(p.clips[0]!.after.span!.line_start, 2);
  assert.equal(p.clips[0]!.after.span!.line_end, 4);
});

test('extracts a bounded changed function when fallback context starts with an oversized top-level comment', () => {
  const source = '// ' + 'x'.repeat(70_000) + '\nfunction f() {\n  return 1;\n}\n';
  const p = project(source, source.replace('return 1', 'return 2'));
  assert.equal(p.status, 'ready');
  for (const side of ['before', 'after'] as const) {
    assert.equal(p.clips[0]![side].method, 'function');
    assert.equal(p.clips[0]![side].span!.line_start, 2);
  }
});

test('retains a bounded changed-range fallback when an enclosing function header is oversized', () => {
  const header = 'function f(/* ' + 'x'.repeat(70_000) + ' */) {';
  const body = Array.from({ length: 21 }, (_, i) => `  const v${i} = ${i};`);
  const before = [header, ...body, '  return 1;', '}'].join('\n') + '\n';
  const after = before.replace('return 1', 'return 2');
  const index = { functions: [{ s0: 0, e0: body.length + 3, c0: 0, c1: 1 }], errors: [] };
  const p = core(bytes(before), bytes(after), { changeSeq: '42', language: 'typescript' }, () => index);
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'function-clip-too-large');
  for (const side of ['before', 'after'] as const) {
    assert.equal(p.clips[0]![side].method, 'changed-range');
    assert.equal(p.clips[0]![side].reason, 'function-clip-too-large');
    assert.equal(p.clips[0]![side].span!.line_start, 3);
  }
});

test('parser faults retain their transient reason when no prepared fallback clip fits', () => {
  const source = '// ' + 'x'.repeat(70_000) + '\nfunction f() {\n  return 1;\n}\n';
  const after = source.replace('return 1', 'return 2');
  for (const { extractor, reason } of [
    { extractor: () => ({ functions: [], errors: [], reason: 'timeout' }), reason: 'timeout' },
    { extractor: () => { throw new Error('parser failure'); }, reason: 'worker-error' },
  ]) {
    const p = core(bytes(source), bytes(after), { changeSeq: '42', language: 'typescript' }, extractor);
    assert.equal(p.status, 'skipped');
    assert.equal(p.fallback_reason, reason);
    assert.deepEqual(p.clips, []);
  }
});

test('a parse timeout returns prepared ranges and explicit transient reasons', () => {
  const p = core(bytes('function f() {\n return 1;\n}\n'), bytes('function f() {\n return 2;\n}\n'),
    { changeSeq: '42', language: 'typescript' }, () => ({ functions: [], errors: [], reason: 'timeout' }));
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'timeout');
  assert.equal(p.clips[0]!.after.reason, 'timeout');
  assert.ok(p.clips[0]!.after.span);
});

test('counterpart selection charges its function scan to the extraction budget', () => {
  const before = 'function f() {\n}\n';
  const after = 'function f() {\n  added();\n}\n';
  const many = (end: number) => Array.from({ length: 200_000 }, () => ({ s0: 0, e0: end, c0: 0, c1: 1 }));
  let calls = 0;
  const p = core(bytes(before), bytes(after), { changeSeq: '42', language: 'typescript' }, () =>
    ({ functions: many(++calls === 1 ? 2 : 3), errors: [] }));
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'extraction-budget-exhausted');
});

test('an error elsewhere does not discard a usable enclosing function', () => {
  const source = 'function good() {\n  return 1;\n}\n\nconst broken = ;\n';
  const p = project(source, source.replace('return 1', 'return 2'));
  assert.equal(p.clips[0]!.before.method, 'function');
  assert.equal(p.clips[0]!.after.method, 'function');
  assert.equal(p.clips[0]!.after.span!.line_end, 3);
});

test('an unreliable enclosing function falls back with a per-side reason', () => {
  const p = project('function f() {\n  return 1;\n}\n', 'function f() {\n  return (\n}\n');
  assert.equal(p.status, 'fallback');
  assert.ok(p.fallback_reason);
  assert.equal(p.clips[0]!.after.method, 'changed-range');
  assert.ok(p.clips[0]!.after.reason);
});

test('function spans preserve raw UTF-8, BOM and CRLF bytes', () => {
  const source = '\uFEFF// café 😀\r\nfunction f() {\r\n  return "é";\r\n}\r\n';
  const p = project(source, source.replace('"é"', '"你好"'));
  assert.equal(p.status, 'ready');
  const span = p.clips[0]!.before.span!;
  assert.equal(Buffer.from(source).subarray(span.byte_start, span.byte_end).toString(),
    'function f() {\r\n  return "é";\r\n}\r\n');
});

test('one change can edit imports and several functions and delete another function', () => {
  const before = [
    'import { a } from "a";', '',
    'function first() {', '  return 1;', '}', '',
    'function removed() {', '  return 9;', '}', '',
    'function last() {', '  return 3;', '}', '',
  ].join('\n');
  const after = before.replace('{ a }', '{ b }')
    .replace('return 1', 'return 2').replace('return 3', 'return 4')
    .replace('function removed() {\n  return 9;\n}\n', '');
  const p = project(before, after);
  assert.equal(p.change_seq, '42');
  assert.equal(p.status, 'fallback');
  assert.ok(p.fallback_reason);
  assert.ok(p.clips.length >= 4);
  const removed = p.clips.find(c => c.before.method === 'function' && c.before.span?.line_start === 7);
  assert.ok(removed);
  assert.equal(removed.after.span, null);
  assert.ok(p.clips.some(c => c.before.method === 'changed-range' && c.before.reason));
  assert.ok(p.clips.some(c => c.before.method === 'function' && c.after.method === 'function'));
});

test('created and deleted files split multiple functions with null counterpart spans', () => {
  const source = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
  for (const deleted of [false, true]) {
    const p = projectClips(deleted ? bytes(source) : { kind: 'absent' },
      deleted ? { kind: 'absent' } : bytes(source), { changeSeq: '42' });
    assert.equal(p.status, 'ready');
    assert.equal(p.clips.length, 2);
    for (const clip of p.clips) {
      assert.equal(clip[deleted ? 'after' : 'before'].span, null);
      assert.equal(clip[deleted ? 'before' : 'after'].method, 'function');
    }
  }
});

test('function extraction obeys shared per-side caps and discloses omitted functions', () => {
  const before = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
  const p = projectClips(bytes(before), bytes(before.replace('return 1', 'return 8').replace('return 2', 'return 9')),
    { changeSeq: '42', maxLinesPerSide: 3 });
  assert.equal(p.clips.length, 1);
  for (const side of ['before', 'after'] as const) {
    assert.equal(p.clips[0]![side].method, 'function');
    assert.equal(p.clips[0]![side].span!.truncated, true);
    assert.equal(p.clips[0]![side].span!.line_end, 3);
  }
});

test('body insertions pair enclosing functions, whole new functions keep a null side', () => {
  const before = 'function f() {\n  return 1;\n}\n';
  const inserted = project(before, before.replace('  return', '  console.log(1);\n  return'));
  assert.equal(inserted.status, 'ready');
  assert.equal(inserted.clips[0]!.before.method, 'function');
  assert.equal(inserted.clips[0]!.after.method, 'function');
  const added = project(before, 'function newFunction() { return 2; }\n' + before);
  assert.equal(added.status, 'ready');
  assert.equal(added.clips[0]!.before.span, null);
});

test('parser faults retain prepared fallback and remain explicitly transient', () => {
  const p = core(bytes('old\n'), bytes('new\n'), { changeSeq: '42', language: 'typescript' }, () => { throw new Error('parser failure'); });
  assert.equal(p.status, 'fallback');
  assert.equal(p.fallback_reason, 'worker-error');
  assert.ok(p.clips[0]!.after.span);
});

test('expanded function clips obey the whole-array byte budget', () => {
  const source = 'function f() {\n' + '  // '.concat('x'.repeat(4_000), '\n').repeat(30) + '  return 1;\n}\n';
  const p = project(source, source.replace('return 1', 'return 2'));
  assert.equal(p.clips[0]!.after.method, 'function');
  for (const side of ['before', 'after'] as const) {
    assert.ok(p.clips[0]![side].span!.truncated);
    assert.ok(p.clips.reduce((n, c) => n + (c[side].span ? c[side].span!.byte_end - c[side].span!.byte_start : 0), 0) <= 64 * 1024);
  }
});

test('omitted before content is disclosed even when every emitted before span is null', () => {
  const before = 'function existing() {\n  return 1;\n}\n';
  const after = 'function added() {\n  const a = 1;\n  return a;\n}\n\n' + before.replace('return 1', 'return 2');
  const p = projectClips(bytes(before), bytes(after), { changeSeq: '42', maxLinesPerSide: 3 });
  assert.equal(p.clips[0]!.before.span, null);
  assert.equal(p.status, 'fallback');
  assert.match(p.fallback_reason!, /truncated-before/);
});
