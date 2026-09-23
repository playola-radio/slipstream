/**
 * The `display-fold.v1` oracle plumbing shared by `projection-check.ts fold` and
 * the T0.1 acceptance check: strict NDJSON parsing, the fold-to-output-line step,
 * and access to the hand-written corpus under contracts/display-fold/v1/.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonicalJson, foldDisplay } from '../src/display-fold.ts';

/** Input the fold never sees: bad bytes, bad JSON, or an unusable fixture name. */
export class FoldInputError extends Error {}

const CORPUS_DIR = fileURLToPath(new URL('../contracts/display-fold/v1/', import.meta.url));
const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Parse all of an NDJSON input before any folding: whitespace-only lines are
 * skipped, CRLF and a missing final newline are accepted. Errors name the line
 * but never quote its contents (it may hold captured source). */
export function parseFoldInput(bytes: Uint8Array): unknown[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FoldInputError('input is not valid UTF-8');
  }
  const records: unknown[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new FoldInputError(`line ${i + 1} is not valid JSON`);
    }
  }
  return records;
}

/** The oracle's single output line and exit code: 0 for `ok`, 1 for any refusal. */
export function foldToLine(records: readonly unknown[]): { line: string; exit: 0 | 1 } {
  const result = foldDisplay(records);
  return { line: canonicalJson(result), exit: result.result === 'ok' ? 0 : 1 };
}

export function corpusCasePath(name: string, file: 'input.ndjson' | 'expected.json'): string {
  if (!CASE_NAME.test(name)) throw new FoldInputError(`invalid fixture name '${name}'`);
  return join(CORPUS_DIR, name, file);
}

export async function listCorpusCases(): Promise<string[]> {
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && CASE_NAME.test(e.name))
    .map((e) => e.name)
    .sort();
}
