import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appOwnedRefusal, appRecorderRoot, appRuntimeRoot } from './app-recorder-owner.ts';

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'slip-app-owner-')));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

/** A runtime as the app's prepare() leaves it: a version folder, no `current`. */
async function prepareRuntime(home: string): Promise<string> {
  const dist = join(appRuntimeRoot(home), '0.3.1-abcdef12', 'app', 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'cli.js'), '');
  return join(appRuntimeRoot(home), '0.3.1-abcdef12');
}

const npmCli = '/usr/local/lib/node_modules/@playola-radio/slipstream/dist/cli.js';

describe('appRecorderRoot', () => {
  it('lets npm run the recorder when the app has never run', async () => {
    await withHome(async (home) => {
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath: npmCli }), null);
    });
  });

  it('lets npm run the recorder when the app only left its lock or a staging copy', async () => {
    await withHome(async (home) => {
      const root = appRuntimeRoot(home);
      await mkdir(join(root, '.staging-1', 'app', 'dist'), { recursive: true });
      await writeFile(join(root, '.staging-1', 'app', 'dist', 'cli.js'), '');
      await writeFile(join(root, '.lock'), '');
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath: npmCli }), null);
    });
  });

  it('gives the default store to the app once it has prepared a runtime, even before `current` exists', async () => {
    await withHome(async (home) => {
      await prepareRuntime(home);
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath: npmCli }),
        appRuntimeRoot(home));
    });
  });

  it('leaves any other store to npm', async () => {
    await withHome(async (home) => {
      await prepareRuntime(home);
      assert.equal(await appRecorderRoot({ home, store: join(home, 'qa-store'), env: {}, cliPath: npmCli }), null);
    });
  });

  it('never refuses the app\'s own shims', async () => {
    await withHome(async (home) => {
      await prepareRuntime(home);
      const env = { SLIPSTREAM_APP_RUNTIME: appRuntimeRoot(home) };
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env, cliPath: npmCli }), null);
    });
  });

  it('never refuses the app\'s recorder that launchd starts without the shim', async () => {
    await withHome(async (home) => {
      const runtime = await prepareRuntime(home);
      const cliPath = join(runtime, 'app', 'dist', 'cli.js');
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath }), null);
    });
  });

  it('knows the app\'s store under another name for the same folder', async () => {
    await withHome(async (home) => {
      await prepareRuntime(home);
      await symlink(home, join(home, 'alias'));
      assert.equal(await appRecorderRoot({ home, store: join(home, 'alias', '.slipstream'), env: {}, cliPath: npmCli }),
        appRuntimeRoot(home));
      await mkdir(join(home, 'data'));
      await symlink(join(home, 'data'), join(home, '.slipstream'));
      assert.equal(await appRecorderRoot({ home, store: join(home, 'data'), env: {}, cliPath: npmCli }), appRuntimeRoot(home));
    });
  });

  for (const [what, unreadable] of [['runtime folder', ''], ['prepared runtime', '0.3.1-abcdef12']] as const) {
    it(`refuses to guess when the app's ${what} cannot be read`, async () => {
      await withHome(async (home) => {
        await prepareRuntime(home);
        const dir = join(appRuntimeRoot(home), unreadable);
        await chmod(dir, 0o000);
        try {
          await assert.rejects(appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath: npmCli }),
            { message: /^couldn't tell whether Slipstream\.app manages the recorder for .*: EACCES/ });
        } finally { await chmod(dir, 0o700); }
      });
    });
  }

  it('does not take a folder that only shares the runtime folder\'s name prefix for the app', async () => {
    await withHome(async (home) => {
      await prepareRuntime(home);
      const cliPath = join(`${appRuntimeRoot(home)}-old`, 'app', 'dist', 'cli.js');
      assert.equal(await appRecorderRoot({ home, store: join(home, '.slipstream'), env: {}, cliPath }),
        appRuntimeRoot(home));
    });
  });
});

describe('appOwnedRefusal', () => {
  it('says the app manages the recorder, what to use instead, and how to undo it after an uninstall', () => {
    const message = appOwnedRefusal('/h/.slipstream', '/h/rt', npmCli, 'start a recorder');
    assert.equal(message, `Slipstream.app manages the recorder for /h/.slipstream, so this copy of slipstream (${npmCli}) `
      + 'will not start a recorder. Open Slipstream.app, and run slipstream through its command, /h/rt/bin/slipstream. '
      + 'If you uninstalled Slipstream.app, remove /h/rt to let this copy run the recorder again.');
  });
});
