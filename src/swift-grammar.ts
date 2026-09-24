/**
 * Loads the pinned Swift Tree-sitter grammar through the existing web-tree-sitter
 * runtime and reports parse diagnostics with UTF-8 byte spans. This is the
 * T5a.3 feasibility loader (STAGE-T-PREREQS 3.3): it proves the bundled artifact
 * loads and parses; it does NOT extract declarations or make any comparison
 * claim (that is T5a.4).
 *
 * IMPORTANT: loading + parsing this grammar deterministically aborts a default
 * Node process a second or two later, inside V8's optimizing WASM compiler
 * (turboshaft) with `Fatal process out of memory: Zone`. The only mitigation
 * found is launching the host process with `node --liftoff-only` (single-tier
 * baseline WASM); workers inherit it. So `loadSwiftLanguage`/`parseSwiftSource`
 * must only ever execute inside such a process (see tools/swift-parse-host.ts).
 * Merely importing this module is safe — nothing here initializes eagerly.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Parser, Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, type Node } from 'web-tree-sitter';
import { buildUtf16ToByteTable, utf16RangeToByteRange } from './swift-spans.ts';

const require = createRequire(import.meta.url);

/** The bundled artifact, resolved from the pinned `tree-sitter-wasms` package. */
export const SWIFT_WASM_PATH = require.resolve('tree-sitter-wasms/out/tree-sitter-swift.wasm');

/** sha256 of the pinned WASM — the artifact's exact identity. The npm range the
 * wrapper declares (`^0.4.0`) is not an exact grammar revision, so this hash,
 * not a version string, is the real pin. */
export const EXPECTED_SHA256 = '41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7';

/** ABI version the pinned artifact must report. */
export const EXPECTED_ABI = 13;

/** Static provenance. The grammar and its wrapper carry DIFFERENT licenses and
 * must not be conflated. The exact grammar revision that produced this WASM is
 * not recoverable from the distributed artifact (the wrapper ships only `/out`,
 * no lockfile), so it is honestly recorded as "unknown". */
export const GRAMMAR = {
  package: 'tree-sitter-swift',
  repo: 'https://github.com/alex-pinkus/tree-sitter-swift',
  versionRange: '^0.4.0',
  revision: 'unknown',
  license: 'MIT',
} as const;

export const WRAPPER = {
  package: 'tree-sitter-wasms',
  license: 'Unlicense',
} as const;

/** A load/verification failure with the full context needed to diagnose it.
 * Never caught-and-ignored: the loader never silently falls back. */
export class SwiftArtifactError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SwiftArtifactError';
    this.detail = detail;
  }
}

/** Fail loudly if the bytes on disk are not the pinned artifact. Pure so the
 * mismatch path is unit-testable without touching the WASM runtime. */
export function verifyArtifactHash(actualSha: string, expectedSha: string, path: string): void {
  if (actualSha !== expectedSha) {
    throw new SwiftArtifactError('Swift WASM sha256 mismatch', {
      path,
      expectedSha256: expectedSha,
      actualSha256: actualSha,
    });
  }
}

/** Fail loudly on an ABI outside the runtime's supported range, or not exactly
 * the pinned ABI. Pure so both failure paths are unit-testable. */
export function checkAbi(
  actual: number,
  expected: number,
  supported: { min: number; max: number },
  ctx: Record<string, unknown>,
): void {
  if (actual < supported.min || actual > supported.max) {
    throw new SwiftArtifactError('Swift grammar ABI outside runtime compatibility range', {
      ...ctx,
      actualAbi: actual,
      supportedAbi: supported,
    });
  }
  if (actual !== expected) {
    throw new SwiftArtifactError('Swift grammar ABI is not the pinned version', {
      ...ctx,
      actualAbi: actual,
      expectedAbi: expected,
      supportedAbi: supported,
    });
  }
}

