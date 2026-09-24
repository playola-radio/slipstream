/**
 * T5a.3 acceptance: Swift-WASM feasibility (SWIFT-GRAMMAR.md).
 *
 * Proves the four feasibility claims of the PR against the LIVE artifact by
 * driving the isolated `--liftoff-only` host (tools/swift-parse-host.ts):
 *
 *  1. the pinned grammar loads with the exact sha256/ABI and its two licenses;
 *  2. parse diagnostics carry UTF-8 byte half-open spans, not UTF-16 indices;
 *  3. every corpus fixture parses to its recorded envelope — with the known
 *     grammar gaps disclosed honestly, never hidden by dropping a fixture;
 *  4. an in-progress parse can be cancelled and the runtime recovers, and the
 *     observed V8 out-of-memory is survived under --liftoff-only (a default
 *     launch aborts on the same parse — the negative control).
 *
 * This module never touches the daemon or reader: the feasibility question is
 * about the grammar runtime, not captured events. It is darwin-gated because the
 * OOM window and cancellation were measured on darwin arm64 only; a mismatch is
 * a not-run, never a pass.
 */
import { readFile } from 'node:fs/promises';
import { EXPECTED_SHA256, EXPECTED_ABI, GRAMMAR, WRAPPER, type SwiftDiagnostic, type SwiftParseResult } from '../../../src/swift-grammar.ts';
import { runSwiftParseChild, listSwiftFixtures, swiftFixturePath, SwiftChildError } from '../../swift-parse.ts';
import type { HostResult } from '../../swift-parse-host.ts';
import type { Assertion } from '../../qa-support.ts';
import type { AcceptanceModule } from './types.ts';

type ParseResult = Extract<HostResult, { op: 'parse' }>;
type SurviveResult = Extract<HostResult, { op: 'survive' }>;
type CancelResult = Extract<HostResult, { op: 'cancel-demo' }>;

/** The on-disk expected envelope for a corpus case: a parse result plus a
 * `byteSlice` per diagnostic and the honest known-gap manifest fields. */
export interface ExpectedCase {
  description: string;
  category: 'd2-construct' | 'malformed' | 'unicode';
  rootType: string;
  clean: boolean;
  knownGap: boolean;
  diagnostics: (SwiftDiagnostic & { byteSlice: string })[];
}

function fail(msg: string): never {
  throw new Error(msg);
}

const DIAG_KEYS: (keyof SwiftDiagnostic)[] = [
  'kind', 'nodeType', 'byteStart', 'byteEnd', 'startRow', 'startColumn', 'endRow', 'endColumn',
];

/** True when byte offset `i` falls on a UTF-8 codepoint boundary: either the end
 * of the buffer, or a byte that is not a continuation byte (`10xxxxxx`). Checked
 * per-endpoint so a zero-width span (a MISSING node) whose offset lands inside a
 * multi-byte character is caught — an empty slice always decodes cleanly, so the
 * decode below cannot see that on its own. */
function isCodepointBoundary(bytes: Buffer, i: number): boolean {
  if (i === bytes.length) return true;
  return (bytes[i]! & 0xc0) !== 0x80;
}

/** Slice [start,end) out of the source bytes as UTF-8, FATAL on a span that does
 * not fall on codepoint boundaries. `Buffer.toString('utf8')` would silently
 * substitute U+FFFD, so a span that splits a multi-byte character (e.g. inside
 * an emoji) could match a recorded replacement character and certify a byte-span
 * contract violation. Both endpoints are boundary-checked (so a zero-width span
 * inside a codepoint fails too), then the slice is decoded fatally as a backstop.
 * `ignoreBOM:true` keeps a leading BOM in the output so a byte-exact slice is not
 * silently trimmed. */
function fatalUtf8Slice(name: string, i: number, bytes: Buffer, start: number, end: number): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.length) {
    fail(`${name}: diagnostic ${i} byte span [${start},${end}) is out of range for ${bytes.length} source bytes`);
  }
  if (!isCodepointBoundary(bytes, start) || !isCodepointBoundary(bytes, end)) {
    fail(`${name}: diagnostic ${i} byte span [${start},${end}) splits a UTF-8 codepoint — spans must fall on codepoint boundaries`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end));
  } catch {
    fail(`${name}: diagnostic ${i} byte span [${start},${end}) splits a UTF-8 codepoint — spans must fall on codepoint boundaries`);
  }
}

/**
 * Cross-check one fixture's live parse against its recorded envelope. Pure so the
 * honesty rules are unit-testable without spawning the grammar. Throws on any
 * drift: a fixture that newly parses with errors (an UNDOCUMENTED gap) fails the
 * `clean` check; a `knownGap` flag that no longer matches the parse (a STALE gap)
 * fails the manifest check; and every diagnostic's byte span must slice the exact
 * recorded text out of the real source bytes.
 */
