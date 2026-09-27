import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('standalone TypeScript v2 checker extracts disposable captured pairs', () => {
  const output = execFileSync(process.execPath,
    ['tools/projection-check.ts', 'interface-v2', '--lang', 'typescript'],
    { encoding: 'utf8', timeout: 30_000 });
  const report = JSON.parse(output) as {
    status: string;
    case_count: number;
    tsx_pairs: number;
    cases: string[];
  };
  assert.equal(report.status, 'pass');
  assert.equal(report.case_count, 28);
  assert.equal(report.tsx_pairs, 1);
  assert.ok(report.cases.includes('ts-unicode-span/src/f.ts'));
  assert.ok(report.cases.includes('range-rename/src/b.ts'));
});
