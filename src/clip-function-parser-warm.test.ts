import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Language } from 'web-tree-sitter';
import { createFunctionIndexer, warmFunctionIndexers } from './clip-function-parser.ts';

// Own file: grammar loads are cached per module instance, so this needs a clean one.
test('warming loads every grammar up front so a later request loads none', async () => {
  const load = mock.method(Language, 'load');
  await warmFunctionIndexers();
  const warmed = load.mock.callCount();
  assert.equal(warmed, 3);

  for (const language of ['typescript', 'tsx', 'javascript', 'jsx'] as const) {
    const index = await createFunctionIndexer(language);
    assert.equal(index('function f() {}\n').functions.length, 1);
  }
  assert.equal(load.mock.callCount(), warmed);
});
