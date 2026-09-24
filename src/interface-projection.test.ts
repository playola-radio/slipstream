import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInterfaceProjection,
  compare,
  type BuildInput,
  type Declaration,
  type Identity,
} from './interface-projection.ts';

function id(partial: Partial<Identity> & { name: string }): Identity {
  return { kind: 'function', scope: [], guards: [], ...partial };
}

function decl(
  name: string,
  signature: string,
  opts: { identity?: Identity; start?: number; end?: number; displayName?: string } = {},
): Declaration {
  const identity = opts.identity ?? id({ name });
  return {
    identity,
    displayName: opts.displayName ?? name,
    signature,
    span: { byteStart: opts.start ?? 0, byteEnd: opts.end ?? signature.length },
  };
}

function ready(before: Declaration[], after: Declaration[]): BuildInput {
  return {
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'complete', declarations: before },
    after: { status: 'complete', declarations: after },
  };
}

// ---- D3 correspondence ------------------------------------------------------

test('unchanged declarations produce no rows (exact match)', () => {
  const p = buildInterfaceProjection(ready([decl('f', 'f()')], [decl('f', 'f()')]));
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.changes, []);
});

test('body-only edit (same signature) emits no row', () => {
  const before = decl('f', 'f(): void', { start: 0, end: 20 });
  const after = decl('f', 'f(): void', { start: 0, end: 40 });
  const p = buildInterfaceProjection(ready([before], [after]));
  assert.deepEqual(p.changes, []);
});

test('same-scope reorder emits no rows', () => {
  const p = buildInterfaceProjection(
    ready([decl('a', 'a()'), decl('b', 'b()')], [decl('b', 'b()'), decl('a', 'a()')]),
  );
  assert.deepEqual(p.changes, []);
});

test('added declaration', () => {
  const p = buildInterfaceProjection(ready([], [decl('f', 'f()')]));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]!.kind, 'added');
  assert.equal(p.changes[0]!.before, null);
  assert.equal(p.changes[0]!.after!.display_name, 'f');
});

test('removed declaration', () => {
  const p = buildInterfaceProjection(ready([decl('f', 'f()')], []));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]!.kind, 'removed');
  assert.equal(p.changes[0]!.after, null);
});

test('signature change on same identity is signatureChanged', () => {
  const before = decl('f', 'f(x = 1)');
  const after = decl('f', 'f(x = 2)');
  const p = buildInterfaceProjection(ready([before], [after]));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]!.kind, 'signatureChanged');
  assert.equal(p.changes[0]!.before!.signature, 'f(x = 1)');
  assert.equal(p.changes[0]!.after!.signature, 'f(x = 2)');
});

test('rename is removed + added, never a rename row', () => {
  const p = buildInterfaceProjection(ready([decl('old', 'old()')], [decl('new', 'new()')]));
  const kinds = p.changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['added', 'removed']);
});

test('two changed overloads of one name are ambiguous → incomplete, no rows', () => {
  const before = [decl('f', 'f(a: number)'), decl('f', 'f(a: string)')];
  const after = [decl('f', 'f(a: number, b: number)'), decl('f', 'f(a: string, b: string)')];
  const p = buildInterfaceProjection(ready(before, after));
  assert.equal(p.status, 'incomplete');
  assert.equal(p.fallback_reason, 'ambiguous-correspondence');
  assert.deepEqual(p.changes, []);
});

test('2 unmatched before / 1 unmatched after is ambiguous', () => {
  const before = [decl('f', 'f(a)'), decl('f', 'f(b)')];
  const after = [decl('f', 'f(c)')];
  const p = buildInterfaceProjection(ready(before, after));
  assert.equal(p.fallback_reason, 'ambiguous-correspondence');
});

test('one overload changes while the other is stable → single signatureChanged', () => {
  const before = [decl('f', 'f(a: number)'), decl('f', 'f(a: string)')];
  const after = [decl('f', 'f(a: number)'), decl('f', 'f(a: string, b: string)')];
  const p = buildInterfaceProjection(ready(before, after));
  assert.equal(p.status, 'ready');
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]!.kind, 'signatureChanged');
});

