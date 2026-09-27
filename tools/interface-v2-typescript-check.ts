/** Standalone FD1 acceptance over real parser output and disposable blob bytes. */
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStructuredExtractions, type StructuredExtraction } from '../src/interface-v2-comparison.ts';
import { createTypeScriptInterfaceExtractor } from '../src/interface-v2-typescript.ts';

const CASES = fileURLToPath(new URL('../contracts/interface/v2/cases/', import.meta.url));

type Endpoint = { kind: string; snapshot?: { kind: string; sha256?: string } };
type FixtureFile = { path: string; before: Endpoint; after: Endpoint; status: string;
  fallback_reason?: string; changes: unknown[] };

export async function runInterfaceV2TypeScriptCheck(args: readonly string[],
  stdout: (line: string) => void, stderr: (line: string) => void): Promise<number> {
  if (args.length !== 2 || args[0] !== '--lang' || args[1] !== 'typescript') {
    stderr('usage: projection-check interface-v2 --lang typescript');
    return 2;
  }
  const root = await mkdtemp(join(tmpdir(), 'slipstream-interface-v2-fd1-'));
  const blobDir = join(root, 'blobs');
  const checked: string[] = [];
  const failures: string[] = [];
  try {
    await mkdir(blobDir);
    const extractTs = await createTypeScriptInterfaceExtractor('typescript');
    const extractTsx = await createTypeScriptInterfaceExtractor('tsx');
    for (const name of (await readdir(CASES)).sort()) {
      const dir = join(CASES, name);
      let expectedText: string;
      try {
        expectedText = await readFile(join(dir, 'expected.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const expected = JSON.parse(expectedText) as { files: FixtureFile[] };
      const history = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')) as {
        blobs: Record<string, string>;
      };
      const available = (endpoint: Endpoint): boolean => endpoint.kind === 'recorded'
        && (endpoint.snapshot?.kind === 'absent'
          || endpoint.snapshot?.kind === 'content' && endpoint.snapshot.sha256 !== undefined
            && history.blobs[endpoint.snapshot.sha256] !== undefined);
      const same = (before: Endpoint, after: Endpoint): boolean =>
        before.snapshot?.kind === 'absent' && after.snapshot?.kind === 'absent'
        || before.snapshot?.kind === 'content' && after.snapshot?.kind === 'content'
          && before.snapshot.sha256 === after.snapshot.sha256;
      const files = expected.files.filter(file => /\.tsx?$/.test(file.path)
        && available(file.before) && available(file.after) && !same(file.before, file.after)
        && file.status !== 'skipped'); // FD4 admission, independent of source bytes.
      if (!files.length) continue;
      for (const [sha, text] of Object.entries(history.blobs)) {
        await writeFile(join(blobDir, sha), Buffer.from(text));
      }
      for (const file of files) {
        const id = `${name}/${file.path}`;
        const extract = file.path.endsWith('.tsx') ? extractTsx : extractTs;
        const side = async (endpoint: Endpoint): Promise<StructuredExtraction> => {
          if (endpoint.snapshot?.kind === 'absent') return { status: 'absent' };
          const sha = endpoint.snapshot?.sha256;
          if (!sha) throw new Error(`${id}: no content endpoint`);
          return extract(await readFile(join(blobDir, sha)));
        };
        try {
          const actual = compareStructuredExtractions(await side(file.before), await side(file.after));
          if (actual.status !== file.status || actual.fallback_reason !== file.fallback_reason
            || !isDeepStrictEqual(actual.changes, file.changes)) failures.push(`${id}: extraction mismatch`);
        } catch (error) {
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        checked.push(id);
      }
    }

    // The ratified corpus has no .tsx file. Keep an independently specified pair in
    // this executable acceptance so the TSX grammar is exercised by a real process.
    const before = Buffer.from('export const Card = ({ title }: Props): JSX.Element => <div>{title}</div>;');
    const after = Buffer.from('export const Card = ({ title, badge }: Props): JSX.Element => <div>{title}</div>;');
    const beforePath = join(root, 'before.tsx');
    const afterPath = join(root, 'after.tsx');
    await writeFile(beforePath, before);
    await writeFile(afterPath, after);
    const tsx = compareStructuredExtractions(extractTsx(await readFile(beforePath)),
      extractTsx(await readFile(afterPath)));
    if (tsx.status !== 'ready' || tsx.changes.length !== 1
      || tsx.changes[0]?.kind !== 'signatureChanged'
      || tsx.changes[0]?.parameters[0]?.op !== 'removed'
      || tsx.changes[0]?.parameters[1]?.op !== 'added'
      || tsx.changes[0]?.result?.op !== 'equal') {
      failures.push('synthetic-tsx/Card: extraction mismatch');
    }
    const commentBefore = Buffer.from('function f(x: /** id */ string): /* result */ Promise<void> {}');
    const commentAfter = Buffer.from('function f(x: number): Promise<User> {}');
    await writeFile(join(root, 'comment-before.ts'), commentBefore);
    await writeFile(join(root, 'comment-after.ts'), commentAfter);
    const commented = compareStructuredExtractions(extractTs(await readFile(join(root, 'comment-before.ts'))),
      extractTs(await readFile(join(root, 'comment-after.ts'))));
    if (commented.status !== 'ready' || commented.changes.length !== 1
      || !isDeepStrictEqual(commented.changes[0]?.parameters[0]?.before?.type,
        { state: 'written', text: 'string' })
      || !isDeepStrictEqual(commented.changes[0]?.result?.before,
        { kind: 'return', type: { state: 'written', text: 'Promise<void>' } })) {
      failures.push('synthetic-typescript/commented-header: extraction mismatch');
    }
    stdout(JSON.stringify({ status: failures.length ? 'fail' : 'pass', case_count: checked.length,
      tsx_pairs: 1, comment_pairs: 1, cases: checked, failures }));
    return failures.length ? 1 : 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
