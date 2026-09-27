import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareV2, type V2Declaration } from './interface-v2-core.ts';

const parameter = (name: string, text: string, position = 0) => ({
  position, label: '_', name, binding: 'identifier' as const,
  type: { state: 'written' as const, text }, optional: false, variadic: false,
  default: null, modifiers: [],
});

function declaration(name: string, type: string, span = 0): V2Declaration {
  return {
    identity: { kind: 'function', scope: [], name, guards: [] },
    displayName: `${name}(_:)`, span: { byteStart: span, byteEnd: span + 20 },
    signature: JSON.stringify([type]), parameters: [parameter('x', type)],
    result: { kind: 'return', type: { state: 'implicit', text: 'Void' } },
    throws: { mode: 'none' }, header: { modifiers: [], generic_parameters: [], constraints: [] },
  };
}

test('v2 compares changed parameter components using the written local name', () => {
  const result = compareV2([declaration('f', 'Int')], [declaration('f', 'String')]);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.kind, 'signatureChanged');
  assert.deepEqual(result.changes[0]!.parameters, [{
    op: 'changed', before: parameter('x', 'Int'), after: parameter('x', 'String'),
  }]);
  assert.equal(result.changes[0]!.result?.op, 'equal');
});

test('v2 exact matches disappear and ambiguous overload remainders refuse the file', () => {
  assert.deepEqual(compareV2([declaration('f', 'Int')], [declaration('f', 'Int')]), { status: 'ready', changes: [] });
  assert.deepEqual(compareV2([declaration('f', 'Int'), declaration('f', 'String')], [declaration('f', 'Bool')]),
    { status: 'incomplete', reason: 'ambiguous-correspondence' });
  assert.deepEqual(compareV2([declaration('f', 'Int'), declaration('f', 'Int', 50)], []),
    { status: 'incomplete', reason: 'duplicate-declaration' });
});

test('v2 renamed and wildcard parameters are removed then added in position order', () => {
  const before = declaration('f', 'Int');
  before.parameters = [{ ...parameter('_', 'Int', 0), binding: 'wildcard' }, parameter('old', 'String', 1)];
  before.signature = 'before';
  const after = declaration('f', 'Int');
  after.parameters = [{ ...parameter('_', 'Int', 0), binding: 'wildcard' }, parameter('new', 'String', 1)];
  after.signature = 'after';
  const result = compareV2([before], [after]);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.changes[0]!.parameters.map((p) => p.op), ['removed', 'removed', 'added', 'added']);
});

test('v2 constructor result remains null when added', () => {
  const constructor = declaration('constructor', 'Int');
  constructor.identity.kind = 'constructor';
  constructor.result = null;
  const result = compareV2([], [constructor]);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.changes[0]!.result, null);
});

test('v2 order uses scope tuple with shorter prefix first', () => {
  const shallow = declaration('f', 'Int');
  shallow.identity.scope = [{ kind: 'class', name: 'C' }];
  const deep = declaration('f', 'Int');
  deep.identity.scope = [{ kind: 'class', name: 'C' }, { kind: 'struct', name: 'Inner' }];
  const result = compareV2([], [deep, shallow]);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.changes[0]!.identity.scope.length, 1);
});

test('v2 orders same-name removed overloads by signature before source span (D8)', () => {
  const first = declaration('f', 'String', 0);
  const second = declaration('f', 'Int', 23);
  const result = compareV2([first, second], []);
  assert.equal(result.status, 'ready');
  // D8 compares signature before span: 'Int' < 'String', so the span-23
  // declaration sorts first despite its later position in the source.
  if (result.status === 'ready') assert.deepEqual(result.changes.map((c) => c.before?.span.byte_start), [23, 0]);
});