test('duplicate on a side → incomplete/duplicate-declaration, no rows', () => {
  const before = [decl('f', 'f()'), decl('f', 'f()')];
  const p = buildInterfaceProjection(ready(before, [decl('f', 'f()')]));
  assert.equal(p.status, 'incomplete');
  assert.equal(p.fallback_reason, 'duplicate-declaration');
  assert.deepEqual(p.changes, []);
});

test('guards participate in identity: #if move is removed + added', () => {
  const before = decl('trace', 'trace()', { identity: id({ name: 'trace', guards: ['DEBUG'] }) });
  const after = decl('trace', 'trace()', { identity: id({ name: 'trace', guards: ['!(DEBUG)'] }) });
  const p = buildInterfaceProjection(ready([before], [after]));
  const kinds = p.changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['added', 'removed']);
});

test('same name in different scopes are distinct declarations', () => {
  const inP = decl('read', 'read()', {
    identity: id({ name: 'read', scope: [{ kind: 'protocol', name: 'P' }] }),
  });
  const inBox = decl('read', 'read()', {
    identity: id({ name: 'read', scope: [{ kind: 'extension', name: 'Box' }] }),
  });
  // Remove the protocol one, keep the Box one.
  const p = buildInterfaceProjection(ready([inP, inBox], [inBox]));
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0]!.kind, 'removed');
  assert.deepEqual(p.changes[0]!.identity.scope, [{ kind: 'protocol', name: 'P' }]);
});

// ---- D8 ordering ------------------------------------------------------------

test('rows sort removed, then signatureChanged, then added; ties by tuple', () => {
  const before = [decl('gone', 'gone()'), decl('chg', 'chg(1)'), decl('bgone', 'bgone()')];
  const after = [decl('chg', 'chg(2)'), decl('znew', 'znew()'), decl('anew', 'anew()')];
  const p = buildInterfaceProjection(ready(before, after));
  assert.deepEqual(
    p.changes.map((c) => [c.kind, c.identity.name]),
    [
      ['removed', 'bgone'],
      ['removed', 'gone'],
      ['signatureChanged', 'chg'],
      ['added', 'anew'],
      ['added', 'znew'],
    ],
  );
});

test('compare is a pure function returning ordered rows', () => {
  const r = compare([decl('b', 'b()')], [decl('a', 'a()')]);
  assert.equal(r.ambiguous, false);
  if (!r.ambiguous) {
    assert.deepEqual(r.changes.map((c) => [c.kind, c.identity.name]), [
      ['removed', 'b'],
      ['added', 'a'],
    ]);
  }
});

// ---- D5 completeness / D10 precedence --------------------------------------

test('absent before-file → ready additions, before coverage absent', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'absent' },
    after: { status: 'complete', declarations: [decl('f', 'f()')] },
  });
  assert.equal(p.status, 'ready');
  assert.equal(p.coverage.before.state, 'absent');
  assert.equal(p.changes[0]!.kind, 'added');
});

test('empty parsed before-file → ready additions, before coverage complete', () => {
  const p = buildInterfaceProjection(ready([], [decl('f', 'f()')]));
  assert.equal(p.status, 'ready');
  assert.equal(p.coverage.before.state, 'complete');
  assert.equal(p.changes[0]!.kind, 'added');
});

test('before parse error → incomplete/before-parse-error, after coverage preserved', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'incomplete', reason: 'before-parse-error' },
    after: { status: 'complete', declarations: [decl('f', 'f()')] },
  });
  assert.equal(p.status, 'incomplete');
  assert.equal(p.fallback_reason, 'before-parse-error');
  assert.equal(p.coverage.after.state, 'complete');
  assert.deepEqual(p.changes, []);
});

test('before parse error + after blob missing → before-parse-error wins', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'incomplete', reason: 'before-parse-error' },
    after: { status: 'unavailable', reason: 'after-blob-missing' },
  });
  assert.equal(p.fallback_reason, 'before-parse-error');
});

