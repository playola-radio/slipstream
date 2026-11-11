import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEntries, appRecorderRefusal, appRuntime, appRuntimeRoot } from './app-runtime.ts';

describe('appRuntime', () => {
  it('is null outside the Slipstream app', () => {
    assert.equal(appRuntime({}), null);
  });

  it('derives both shim paths from the runtime root the shims set', () => {
    assert.deepEqual(appRuntime({ SLIPSTREAM_APP_RUNTIME: '/rt' }),
      { root: '/rt', cli: '/rt/bin/slipstream', mcp: '/rt/bin/slipstream-mcp' });
  });
});

describe('agentEntries', () => {
  it('runs the CLI and the forwarder beside it with this Node outside the app', () => {
    assert.deepEqual(agentEntries({}, '/n/node', '/pkg/dist/cli.js'), {
      entry: { command: '/n/node', args: ['/pkg/dist/cli.js'] },
      mcpEntry: { command: '/n/node', args: ['/pkg/dist/mcp-forwarder.js'] },
    });
  });

  it('runs the app\'s stable shims in the app', () => {
    assert.deepEqual(agentEntries({ SLIPSTREAM_APP_RUNTIME: '/rt' }, '/n/node', '/pkg/dist/cli.js'), {
      entry: { command: '/rt/bin/slipstream', args: [] },
      mcpEntry: { command: '/rt/bin/slipstream-mcp', args: [] },
    });
  });
});

/** A runtime the app copied out of its bundle, as its `prepare` leaves it. */
async function prepareRuntime(home: string, name = '0.3.1-91e380a6'): Promise<string> {
  const dir = join(appRuntimeRoot(home), name);
  await mkdir(join(dir, 'app', 'dist'), { recursive: true });
  await mkdir(join(dir, 'bin'));
  for (const file of ['app/package.json', 'app/dist/cli.js', 'bin/node']) await writeFile(join(dir, file), '');
  return dir;
}

describe('appRecorderRefusal', () => {
  const withHome = async (body: (home: string) => Promise<void>) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'slip-app-home-')));
    try { await body(home); } finally { await rm(home, { recursive: true, force: true }); }
  };
  const npmCli = '/usr/local/lib/node_modules/@playola-radio/slipstream/dist/cli.js';

  it('leaves the recorder to this copy when the app has no runtime folder', () => withHome(async (home) => {
    assert.equal(await appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(home, '.slipstream') }), null);
  }));

  it('leaves the recorder to this copy when the app never finished copying a runtime', () => withHome(async (home) => {
    const root = appRuntimeRoot(home);
    await mkdir(join(root, '.staging-1', 'app', 'dist'), { recursive: true });
    await mkdir(join(root, '0.3.1-91e380a6', 'app'), { recursive: true });
    await writeFile(join(root, '.lock'), '');
    assert.equal(await appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(home, '.slipstream') }), null);
  }));

  it('refuses for the default store once the app has prepared a runtime, even before it activates one', () => withHome(async (home) => {
    await prepareRuntime(home);
    const refusal = await appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(home, '.slipstream') });
    assert.match(refusal ?? '', /^Slipstream\.app manages the recorder for /);
    assert.ok(refusal?.includes(npmCli), refusal ?? '');
    assert.ok(refusal?.includes(`delete ${appRuntimeRoot(home)}`), refusal ?? '');
  }));

  it('refuses for the default store reached through another path', () => withHome(async (home) => {
    await prepareRuntime(home);
    const alias = `${home}-alias`;
    await symlink(home, alias);
    try {
      const refusal = () => appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(alias, '.slipstream') });
      assert.notEqual(await refusal(), null);
      await mkdir(join(home, '.slipstream'));
      assert.notEqual(await refusal(), null);
    } finally { await rm(alias); }
  }));

  it('reports a runtime folder it cannot read instead of taking the recorder', { skip: process.getuid?.() === 0 }, () => withHome(async (home) => {
    await prepareRuntime(home);
    const root = appRuntimeRoot(home);
    for (const [dir, mode] of [[root, 0o300], [join(root, '0.3.1-91e380a6'), 0o000]] as const) {
      await chmod(dir, mode);
      try {
        await assert.rejects(appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(home, '.slipstream') }), { code: 'EACCES' });
      } finally { await chmod(dir, 0o700); }
    }
  }));

  it('leaves any other store to this copy', () => withHome(async (home) => {
    await prepareRuntime(home);
    assert.equal(await appRecorderRefusal({ env: {}, home, cliPath: npmCli, store: join(home, 'other-store') }), null);
  }));

  it('lets a process started through the app\'s shims run the recorder', () => withHome(async (home) => {
    await prepareRuntime(home);
    assert.equal(await appRecorderRefusal({ env: { SLIPSTREAM_APP_RUNTIME: appRuntimeRoot(home) }, home, cliPath: npmCli,
      store: join(home, '.slipstream') }), null);
  }));

  it('lets the app\'s own copy run the recorder without the shims, as its LaunchAgent starts it', () => withHome(async (home) => {
    const dir = await prepareRuntime(home);
    assert.equal(await appRecorderRefusal({ env: {}, home, cliPath: join(dir, 'app', 'dist', 'cli.js'),
      store: join(home, '.slipstream') }), null);
  }));
});
