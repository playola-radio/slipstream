/**
 * `qa:check fold-release` (and `npm run check:fold-release`): the two release
 * gates for the `display-fold.v1` contract (STAGE-T-PREREQS Part 2.4).
 *
 *  - Gate 3 (fingerprint): recompute the fold's import closure, implementation
 *    fingerprint, and corpus hashes and compare them to the released manifest.
 *    Runs on any `--root`; needs no git.
 *  - Gate 4 (immutability): no file that already exists under `contracts/` in the
 *    base tree may be modified, deleted, or type-changed in the working tree.
 *    Additions (a new manifest, a whole new version directory) are allowed. Needs
 *    git; compares the base commit against the working tree.
 *
 * Prints exactly one JSON result to stdout. Exit 0 = both gates pass; 1 = a gate
 * failed; 2 = bad args, or the base ref could not be resolved in a git work tree
 * (a missing base never silently passes).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkFingerprintGate } from '../src/fold-release.ts';

export const FOLD_RELEASE_EXIT = { PASS: 0, FAIL: 1, USAGE: 2 } as const;

/** The integration branch releases are frozen against when no `--base` is given. */
export const DEFAULT_BASE = 'origin/briankeane/vienna';
const PROTECTED_PREFIX = 'contracts/display-fold/';

export interface FoldReleaseArgs { root: string; base: string }
export class FoldReleaseArgError extends Error {}

export function parseFoldReleaseArgs(argv: readonly string[], cwd: string): FoldReleaseArgs {
  let root = cwd;
  let base = DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--root') {
      const v = argv[++i];
      if (v === undefined) throw new FoldReleaseArgError('--root requires a directory');
      root = resolve(cwd, v);
    } else if (arg === '--base') {
      const v = argv[++i];
      if (v === undefined) throw new FoldReleaseArgError('--base requires a ref');
      base = v;
    } else {
      throw new FoldReleaseArgError(`unknown argument: ${arg}`);
    }
  }
  return { root, base };
}

type Immutability =
  | { checked: false; reason: string }
  | { checked: true; base: string; violations: string[] };

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function inGitWorkTree(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** Resolve a ref to a commit SHA, or null if it does not name a commit. */
function resolveBase(root: string, base: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * Compare the base commit against the working tree under `contracts/`. Any
 * base-existing file that is Modified / Deleted / Type-changed (a symlink swap)
 * / Copied is a violation; Additions are allowed.
 */
export function checkImmutability(root: string, base: string): Immutability {
  if (!inGitWorkTree(root)) return { checked: false, reason: 'root is not inside a git work tree' };
  const baseSha = resolveBase(root, base);
  if (baseSha === null) return { checked: true, base, violations: [`__unresolved__:${base}`] };

  const raw = execFileSync(
    'git',
    ['-C', root, 'diff', '--no-renames', '-z', '--raw', baseSha, '--', PROTECTED_PREFIX],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const violations: string[] = [];
  // -z --raw records: ":<m1> <m2> <sha1> <sha2> <status>\0<path>\0" (rename/copy add
  // a second path field; --no-renames keeps every record single-path here).
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta || !meta.startsWith(':')) continue;
    const status = meta.slice(meta.lastIndexOf(' ') + 1);
    const path = parts[i + 1]!;
    if (status.startsWith('A')) continue; // additions are allowed
    if (status.startsWith('M')) violations.push(`${path}: modified since release`);
    else if (status.startsWith('D')) violations.push(`${path}: deleted since release`);
    else if (status.startsWith('T')) violations.push(`${path}: type changed since release`);
    else if (status.startsWith('C')) violations.push(`${path}: copied over since release`);
    else violations.push(`${path}: changed since release (${status})`);
  }
  return { checked: true, base: baseSha, violations };
}

export interface RunFoldReleaseIO {
  argv: readonly string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: string;
}

export function runFoldRelease(io: RunFoldReleaseIO): number {
  let args: FoldReleaseArgs;
  try {
    args = parseFoldReleaseArgs(io.argv, io.cwd);
  } catch (err) {
    io.stderr(`fold-release: ${(err as Error).message}`);
    io.stderr('fold-release: usage: fold-release [--root <dir>] [--base <ref>]');
    return FOLD_RELEASE_EXIT.USAGE;
  }

  const fingerprint = checkFingerprintGate(args.root);
  const immutability = checkImmutability(args.root, args.base);

  const unresolvedBase =
    immutability.checked && immutability.violations.length === 1 && immutability.violations[0]!.startsWith('__unresolved__:');
  const immutabilityFailed = immutability.checked && immutability.violations.length > 0 && !unresolvedBase;

  const result = {
    contract: 'display-fold.v1',
    fingerprint: { passed: fingerprint.length === 0, failures: fingerprint },
    immutability: unresolvedBase
      ? { checked: false, reason: `base ref '${args.base}' does not resolve to a commit` }
      : immutability,
  };
  io.stdout(JSON.stringify(result));

  if (unresolvedBase) {
    io.stderr(`fold-release: base ref '${args.base}' does not resolve to a commit; refusing to pass without a baseline`);
    return FOLD_RELEASE_EXIT.USAGE;
  }
  if (fingerprint.length > 0 || immutabilityFailed) return FOLD_RELEASE_EXIT.FAIL;
  return FOLD_RELEASE_EXIT.PASS;
}
