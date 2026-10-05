import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { siblingModuleUrl } from './sibling-module.ts';

describe('siblingModuleUrl', () => {
  it('resolves to a .ts sibling when the caller runs from source', () => {
    const url = siblingModuleUrl('some-worker', 'file:///pkg/src/caller.ts');
    assert.equal(url.href, 'file:///pkg/src/some-worker.ts');
  });

  it('resolves to a .js sibling when the caller runs compiled', () => {
    const url = siblingModuleUrl('some-worker', 'file:///pkg/node_modules/@scope/x/dist/caller.js');
    assert.equal(url.href, 'file:///pkg/node_modules/@scope/x/dist/some-worker.js');
  });

  it('points at a real file for the workers this repo spawns', () => {
    for (const name of ['clip-projection-worker', 'interface-ts-worker', 'swift-parse-host', 'swift-parse-worker']) {
      assert.ok(existsSync(fileURLToPath(siblingModuleUrl(name, import.meta.url))), name);
    }
  });
});
