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
    comment_pairs: number;
    cases: string[];
  };
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.cases, [
    'range-all-failed-page/src/a.ts',
    'range-cancelled-mid-page/src/a.ts',
    'range-deadline-mid-page/src/a.ts',
    'range-gap-before-b/src/f.ts', 'range-gap-cap/src/f.ts',
    'range-lookahead-timeout/src/a.ts',
    'range-page-boundary-first/src/a.ts', 'range-page-boundary-second/src/b.ts',
    'range-rename/src/a.ts', 'range-rename/src/b.ts',
    'range-restart-reconciliation/src/f.ts', 'range-unknown-scopes/src/f.ts',
    'ts-added-file/src/f.ts', 'ts-added-function/src/f.ts',
    'ts-constructor-change/src/f.ts', 'ts-destructured-param/src/f.ts',
    'ts-inferred-return/src/f.ts', 'ts-known-path-incomplete-baseline/src/f.ts',
    'ts-optional-rest-default/src/f.ts', 'ts-overload-ambiguity/src/f.ts',
    'ts-parameter-change/src/f.ts', 'ts-parameter-reorder/src/f.ts',
    'ts-parse-failure/src/f.ts', 'ts-removed-file/src/f.ts',
    'ts-removed-function/src/f.ts', 'ts-return-change/src/f.ts',
    'ts-shared-type-only/src/types/user.ts', 'ts-unchanged-signature/src/f.ts',
    'ts-unicode-span/src/f.ts',
  ]);
  assert.equal(report.case_count, report.cases.length);
  assert.equal(report.tsx_pairs, 1);
  assert.equal(report.comment_pairs, 1);
});
