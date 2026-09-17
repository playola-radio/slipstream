import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './entrypoint.ts';
import { withTempDir } from './test/helpers.ts';

// Node hands `import.meta.url` back realpath'd, so the module URL these tests
// compare against is the realpath'd one (the temp dir itself is a symlink on
// macOS: /var -> /private/var).
const moduleUrl = (path: string): string => pathToFileURL(realpathSync(path)).href;

describe('isMainModule', () => {
  it('matches when argv names the module file directly', async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, 'cli.ts');
      await writeFile(real, '');
      assert.equal(isMainModule(moduleUrl(real), real), true);
    });
  });

  it('matches when argv is a symlink to the module file (npm-linked launch)', async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, 'cli.ts');
      const link = join(dir, 'slipstream');
      await writeFile(real, '');
      await symlink(real, link);
      // argv keeps the symlink path; the guard must realpath it to match.
      assert.equal(isMainModule(moduleUrl(real), link), true);
    });
  });

  it('does not match a different file, and returns false for a missing argv path', async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, 'cli.ts');
      const other = join(dir, 'other.ts');
      await writeFile(real, '');
      await writeFile(other, '');
      assert.equal(isMainModule(moduleUrl(real), other), false);
      assert.equal(isMainModule(moduleUrl(real), join(dir, 'missing.ts')), false);
    });
  });
});
