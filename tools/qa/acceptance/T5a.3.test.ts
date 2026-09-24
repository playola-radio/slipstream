import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkFixtureAgainstExpected, type ExpectedCase } from './T5a.3.ts';
import type { SwiftParseResult } from '../../../src/swift-grammar.ts';

// The corpus cross-check's honesty rules are pure, so they are proven here with
// synthetic parse results — no grammar load. The live parse is exercised by the
// module itself under qa:check on darwin.

const cleanExpected: ExpectedCase = {
  description: 'clean case', category: 'd2-construct', rootType: 'source_file',
  clean: true, knownGap: false, diagnostics: [],
};
const cleanResult: SwiftParseResult = { rootType: 'source_file', clean: true, diagnostics: [], byteLength: 8 };

// '#Preview' — 8 bytes, one recorded ERROR diagnostic that slices "#Preview".
const gapBytes = Buffer.from('#Preview {\n}\n', 'utf8');
const gapExpected: ExpectedCase = {
  description: 'preview macro', category: 'd2-construct', rootType: 'source_file',
  clean: false, knownGap: true,
  diagnostics: [{ kind: 'error', nodeType: 'ERROR', byteStart: 0, byteEnd: 8, startRow: 0, startColumn: 0, endRow: 0, endColumn: 8, byteSlice: '#Preview' }],
};
const gapResult: SwiftParseResult = {
  rootType: 'source_file', clean: false, byteLength: gapBytes.length,
  diagnostics: [{ kind: 'error', nodeType: 'ERROR', byteStart: 0, byteEnd: 8, startRow: 0, startColumn: 0, endRow: 0, endColumn: 8 }],
};

describe('checkFixtureAgainstExpected', () => {
  it('accepts a clean fixture that matches its envelope', () => {
    assert.doesNotThrow(() => checkFixtureAgainstExpected('ok', Buffer.from('func f(){}'), cleanExpected, cleanResult));
  });

  it('accepts a known-gap fixture whose byte span slices the recorded text', () => {
    assert.doesNotThrow(() => checkFixtureAgainstExpected('preview-macro', gapBytes, gapExpected, gapResult));
  });

  it('rejects an UNDOCUMENTED gap: a live parse that errors where the envelope is clean', () => {
    assert.throws(() => checkFixtureAgainstExpected('drift', gapBytes, cleanExpected, gapResult), /clean=false, expected true/);
  });

  it('rejects a STALE gap: a knownGap flag that no longer matches the parse', () => {
    const stale: ExpectedCase = { ...cleanExpected, knownGap: true };
    assert.throws(() => checkFixtureAgainstExpected('stale', Buffer.from('func f(){}'), stale, cleanResult), /stale or dishonest gap flag/);
  });

  it('rejects a byte span whose bytes do not slice the recorded byteSlice text', () => {
    // Diagnostic fields match the envelope, but the recorded byteSlice claims
    // different text than [byteStart,byteEnd) slices out of the real bytes.
    const lyingSlice: ExpectedCase = {
      ...gapExpected,
      diagnostics: [{ ...gapExpected.diagnostics[0]!, byteSlice: 'Preview!' }],
    };
    assert.throws(() => checkFixtureAgainstExpected('bad-span', gapBytes, lyingSlice, gapResult), /byte span .* slices/);
  });

  it('rejects a diagnostic-count mismatch', () => {
    const extra: SwiftParseResult = { ...gapResult, diagnostics: [...gapResult.diagnostics, ...gapResult.diagnostics] };
    assert.throws(() => checkFixtureAgainstExpected('count', gapBytes, gapExpected, extra), /2 diagnostics, expected 1/);
  });

  it('rejects a root-type mismatch', () => {
    const wrongRoot: SwiftParseResult = { ...cleanResult, rootType: 'ERROR' };
    assert.throws(() => checkFixtureAgainstExpected('root', Buffer.from('x'), cleanExpected, wrongRoot), /root ERROR/);
  });
});
