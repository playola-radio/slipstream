/**
 * Release discipline for the `display-fold.v1` contract (STAGE-T-PREREQS Part 2.4,
 * D8). A released manifest pins three things about the display fold so a later edit
 * cannot silently change what a `Slipstream-Fold-Contract` header promises:
 *
 *  1. the exact static import closure of `src/display-fold.ts` (the display
 *     dependency list),
 *  2. an implementation fingerprint over the raw bytes of that closure, and
 *  3. the fixture corpus (case names + content hashes) the contract is judged by.
 *
 * The change gate below recomputes all three from the working tree and fails if
 * they differ from the released manifest — the signal to release `display-fold.v2`
 * rather than edit v1 in place. Import discovery uses the TypeScript parser (AST),
 * never a regex, and fails closed: any import in the closure that is not an
 * explicit relative `.ts` path — a bare/`node:` specifier, a dynamic `import()`, a
 * `require`, a triple-slash directive, or an unresolved path — is a violation,
 * because the fingerprint cannot account for bytes it cannot see.
 *
 * This module is test/tooling-only (it pulls in `typescript`, a devDependency);
 * the daemon never imports it.
 */
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** The single fold entry point whose import closure defines the display deps. */
export const FOLD_ENTRY = 'src/display-fold.ts';

/** Must never appear in the closure: attribution SCORING is deliberately outside
 * the display contract (D9), so its churn must not perturb the fingerprint. */
export const FORBIDDEN_IN_CLOSURE = 'src/attribution-scoring.ts';

/** Repo root (this file lives in `src/`). */
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const CONTRACT_ID = 'display-fold.v1';
const CONTRACT_DIR = 'contracts/display-fold/v1';
const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CORPUS_FILES = ['input.ndjson', 'expected.json'] as const;

interface CorpusEntry {
  case: string;
  input_sha256: string;
  expected_sha256: string;
}
interface FoldManifest {
  contract: string;
  canonical_output: string;
  supported_event_versions: string[];
  display_dependencies: string[];
  implementation_fingerprint: string;
  corpus: CorpusEntry[];
}

/** A recoverable problem discovered while reading the working tree or manifest.
 * The checker turns these into a one-line-per-failure gate result, never a crash. */
export class FoldReleaseError extends Error {}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}
function repoRel(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The static import closure of `entry`, as sorted repo-relative POSIX `.ts`
 * paths (including the entry itself). Fails closed on anything the fingerprint
 * cannot cover.
 */
export function discoverImportClosure(root: string): string[] {
  const found = new Set<string>();
  const queue: string[] = [FOLD_ENTRY];
  while (queue.length) {
    const rel = queue.shift()!;
    if (found.has(rel)) continue;
    found.add(rel);
    const abs = join(root, rel);
    // A symlink would let the fingerprint hash bytes from outside the tree the
    // gate believes it is judging; refuse it rather than follow it.
    if (isSymlink(abs)) throw new FoldReleaseError(`${rel}: is a symlink; a fold-closure file must be a regular file`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(abs));
    } catch {
      throw new FoldReleaseError(`${rel}: unreadable or not valid UTF-8`);
    }
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
    const diags = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    if (diags && diags.length) throw new FoldReleaseError(`${rel}: has syntax errors; cannot resolve its imports`);
    if (sf.referencedFiles.length || sf.typeReferenceDirectives.length || sf.libReferenceDirectives.length) {
      throw new FoldReleaseError(`${rel}: triple-slash reference directives are not allowed in a fold-closure file`);
    }
    for (const spec of collectSpecifiers(sf, rel)) {
      queue.push(resolveSpecifier(root, rel, spec));
    }
  }
  return [...found].sort();
}

/** Pull every module specifier out of a source file, rejecting runtime import
 * forms the fingerprint cannot reason about. */
function collectSpecifiers(sf: ts.SourceFile, rel: string): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const ms = node.moduleSpecifier;
      // A bare `export { x }` has no moduleSpecifier — nothing to follow.
      if (ms && ts.isStringLiteral(ms)) specs.push(ms.text);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) specs.push(arg.literal.text);
      else throw new FoldReleaseError(`${rel}: non-literal import type is not allowed in a fold-closure file`);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new FoldReleaseError(`${rel}: dynamic import() is not allowed in a fold-closure file`);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      throw new FoldReleaseError(`${rel}: require(...) is not allowed in a fold-closure file`);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      throw new FoldReleaseError(`${rel}: import-equals-require is not allowed in a fold-closure file`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return specs;
}

/** Resolve a specifier to a repo-relative `.ts` path, or fail closed. */
function resolveSpecifier(root: string, fromRel: string, spec: string): string {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new FoldReleaseError(`${fromRel}: import '${spec}' is not a relative path; the fold closure must be self-contained local .ts files`);
  }
  if (!spec.endsWith('.ts')) {
    throw new FoldReleaseError(`${fromRel}: import '${spec}' must name an explicit .ts file`);
  }
  const abs = resolve(join(root, dirname(fromRel)), spec);
  let isFile = false;
  try {
    isFile = statSync(abs).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new FoldReleaseError(`${fromRel}: import '${spec}' does not resolve to a file`);
  const rel = repoRel(root, abs);
  if (rel.startsWith('../')) throw new FoldReleaseError(`${fromRel}: import '${spec}' escapes the repository`);
  return rel;
}

/** Hash-of-hashes over the closure's raw bytes: for each dep (sorted), the line
 * `<sha256hex>  <relpath>\n`, concatenated and hashed. */
