import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTypeScriptPool } from './interface-ts-pool.ts';

test('cancelled TypeScript work retires its worker and a later comparison still runs', async () => {
  const pool = createTypeScriptPool();
  try {
    const first = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}') });
    first.cancel();
    await assert.rejects(first.promise, /cancelled/);
    const second = pool.run({ language: 'typescript', before: Buffer.from('function f(x: number): void {}'),
      after: Buffer.from('function f(x: string): void {}'),
      limits: { declarations: 4096, syntaxVisits: 100_000 } });
    const result = await second.promise;
    assert.equal(result.comparison?.status, 'ready');
    assert.equal(result.comparison?.changes.length, 1);
  } finally { await pool.close(); }
});
