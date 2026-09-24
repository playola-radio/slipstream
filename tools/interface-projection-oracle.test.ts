import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/display-fold.ts';
import { validate, type JsonSchema } from '../src/schema.ts';
import {
  InterfaceInputError,
  corpusCasePath,
  interfaceToLine,
  listCorpusCases,
  parseInterfaceInput,
} from './interface-projection-oracle.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

const SCHEMA_PATH = fileURLToPath(new URL('../contracts/interface/v1/schema.json', import.meta.url));
const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as JsonSchema;

const minimalInput = JSON.stringify({
  change_seq: '5',
  language: 'typescript',
  language_version: 'typescript.v1',
  before: { status: 'complete', declarations: [] },
  after: { status: 'complete', declarations: [] },
});

describe('parseInterfaceInput', () => {
  it('parses a valid input into a BuildInput', () => {
    const input = parseInterfaceInput(bytes(minimalInput));
    assert.equal(input.changeSeq, '5');
    assert.equal(input.language, 'typescript');
    assert.deepEqual(input.before, { status: 'complete', declarations: [] });
  });

  it('accepts null language / language_version', () => {
    const input = parseInterfaceInput(
      bytes(JSON.stringify({ change_seq: '1', language: null, language_version: null, before: { status: 'notEvaluated' }, after: { status: 'notEvaluated' } })),
    );
    assert.equal(input.language, null);
    assert.equal(input.languageVersion, null);
  });

  it('rejects invalid UTF-8', () => {
    assert.throws(() => parseInterfaceInput(new Uint8Array([0x7b, 0xff, 0x7d])), InterfaceInputError);
  });

  it('rejects malformed JSON', () => {
    assert.throws(() => parseInterfaceInput(bytes('{not json')), InterfaceInputError);
  });

  it('rejects a missing required field, naming the path', () => {
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ language: 'ts', language_version: 'ts.v1', before: { status: 'absent' }, after: { status: 'absent' } }))),
      (err: Error) => err instanceof InterfaceInputError && /change_seq/.test(err.message),
    );
  });

  it('rejects an unknown side status', () => {
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', before: { status: 'bogus' }, after: { status: 'absent' } }))),
      InterfaceInputError,
    );
  });

  it('rejects an unknown admission value', () => {
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', admission: 'nope', before: { status: 'notEvaluated' }, after: { status: 'notEvaluated' } }))),
      InterfaceInputError,
    );
  });

  it('rejects a change_seq that is not a positive decimal string', () => {
    for (const change_seq of ['0', '-1', '01', '1.5', 'abc', '']) {
      assert.throws(
        () => parseInterfaceInput(bytes(JSON.stringify({ change_seq, language: 'ts', language_version: 'ts.v1', before: { status: 'absent' }, after: { status: 'absent' } }))),
        (err: Error) => err instanceof InterfaceInputError && /change_seq/.test(err.message),
        `change_seq ${JSON.stringify(change_seq)}`,
      );
    }
  });

  it('rejects a reversed byte span (byte_end < byte_start)', () => {
    const decl = { identity: { kind: 'function', scope: [], name: 'f', guards: [] }, display_name: 'f', signature: 'f()', span: { byte_start: 2, byte_end: 1 } };
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', before: { status: 'absent' }, after: { status: 'complete', declarations: [decl] } }))),
      (err: Error) => err instanceof InterfaceInputError && /byte_end/.test(err.message),
    );
  });

  it('rejects an unsafe-integer byte offset', () => {
    const decl = { identity: { kind: 'function', scope: [], name: 'f', guards: [] }, display_name: 'f', signature: 'f()', span: { byte_start: 0, byte_end: 9007199254740992 } };
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', before: { status: 'absent' }, after: { status: 'complete', declarations: [decl] } }))),
      (err: Error) => err instanceof InterfaceInputError && /safe integer/.test(err.message),
    );
  });

  it('rejects an unknown top-level property', () => {
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', before: { status: 'absent' }, after: { status: 'absent' }, unexpected: true }))),
      (err: Error) => err instanceof InterfaceInputError && /unexpected/.test(err.message),
    );
  });

  it('rejects a property that does not apply to the side status', () => {
    assert.throws(
      () => parseInterfaceInput(bytes(JSON.stringify({ change_seq: '1', language: 'ts', language_version: 'ts.v1', before: { status: 'absent', declarations: 'bad' }, after: { status: 'absent' } }))),
      (err: Error) => err instanceof InterfaceInputError && /declarations/.test(err.message),
    );
  });
});

describe('interfaceToLine', () => {
  it('is deterministic', () => {
    const input = parseInterfaceInput(bytes(minimalInput));
    assert.equal(interfaceToLine(input), interfaceToLine(input));
  });
});

describe('corpusCasePath', () => {
  it('refuses names that could escape the corpus', () => {
    for (const name of ['../x', 'a/b', '', '.hidden', 'A']) {
      assert.throws(() => corpusCasePath(name, 'input.json'), InterfaceInputError, name);
    }
  });
});

describe('interface.v1 corpus', async () => {
  const cases = await listCorpusCases();

  it('covers the D2–D10 worked examples', () => {
    for (const name of [
      'unchanged',
      'signature-changed',
      'rename',
      'ambiguous-overloads',
      'duplicate-declaration',
      'guard-move',
      'scope-distinct',
      'swift-label-change',
      'absent-before',
      'empty-before',
      'before-parse-error',
      'before-blob-missing',
      'no-module',
      'no-module-blob-missing',
      'overloaded-skip',
      'row-ordering',
    ]) {
      assert.ok(cases.includes(name), name);
    }
  });

  for (const name of cases) {
    it(`${name} builds to its hand-written expected envelope`, async () => {
      const input = parseInterfaceInput(await readFile(corpusCasePath(name, 'input.json')));
      const expected = JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8'));
      assert.equal(interfaceToLine(input), canonicalJson(expected));
    });

    it(`${name} expected.json validates against interface.v1 schema`, async () => {
      const expected = JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8'));
      assert.deepEqual(validate(schema, expected), []);
    });
  }
});
