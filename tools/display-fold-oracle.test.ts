import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from '../src/display-fold.ts';
import {
  corpusCasePath,
  FoldInputError,
  foldToLine,
  listCorpusCases,
  parseFoldInput,
} from './display-fold-oracle.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('parseFoldInput', () => {
  it('accepts CRLF, blank lines, and a final record without a newline', () => {
    assert.deepEqual(parseFoldInput(bytes('{"a":1}\r\n\n  \r\n{"b":2}')), [{ a: 1 }, { b: 2 }]);
  });

  it('reports malformed JSON by one-based line number without quoting it', () => {
    assert.throws(
      () => parseFoldInput(bytes('{"a":1}\n{"secret": oops}\n')),
      (err: Error) => err instanceof FoldInputError && /line 2/.test(err.message) && !err.message.includes('secret'),
    );
  });

  it('rejects invalid UTF-8', () => {
    assert.throws(() => parseFoldInput(new Uint8Array([0x7b, 0xff, 0x7d])), FoldInputError);
  });
});

describe('foldToLine', () => {
  it('prints the canonical envelope and exits 0 for an ok fold', () => {
    assert.deepEqual(foldToLine([]), {
      line: '{"contract":"display-fold.v1","result":"ok","state":{"attributions":[],"coverage":[],"evidence":[],"gaps":[]}}',
      exit: 0,
    });
  });

  it('exits 1 for a refusal', () => {
    assert.equal(foldToLine(['not a record']).exit, 1);
  });
});

describe('corpusCasePath', () => {
  it('refuses names that could escape the corpus', () => {
    for (const name of ['../x', 'a/b', '', '.hidden', 'A']) assert.throws(() => corpusCasePath(name, 'input.ndjson'), FoldInputError, name);
  });
});

describe('display-fold.v1 corpus', async () => {
  const cases = await listCorpusCases();

  it('includes the spec-named and D1 cases', () => {
    for (const name of ['revision-and-gap', 'baseline-only']) assert.ok(cases.includes(name), name);
  });

  for (const name of cases) {
    it(`${name} folds to its hand-written expected envelope`, async () => {
      const input = parseFoldInput(await readFile(corpusCasePath(name, 'input.ndjson')));
      const expected = JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8'));
      const { line, exit } = foldToLine(input);
      assert.equal(line, canonicalJson(expected));
      assert.equal(exit, expected.result === 'ok' ? 0 : 1);
    });
  }
});
