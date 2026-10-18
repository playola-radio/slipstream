import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InstallError, entryPaths, installLaunchAgent, kickstartLaunchAgent, plistPath, readManagedInstall, renderPlist, writeManagedInstall,
  type ManagedInstall, type Run,
} from './launch-agent.ts';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'slip-launch-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function fakeLaunchctl(loaded = false, failBootstrap = 0) {
  const calls: string[][] = [];
  let failures = failBootstrap;
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'print') return { code: loaded ? 0 : 113, output: '' };
    if (args[0] === 'bootstrap') {
      if (failures-- > 0) return { code: 5, output: 'Bootstrap failed: 5: Input/output error' };
      loaded = true;
    }
    if (args[0] === 'bootout') loaded = false;
    return { code: 0, output: '' };
  };
  return { run, calls, verbs: () => calls.map((c) => c[1]) };
}

const paths = { node: '/opt/node-24/bin/node', cli: '/opt/lib/node_modules/@playola-radio/slipstream/dist/cli.js' };

describe('the LaunchAgent', () => {
  it('runs the daemon with the recorded absolute paths and a deliberate PATH', () => {
    const text = renderPlist({ ...paths, store: '/Users/x/.slipstream', log: '/Users/x/Library/Logs/slipstream/daemon.log', home: '/Users/x' });
    assert.match(text, /<string>\/opt\/node-24\/bin\/node<\/string>\s*<string>\/opt\/lib\/node_modules\/@playola-radio\/slipstream\/dist\/cli\.js<\/string>\s*<string>start<\/string>/);
    assert.match(text, /<key>PATH<\/key>\s*<string>[^<]*\/usr\/bin[^<]*<\/string>/);
    assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/x\/Library\/Logs\/slipstream\/daemon\.log<\/string>/);
    assert.doesNotMatch(text, /nvm|bash|zsh/);
  });

  it('escapes paths for the plist', () => {
    const text = renderPlist({ ...paths, store: '/tmp/a&b<c>', log: '/tmp/log', home: '/tmp' });
    assert.match(text, /<string>\/tmp\/a&amp;b&lt;c&gt;<\/string>/);
  });

  it('writes the plist and loads it', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl();
      const res = await installLaunchAgent({ ...paths, home, store: join(home, '.slipstream'), uid: 501 }, l.run);
      assert.equal(res.reloaded, true);
      assert.match(await readFile(plistPath(home), 'utf8'), /\/opt\/node-24\/bin\/node/);
      assert.deepEqual(l.calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', plistPath(home)]);
    });
  });

  it('leaves a loaded, unchanged LaunchAgent alone', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl();
      const o = { ...paths, home, store: join(home, '.slipstream'), uid: 501 };
      await installLaunchAgent(o, l.run);
      const again = await installLaunchAgent(o, l.run);
      assert.equal(again.reloaded, false);
      assert.deepEqual(l.verbs().slice(-1), ['print']);
    });
  });

  it('restarts an unchanged LaunchAgent when asked, so new code at the same paths runs', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl();
      const o = { ...paths, home, store: join(home, '.slipstream'), uid: 501 };
      await installLaunchAgent(o, l.run);
      const res = await installLaunchAgent({ ...o, restart: true }, l.run);
      assert.equal(res.reloaded, true);
      assert.deepEqual(l.calls.at(-1), ['launchctl', 'kickstart', '-k', 'gui/501/radio.playola.slipstream']);
    });
  });

  it('rewrites and reloads the LaunchAgent after an upgrade moves Node', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl();
      const o = { ...paths, home, store: join(home, '.slipstream'), uid: 501 };
      await installLaunchAgent(o, l.run);
      const res = await installLaunchAgent({ ...o, node: '/opt/node-24.12/bin/node' }, l.run);
      assert.equal(res.reloaded, true);
      const text = await readFile(plistPath(home), 'utf8');
      assert.match(text, /\/opt\/node-24\.12\/bin\/node/);
      assert.doesNotMatch(text, /\/opt\/node-24\/bin\/node/);
      assert.deepEqual(l.verbs().slice(-2), ['bootout', 'bootstrap']);
    });
  });

  it('refuses to replace a managed daemon for a different store', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl();
      await installLaunchAgent({ ...paths, home, store: join(home, 'a'), uid: 501 }, l.run);
      await assert.rejects(installLaunchAgent({ ...paths, home, store: join(home, 'b'), uid: 501 }, l.run), InstallError);
    });
  });

  it('retries a bootstrap that races the previous instance unloading', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl(false, 2);
      const res = await installLaunchAgent({ ...paths, home, store: join(home, '.slipstream'), uid: 501 }, l.run);
      assert.equal(res.reloaded, true);
      assert.equal(l.verbs().filter((v) => v === 'bootstrap').length, 3);
    });
  });

  it('reports launchctl\'s own words when loading keeps failing', async () => {
    await withHome(async (home) => {
      const l = fakeLaunchctl(false, 99);
      await assert.rejects(installLaunchAgent({ ...paths, home, store: join(home, '.slipstream'), uid: 501 }, l.run),
        (err: Error) => err instanceof InstallError && /Input\/output error/.test(err.message));
    });
  });

  it('starts the managed daemon through launchd, settling only if launchd refuses', async () => {
    const ok = kickstartLaunchAgent(501, async () => ({ code: 0, output: '' }));
    const settled = await Promise.race([ok.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
    assert.equal(settled, false);
    assert.equal(await kickstartLaunchAgent(501, async () => ({ code: 113, output: '' })).exited, 113);
  });
});

describe('the install record', () => {
  const install: ManagedInstall = { version: 1, package_version: '0.3.0', ...paths, log: '/l/daemon.log', repos: [] };

  it('creates an absent store and its control directory owner-only', async () => {
    await withHome(async (home) => {
      const store = join(home, '.slipstream');
      await writeManagedInstall(store, install);
      assert.equal((await stat(store)).mode & 0o777, 0o700);
      assert.equal((await stat(join(store, 'control'))).mode & 0o777, 0o700);
      assert.deepEqual(await readManagedInstall(store), install);
    });
  });

  it('refuses an existing store that other users can read', async () => {
    await withHome(async (home) => {
      const store = join(home, '.slipstream');
      await mkdir(store);
      await chmod(store, 0o755);
      await assert.rejects(writeManagedInstall(store, install), /insecure-path/);
      assert.equal(await readManagedInstall(store), null);
    });
  });
});

describe('recorded entry paths', () => {
  it('accepts an absolute Node 24 and an existing entry file', async () => {
    await withHome(async (home) => {
      const cli = join(home, 'cli.js');
      await writeFile(cli, '');
      assert.deepEqual(await entryPaths('/opt/node/bin/node', '24.11.0', cli), { node: '/opt/node/bin/node', cli });
    });
  });

  it('refuses an older Node, a relative Node path, or a missing entry', async () => {
    await withHome(async (home) => {
      const cli = join(home, 'cli.js');
      await writeFile(cli, '');
      await assert.rejects(entryPaths('/opt/node/bin/node', '22.4.0', cli), /Node 24/);
      await assert.rejects(entryPaths('node', '24.1.0', cli), /not absolute/);
      await assert.rejects(entryPaths('/opt/node/bin/node', '24.1.0', join(home, 'missing.js')), /not a file/);
    });
  });
});
