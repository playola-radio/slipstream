import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

describe('the runtime payload for the macOS app', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  it('holds the packed build and its production dependencies, with no symlinks', { timeout: 600_000 }, async () => {
    const out = await mkdtemp(join(tmpdir(), 'slip-payload-'));
    try {
      await run(process.execPath, [join(REPO, 'tools', 'build-payload.ts'), '--out', out],
        { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const app = join(out, 'app');
      for (const path of ['dist/cli.js', 'dist/build-id', 'node_modules/@parcel/watcher/package.json']) {
        await access(join(app, path));
      }
      await assert.rejects(access(join(app, 'node_modules', 'typescript')));
      const links = (await readdir(app, { recursive: true, withFileTypes: true })).filter((e) => e.isSymbolicLink());
      assert.deepEqual(links.map((e) => join(e.parentPath, e.name)), []);
      const { version } = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { version: string };
      const printed = await run(process.execPath, [join(app, 'dist', 'cli.js'), '--version']);
      assert.equal(printed.stdout, `${version}\n`);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