export function checkFixtureAgainstExpected(
  name: string,
  bytes: Buffer,
  expected: ExpectedCase,
  result: SwiftParseResult,
): void {
  if (result.rootType !== expected.rootType) fail(`${name}: root ${result.rootType}, expected ${expected.rootType}`);
  if (result.clean !== expected.clean) fail(`${name}: clean=${result.clean}, expected ${expected.clean} (an undocumented grammar drift)`);
  // The reported byte length must equal the real source length, or every span
  // below is measured against a fiction.
  if (result.byteLength !== bytes.length) {
    fail(`${name}: byteLength=${result.byteLength}, but the source is ${bytes.length} bytes`);
  }
  if (result.diagnostics.length !== expected.diagnostics.length) {
    fail(`${name}: ${result.diagnostics.length} diagnostics, expected ${expected.diagnostics.length}`);
  }
  result.diagnostics.forEach((actual, i) => {
    const want = expected.diagnostics[i]!;
    for (const key of DIAG_KEYS) {
      if (actual[key] !== want[key]) fail(`${name}: diagnostic ${i} ${key}=${String(actual[key])}, expected ${String(want[key])}`);
    }
    const slice = fatalUtf8Slice(name, i, bytes, actual.byteStart, actual.byteEnd);
    if (slice !== want.byteSlice) fail(`${name}: diagnostic ${i} byte span [${actual.byteStart},${actual.byteEnd}) slices ${JSON.stringify(slice)}, expected ${JSON.stringify(want.byteSlice)}`);
  });
  // Honest known-gap manifest: a non-malformed fixture that does not parse clean
  // is a disclosed grammar gap, and nothing else may claim to be one.
  const shouldBeGap = expected.category !== 'malformed' && !expected.clean;
  if (expected.knownGap !== shouldBeGap) {
    fail(`${name}: knownGap=${expected.knownGap} but category=${expected.category}/clean=${expected.clean} implies ${shouldBeGap} (stale or dishonest gap flag)`);
  }
}

async function artifactClaim(): Promise<Assertion> {
  const r = await runSwiftParseChild<ParseResult>({ op: 'parse', source: 'func greet(name: String) -> String { return name }\n' });
  const p = r.provenance;
  if (p.sha256 !== EXPECTED_SHA256) fail(`artifact sha256 ${p.sha256} != pinned ${EXPECTED_SHA256}`);
  if (p.abiVersion !== EXPECTED_ABI) fail(`artifact ABI ${p.abiVersion} != pinned ${EXPECTED_ABI}`);
  if (p.grammar.license !== GRAMMAR.license) fail(`grammar license ${p.grammar.license} != ${GRAMMAR.license}`);
  if (p.wrapper.license !== WRAPPER.license) fail(`wrapper license ${p.wrapper.license} != ${WRAPPER.license}`);
  if (!r.result.clean || r.result.rootType !== 'source_file') fail(`a plain function did not parse clean: ${JSON.stringify(r.result)}`);
  return {
    id: 'swift-artifact-load',
    claim: 'the pinned tree-sitter-swift.wasm loads under web-tree-sitter with the exact sha256 and ABI, its grammar (MIT) and wrapper (Unlicense) licenses distinct, and parses a plain function clean',
    evidence: {
      sha256: p.sha256, abiVersion: p.abiVersion, supportedAbi: p.supportedAbi,
      grammar: p.grammar, wrapper: p.wrapper, webTreeSitter: p.webTreeSitter,
      initAndLoadMs: r.timings.initAndLoadMs, firstParseMs: r.timings.firstParseMs,
    },
  };
}

async function byteSpanClaim(): Promise<Assertion> {
  // The astral emoji is 2 UTF-16 units but 4 UTF-8 bytes, so the malformed
  // 'func f( {' that follows must be reported starting at byte 15, not index 13.
  const source = 'let e = "\u{1F600}"\nfunc f( {\n';
  const bytes = Buffer.from(source, 'utf8');
  const r = await runSwiftParseChild<ParseResult>({ op: 'parse', source });
  const err = r.result.diagnostics.find((d) => d.kind === 'error') ?? fail('expected an ERROR diagnostic for the malformed tail');
  if (err.byteStart !== 15) fail(`ERROR byteStart=${err.byteStart}, expected 15 (UTF-8 bytes, not the UTF-16 index 13)`);
  const slice = bytes.subarray(err.byteStart, err.byteEnd).toString('utf8');
  if (slice !== 'func f( {') fail(`ERROR byte span slices ${JSON.stringify(slice)}, expected "func f( {"`);
  return {
    id: 'swift-byte-spans',
    claim: 'after an astral emoji (2 UTF-16 units / 4 UTF-8 bytes), a diagnostic\'s byte span starts at byte 15 and slices the exact malformed text — spans are UTF-8 bytes, not UTF-16 indices',
    evidence: { byteStart: err.byteStart, byteEnd: err.byteEnd, slice },
  };
}

