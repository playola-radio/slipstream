import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  verifyArtifactHash,
  checkAbi,
  loadSwiftLanguage,
  SwiftArtifactError,
  swiftWasmPath,
  EXPECTED_SHA256,
  EXPECTED_ABI,
} from './swift-grammar.ts';

// These exercise the loader's guards WITHOUT loading the grammar, so they run in
// an ordinary Node process (loading Swift needs --liftoff-only; see
// tools/swift-parse.test.ts for the end-to-end load/parse coverage).

const SWIFT_WASM_PATH = swiftWasmPath();

test('loadSwiftLanguage refuses to run outside a --liftoff-only process', async () => {
  // This test process is a plain Node launch, so the isolation guard must throw
  // BEFORE any grammar bytes are read — otherwise the OOM could abort the run.
  await assert.rejects(loadSwiftLanguage(), (err: unknown) => {
    assert.ok(err instanceof SwiftArtifactError);
    assert.match(err.message, /--liftoff-only/);
    return true;
  });
});

test('verifyArtifactHash accepts the matching hash', () => {
  verifyArtifactHash(EXPECTED_SHA256, EXPECTED_SHA256, SWIFT_WASM_PATH);
});

test('verifyArtifactHash rejects a mismatch with full context', () => {
  try {
    verifyArtifactHash('deadbeef', EXPECTED_SHA256, SWIFT_WASM_PATH);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof SwiftArtifactError);
    assert.equal(err.detail.expectedSha256, EXPECTED_SHA256);
    assert.equal(err.detail.actualSha256, 'deadbeef');
    assert.equal(err.detail.path, SWIFT_WASM_PATH);
  }
});

test('the pinned WASM on disk still hashes to EXPECTED_SHA256', () => {
  const actual = createHash('sha256').update(readFileSync(SWIFT_WASM_PATH)).digest('hex');
  assert.equal(actual, EXPECTED_SHA256, 'artifact drifted from its pin; update the pin deliberately, never silently');
});

test('checkAbi accepts the pinned ABI inside the supported range', () => {
  checkAbi(EXPECTED_ABI, EXPECTED_ABI, { min: 13, max: 15 }, {});
});

test('checkAbi rejects an ABI below the supported range', () => {
  assert.throws(
    () => checkAbi(12, EXPECTED_ABI, { min: 13, max: 15 }, {}),
    (err: unknown) => err instanceof SwiftArtifactError && /compatibility range/i.test(err.message),
  );
});

test('checkAbi rejects an ABI above the supported range', () => {
  assert.throws(
    () => checkAbi(16, EXPECTED_ABI, { min: 13, max: 15 }, {}),
    (err: unknown) => err instanceof SwiftArtifactError && /compatibility range/i.test(err.message),
  );
});

test('checkAbi rejects an in-range ABI that is not the pinned version', () => {
  assert.throws(
    () => checkAbi(14, EXPECTED_ABI, { min: 13, max: 15 }, {}),
    (err: unknown) => err instanceof SwiftArtifactError && /not the pinned/i.test(err.message),
  );
});