test('both parse errors → before-parse-error wins', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'incomplete', reason: 'before-parse-error' },
    after: { status: 'incomplete', reason: 'after-parse-error' },
  });
  assert.equal(p.fallback_reason, 'before-parse-error');
});

test('before blob missing → unavailable/before-blob-missing, no rows', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'unavailable', reason: 'before-blob-missing' },
    after: { status: 'complete', declarations: [decl('f', 'f()')] },
  });
  assert.equal(p.status, 'unavailable');
  assert.equal(p.fallback_reason, 'before-blob-missing');
  assert.deepEqual(p.changes, []);
});

test('no module → unsupported, language + language_version null, both coverage unsupported', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: null,
    languageVersion: null,
    before: { status: 'notEvaluated' },
    after: { status: 'notEvaluated' },
  });
  assert.equal(p.status, 'unsupported');
  assert.equal(p.fallback_reason, 'unsupported-language');
  assert.equal(p.language, null);
  assert.equal(p.language_version, null);
  assert.equal(p.coverage.before.state, 'unsupported');
  assert.equal(p.coverage.after.state, 'unsupported');
});

test('no module + missing blob → unavailable wins over unsupported, language_version null', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: null,
    languageVersion: null,
    before: { status: 'unavailable', reason: 'before-blob-missing' },
    after: { status: 'notEvaluated' },
  });
  assert.equal(p.status, 'unavailable');
  assert.equal(p.fallback_reason, 'before-blob-missing');
  assert.equal(p.language_version, null);
  assert.equal(p.coverage.before.state, 'unavailable');
  assert.equal(p.coverage.after.state, 'unsupported');
});

// ---- D7 admission ----------------------------------------------------------

test('overloaded admission → skipped/overloaded, both coverage notEvaluated', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'notEvaluated' },
    after: { status: 'notEvaluated' },
    admission: 'overloaded',
  });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'overloaded');
  assert.equal(p.coverage.before.state, 'notEvaluated');
  assert.equal(p.coverage.after.state, 'notEvaluated');
});

test('timeout admission → skipped/timeout', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'notEvaluated' },
    after: { status: 'notEvaluated' },
    admission: 'timeout',
  });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'timeout');
});

test('every non-ready status carries changes: [] and a fallback_reason', () => {
  const p = buildInterfaceProjection({
    changeSeq: '1',
    language: 'typescript',
    languageVersion: 'typescript.v1',
    before: { status: 'notEvaluated' },
    after: { status: 'notEvaluated' },
    admission: 'cancelled',
  });
  assert.deepEqual(p.changes, []);
  assert.ok(p.fallback_reason);
});

test('admission outranks a would-be-ready comparison (ready is last-resort)', () => {
  // Even if both sides look comparable, a skip disposition must win: a `ready`
  // status would falsely claim a comparison the admission gate prevented.
  const p = buildInterfaceProjection({
    ...ready([], [decl('f', 'f()')]),
    admission: 'timeout',
  });
  assert.equal(p.status, 'skipped');
  assert.equal(p.fallback_reason, 'timeout');
  assert.deepEqual(p.changes, []);
});

test('no module outranks a would-be-ready comparison', () => {
  const p = buildInterfaceProjection({
    ...ready([], [decl('f', 'f()')]),
    language: null,
    languageVersion: null,
  });
  assert.equal(p.status, 'unsupported');
  assert.equal(p.fallback_reason, 'unsupported-language');
  assert.deepEqual(p.changes, []);
});

test('ready omits fallback_reason', () => {
  const p = buildInterfaceProjection(ready([decl('f', 'f()')], [decl('f', 'f()')]));
  assert.equal('fallback_reason' in p, false);
});

test('envelope echoes change_seq and projection_version', () => {
  const input = ready([], []);
  input.changeSeq = '42';
  const p = buildInterfaceProjection(input);
  assert.equal(p.change_seq, '42');
  assert.equal(p.projection_version, 'interface.v1');
});