export function computeFingerprint(root: string, deps: readonly string[]): string {
  const lines = deps.map((rel) => {
    const h = sha256Hex(readFileSync(join(root, rel)));
    return `${h}  ${rel}\n`;
  });
  return `sha256:${sha256Hex(new TextEncoder().encode(lines.join('')))}`;
}

/** Every corpus case discovered on disk, as sorted content-hash entries. Fails
 * closed if a case dir is missing a required file or carries an extra one. */
function computeCorpus(root: string): CorpusEntry[] {
  const base = join(root, CONTRACT_DIR);
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    throw new FoldReleaseError(`${CONTRACT_DIR}: corpus directory is unreadable`);
  }
  const entries: CorpusEntry[] = [];
  for (const name of names.sort()) {
    if (!CASE_NAME.test(name)) throw new FoldReleaseError(`${CONTRACT_DIR}/${name}: invalid corpus case name`);
    const dir = join(base, name);
    const files = readdirSync(dir, { withFileTypes: true });
    const extra = files.filter((e) => !e.isDirectory() && !CORPUS_FILES.includes(e.name as (typeof CORPUS_FILES)[number]));
    if (extra.length) throw new FoldReleaseError(`${CONTRACT_DIR}/${name}: unexpected file '${extra[0]!.name}'`);
    const read = (f: (typeof CORPUS_FILES)[number]): string => {
      try {
        return sha256Hex(readFileSync(join(dir, f)));
      } catch {
        throw new FoldReleaseError(`${CONTRACT_DIR}/${name}: missing ${f}`);
      }
    };
    entries.push({ case: name, input_sha256: read('input.ndjson'), expected_sha256: read('expected.json') });
  }
  if (!entries.length) throw new FoldReleaseError(`${CONTRACT_DIR}: corpus is empty`);
  return entries;
}

export function loadManifest(root: string): FoldManifest {
  const path = join(root, CONTRACT_DIR, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: not found`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: not valid JSON`);
  }
  const m = parsed as FoldManifest;
  if (!m || m.contract !== CONTRACT_ID || !Array.isArray(m.display_dependencies) || !Array.isArray(m.corpus)) {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: not a display-fold.v1 manifest`);
  }
  if (typeof m.implementation_fingerprint !== 'string') {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: implementation_fingerprint must be a string`);
  }
  if (!m.display_dependencies.every((d) => typeof d === 'string')) {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: display_dependencies must be a list of strings`);
  }
  if (!m.corpus.every(isCorpusEntry)) {
    throw new FoldReleaseError(`${CONTRACT_DIR}/manifest.json: every corpus entry needs string case/input_sha256/expected_sha256`);
  }
  return m;
}

function isCorpusEntry(v: unknown): v is CorpusEntry {
  const e = v as CorpusEntry | null;
  return (
    !!e && typeof e === 'object' &&
    typeof e.case === 'string' && typeof e.input_sha256 === 'string' && typeof e.expected_sha256 === 'string'
  );
}

/**
 * Gate 3: recompute deps / fingerprint / corpus and compare to the released
 * manifest. Returns a list of one-line failures (empty = pass). Never throws for
 * a content mismatch; only structural I/O problems surface as failures too.
 */
export function checkFingerprintGate(root: string): string[] {
  const failures: string[] = [];
  let manifest: FoldManifest;
  let actual: { display_dependencies: string[]; implementation_fingerprint: string; corpus: CorpusEntry[] };
  try {
    manifest = loadManifest(root);
    const deps = discoverImportClosure(root);
    actual = { display_dependencies: deps, implementation_fingerprint: computeFingerprint(root, deps), corpus: computeCorpus(root) };
  } catch (err) {
    return [(err as Error).message];
  }

  if (actual.display_dependencies.includes(FORBIDDEN_IN_CLOSURE)) {
    failures.push(`${FORBIDDEN_IN_CLOSURE} is in the display-fold import closure; attribution scoring must stay outside the display contract (D9)`);
  }

  const declaredDeps = [...manifest.display_dependencies].sort();
  const actualDeps = actual.display_dependencies;
  const missingFromManifest = actualDeps.filter((d) => !declaredDeps.includes(d));
  const staleInManifest = declaredDeps.filter((d) => !actualDeps.includes(d));
  for (const d of missingFromManifest) {
    failures.push(`display dependency '${d}' is imported by the fold but not listed in the manifest`);
  }
  for (const d of staleInManifest) {
    failures.push(`manifest lists display dependency '${d}' that the fold no longer imports`);
  }

  if (actual.implementation_fingerprint !== manifest.implementation_fingerprint) {
    failures.push(
      `implementation fingerprint changed: manifest ${manifest.implementation_fingerprint}, actual ${actual.implementation_fingerprint}`,
    );
  }

  failures.push(...diffCorpus(manifest.corpus, actual.corpus));

  return failures;
}

function diffCorpus(declared: readonly CorpusEntry[], actual: readonly CorpusEntry[]): string[] {
  const failures: string[] = [];
  const byName = new Map(declared.map((e) => [e.case, e]));
  const actualNames = new Set(actual.map((e) => e.case));
  for (const e of actual) {
    const d = byName.get(e.case);
    if (!d) {
      failures.push(`corpus case '${e.case}' exists on disk but is not in the released manifest`);
      continue;
    }
    if (d.input_sha256 !== e.input_sha256) failures.push(`corpus case '${e.case}': input.ndjson changed since release`);
    if (d.expected_sha256 !== e.expected_sha256) failures.push(`corpus case '${e.case}': expected.json changed since release`);
  }
  for (const d of declared) {
    if (!actualNames.has(d.case)) failures.push(`corpus case '${d.case}' is in the released manifest but missing on disk`);
  }
  return failures;
}
