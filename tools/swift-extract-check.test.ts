import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blobPath } from '../src/store-reader.ts';
import { runSwiftExtractCheck } from './swift-extract-check.ts';

test('isolated checker reads disposable captured blobs and compares source, without printing it', async () => {
  const store = await mkdtemp(join(tmpdir(), 'fd2-check-'));
  try {
    const fixture = new URL('../contracts/interface/v2/cases/swift-parameter-change/history.json', import.meta.url);
    const history = JSON.parse(await readFile(fixture, 'utf8')) as { blobs: Record<string, string> };
    for (const [sha, source] of Object.entries(history.blobs)) {
      const path = blobPath(store, sha);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, source);
    }
    const [before, after] = Object.keys(history.blobs);
    const lines: string[] = [], errors: string[] = [];
    const code = await runSwiftExtractCheck({ argv: ['--store', store, '--before', before!, '--after', after!],
      stdout: (s) => lines.push(s), stderr: (s) => errors.push(s) });
    assert.equal(code, 0, errors.join('\n'));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]!) as { status: string; changes: { parameters: { op: string }[] }[] };
    assert.equal(result.status, 'ready');
    assert.equal(result.changes[0]!.parameters[0]!.op, 'changed');
    assert.ok(!lines[0]!.includes('func f('), 'checker reports rows, not source bytes');
  } finally { await rm(store, { recursive: true, force: true }); }
});