async function corpusClaim(): Promise<Assertion> {
  const names = await listSwiftFixtures();
  if (names.length === 0) fail('the Swift corpus is empty');
  const gaps: string[] = [];
  for (const name of names) {
    const bytes = await readFile(swiftFixturePath(name, 'input.swift'));
    const expected = JSON.parse(await readFile(swiftFixturePath(name, 'expected.json'), 'utf8')) as ExpectedCase;
    const r = await runSwiftParseChild<ParseResult>({ op: 'parse', source: bytes.toString('utf8') });
    checkFixtureAgainstExpected(name, bytes, expected, r.result);
    if (expected.knownGap) gaps.push(name);
  }
  return {
    id: 'swift-corpus',
    claim: 'every recorded corpus fixture, re-parsed through the live grammar, matches its envelope with byte spans that slice the exact source text, and each declaration/Unicode fixture that does not parse clean is disclosed as a known grammar gap (never hidden by dropping the fixture)',
    evidence: { fixtures: names.length, knownGaps: gaps },
  };
}

async function cancellationClaim(): Promise<Assertion> {
  const pathological = 'func f() {\n' + '  if x {\n'.repeat(200_000);
  const r = await runSwiftParseChild<CancelResult>(
    { op: 'cancel-demo', pathologicalSource: pathological, cleanSource: 'struct S { func m() {} }\n' },
    { deadlineMs: 60_000 },
  );
  if (!r.startedBeforeCancel) fail('the pathological parse never started, so cancellation proves nothing');
  // The host confirmed the parse was still running when it terminated — not that
  // it had already completed. Without this the cancellation demo proves nothing.
  if (!r.inProgressAtCancel) fail('the pathological parse had already finished before termination — cancellation was not demonstrated mid-flight');
  if (!(r.terminateMs >= 0)) fail(`missing termination timing: ${JSON.stringify(r)}`);
  if (!r.replacement.clean || r.replacement.rootType !== 'source_file') fail(`the replacement parse did not recover: ${JSON.stringify(r.replacement)}`);
  return {
    id: 'swift-cancellation',
    claim: 'a parse still in flight (confirmed unfinished at termination) is cancelled by hard-terminating its worker, and a fresh worker parses clean input to completion afterward',
    evidence: { startedBeforeCancel: r.startedBeforeCancel, inProgressAtCancel: r.inProgressAtCancel, terminateMs: r.terminateMs, replacement: r.replacement },
  };
}

async function oomSurvivalClaim(): Promise<Assertion> {
  const holdMs = 2_800;
  const survived = await runSwiftParseChild<SurviveResult>(
    { op: 'survive', source: 'func f() {}\n', holdMs },
    { deadlineMs: 15_000 },
  );
  if (survived.heldMs !== holdMs || !survived.result.clean) fail(`--liftoff-only host did not survive the OOM window: ${JSON.stringify(survived)}`);
  // Negative control: the same parse on a default launch aborts the process. It
  // must abort via a V8 fatal-error SIGNAL — NOT our own deadline SIGKILL, NOT a
  // clean exit-2 load failure (signal null). Accepting either of those would let
  // an unrelated failure masquerade as the OOM and pass this gate.
  const V8_FATAL_SIGNALS = new Set<NodeJS.Signals>(['SIGTRAP', 'SIGABRT', 'SIGILL', 'SIGSEGV', 'SIGBUS']);
  let controlDetail: SwiftChildError['detail'] | null = null;
  try {
    await runSwiftParseChild<SurviveResult>({ op: 'survive', source: 'func f() {}\n', holdMs }, { deadlineMs: 15_000, liftoffOnly: false });
  } catch (err) {
    if (!(err instanceof SwiftChildError)) throw err;
    controlDetail = err.detail;
  }
  if (!controlDetail) fail('the default-launch negative control did NOT abort — the --liftoff-only survival is not load-bearing');
  if (controlDetail.signal === null || !V8_FATAL_SIGNALS.has(controlDetail.signal)) {
    fail(`the negative control did not abort with a V8 fatal signal (got code=${controlDetail.code}, signal=${controlDetail.signal}); a deadline SIGKILL or clean exit-2 is not proof of the OOM`);
  }
  return {
    id: 'swift-oom-survival',
    claim: 'under --liftoff-only the host parses and stays alive past the observed V8 out-of-memory window, while the same parse on a default Node launch aborts the process with a V8 fatal signal (the negative control)',
    evidence: { heldMs: survived.heldMs, control: { code: controlDetail.code, signal: controlDetail.signal } },
  };
}

export const t5a3: AcceptanceModule = {
  id: 'T5a.3',
  requiresPlatform: 'darwin',
  async run() {
    return {
      assertions: [
        await artifactClaim(),
        await byteSpanClaim(),
        await corpusClaim(),
        await cancellationClaim(),
        await oomSurvivalClaim(),
      ],
    };
  },
};