function installedVersion(pkg: string): string {
  try {
    const json = JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')) as { version?: string };
    return json.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Everything the checker prints about the artifact and runtime it loaded. */
export interface ArtifactProvenance {
  path: string;
  sha256: string;
  abiVersion: number;
  supportedAbi: { min: number; max: number };
  grammar: typeof GRAMMAR;
  wrapper: { package: string; version: string; license: string };
  webTreeSitter: { package: 'web-tree-sitter'; version: string };
}

export interface LoadedSwift {
  language: Language;
  provenance: ArtifactProvenance;
}

let initPromise: Promise<void> | undefined;
/** Cache the one web-tree-sitter runtime init, matching the clip parser's
 * pattern. Swift runs isolated in its own process, so there is no in-process
 * clip parser to double-init with. */
function ensureInit(): Promise<void> {
  initPromise ??= Parser.init().catch((error: unknown) => {
    initPromise = undefined;
    throw error;
  });
  return initPromise;
}

/** Read → hash → verify → load the SAME bytes → verify ABI. Hashing the bytes
 * that are actually loaded (rather than hashing a path and re-reading it) closes
 * the verification gap Codex flagged. */
export async function loadSwiftLanguage(): Promise<LoadedSwift> {
  const bytes = readFileSync(SWIFT_WASM_PATH);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  verifyArtifactHash(sha256, EXPECTED_SHA256, SWIFT_WASM_PATH);

  await ensureInit();
  const supported = { min: MIN_COMPATIBLE_VERSION, max: LANGUAGE_VERSION };

  let language: Language;
  try {
    language = await Language.load(bytes);
  } catch (error) {
    throw new SwiftArtifactError('Language.load failed for the Swift WASM', {
      path: SWIFT_WASM_PATH,
      sha256,
      supportedAbi: supported,
    }, { cause: error });
  }

  const abiVersion = language.abiVersion;
  // The compatibility-range check lives in setLanguage(); run it explicitly so
  // an incompatible grammar fails here with full context, never at first parse.
  const probe = new Parser();
  try {
    probe.setLanguage(language);
  } catch (error) {
    probe.delete();
    throw new SwiftArtifactError('Parser.setLanguage rejected the Swift grammar ABI', {
      path: SWIFT_WASM_PATH,
      sha256,
      abiVersion,
      supportedAbi: supported,
    }, { cause: error });
  }
  probe.delete();

  checkAbi(abiVersion, EXPECTED_ABI, supported, { path: SWIFT_WASM_PATH, sha256 });

  return {
    language,
    provenance: {
      path: SWIFT_WASM_PATH,
      sha256,
      abiVersion,
      supportedAbi: supported,
      grammar: GRAMMAR,
      wrapper: { package: WRAPPER.package, version: installedVersion(WRAPPER.package), license: WRAPPER.license },
      webTreeSitter: { package: 'web-tree-sitter', version: installedVersion('web-tree-sitter') },
    },
  };
}

/** One ERROR or MISSING node, with a UTF-8-byte half-open span (D10) plus the
 * parser's zero-based UTF-16 row/column. */
export interface SwiftDiagnostic {
  kind: 'error' | 'missing';
  nodeType: string;
  byteStart: number;
  byteEnd: number;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface SwiftParseResult {
  rootType: string;
  clean: boolean;
  diagnostics: SwiftDiagnostic[];
  byteLength: number;
}

export class SwiftTraversalError extends Error {}

/** Cap on nodes visited during diagnostic traversal. A pathological tree that
 * blows the cap throws (never returns a truncated `clean:true`); wall-clock
 * cancellation of such input is demonstrated separately via a terminable
 * worker. */
const MAX_NODES = 500_000;

/** Parse Swift source and collect its ERROR/MISSING diagnostics with byte spans.
 * Visits EVERY node (including anonymous missing tokens), so no nested defect is
 * hidden. `clean` is true only when the whole tree is free of ERROR/MISSING. */
export function parseSwiftSource(language: Language, source: string, opts?: { deadlineMs?: number }): SwiftParseResult {
  const parser = new Parser();
  let tree = null as ReturnType<Parser['parse']>;
  try {
    parser.setLanguage(language);
    const parseOpts = opts?.deadlineMs !== undefined
      ? { progressCallback: (() => { const end = performance.now() + opts.deadlineMs!; return () => performance.now() > end; })() }
      : undefined;
    tree = parser.parse(source, null, parseOpts);
    if (!tree) throw new SwiftTraversalError('parse timed out before completion');

    const table = buildUtf16ToByteTable(source);
    const diagnostics: SwiftDiagnostic[] = [];
    const stack: Node[] = [tree.rootNode];
    let visited = 0;
    while (stack.length) {
      if (++visited > MAX_NODES) throw new SwiftTraversalError(`node budget ${MAX_NODES} exhausted`);
      const node = stack.pop()!;
      if (node.isError || node.isMissing) {
        const { byteStart, byteEnd } = utf16RangeToByteRange(table, node.startIndex, node.endIndex);
        diagnostics.push({
          kind: node.isMissing ? 'missing' : 'error',
          nodeType: node.type,
          byteStart,
          byteEnd,
          startRow: node.startPosition.row,
          startColumn: node.startPosition.column,
          endRow: node.endPosition.row,
          endColumn: node.endPosition.column,
        });
      }
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child) stack.push(child);
      }
    }
    diagnostics.sort((a, b) =>
      a.byteStart - b.byteStart || a.byteEnd - b.byteEnd || a.kind.localeCompare(b.kind) || a.nodeType.localeCompare(b.nodeType));

    const rootType = tree.rootNode.type;
    const hasError = tree.rootNode.hasError;
    // clean requires BOTH signals to agree; disagreement is a defect, not "clean".
    const clean = diagnostics.length === 0 && !hasError;
    return { rootType, clean, diagnostics, byteLength: table.bytes[table.length]! };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
