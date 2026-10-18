import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ResponseEnvelope } from './control-protocol.ts';
import { readTomlScripts } from './conductor-settings.ts';
import {
  InventoryError, chainScript, chainedOwn, localSettingsPath, readConductorInventory, runConductorArchive, runConductorEnroll,
  runConductorInstall, runConductorSetup, slipstreamCommand, type InstallDeps,
} from './conductor.ts';
import { plistPath, readManagedInstall, type Run } from './launch-agent.ts';

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-conductor-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

function fakeRun(opts: { gitIgnored?: boolean } = {}) {
  const calls: string[][] = [];
  let loaded = false;
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') return { code: opts.gitIgnored === false ? 1 : 0, output: '' };
    if (args[0] === 'print') return { code: loaded ? 0 : 113, output: '' };
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return { code: 0, output: '' };
  };
  return { run, calls };
}

interface Machine { home: string; store: string; cli: string; repo: (name: string) => string; deps: (o?: Partial<InstallDeps>) => InstallDeps;
  out: string[] }

async function withMachine(fn: (m: Machine) => Promise<void>, runOpts?: { gitIgnored?: boolean }): Promise<void> {
  await withTemp(async (dir) => {
    const home = join(dir, 'home');
    const cli = join(dir, 'pkg', 'dist', 'cli.js');
    await put(cli, '');
    const repoRoots: string[] = [];
    const out: string[] = [];
    const { run } = fakeRun(runOpts);
    const repo = (name: string) => {
      const root = join(dir, 'repos', name);
      if (!repoRoots.includes(root)) repoRoots.push(root);
      return root;
    };
    await fn({
      home, store: join(home, '.slipstream'), cli, repo, out,
      deps: (o = {}) => ({
        home, store: join(home, '.slipstream'), uid: 501, execPath: '/opt/node-24/bin/node', nodeVersion: '24.11.0',
        cliPath: cli, packageVersion: '0.3.0', run, listRepos: async () => repoRoots,
        out: (l) => out.push(l), err: (l) => out.push(l), ...o,
      }),
    });
  });
}

const read = (path: string) => readFile(path, 'utf8');
const P = { node: '/opt/node 24/bin/node', cli: "/opt/it's/dist/cli.js", store: '/Users/x/.slipstream' };

describe('the Slipstream chain in a Conductor script', () => {
  it('quotes every recorded path and names the store', () => {
    assert.equal(slipstreamCommand('setup', P), `'/opt/node 24/bin/node' '/opt/it'\\''s/dist/cli.js' conductor setup --store /Users/x/.slipstream`);
  });

  it('runs the repo\'s own command only after Slipstream, grouped', () => {
    const ours = slipstreamCommand('archive', P);
    assert.equal(chainScript(ours, 'a; b # c'), `${ours} && {\na; b # c\n}`);
    assert.equal(chainScript(ours, null), ours);
  });

  it('recognizes its own chain and what it wraps, and nothing else', () => {
    const ours = slipstreamCommand('setup', P);
    assert.deepEqual(chainedOwn(chainScript(ours, 'npm ci\nnpm run build')), { own: 'npm ci\nnpm run build' });
    assert.deepEqual(chainedOwn(ours), { own: null });
    assert.equal(chainedOwn('npm ci'), undefined);
    assert.equal(chainedOwn(`echo hi && ${ours}`), undefined);
  });
});

describe('slipstream conductor install', () => {
  it('chains Slipstream ahead of each repo\'s effective scripts and leaves other settings alone', async () => {
    await withMachine(async (m) => {
      await put(join(m.home, '.conductor', 'settings.toml'), '[ui]\ntheme = "dark"\n\n[scripts]\nsetup = "echo personal"\n');
      const shared = m.repo('shared');
      await put(join(shared, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\narchive = "rm -rf tmp"\nrun = "npm start"\n');
      const legacy = m.repo('legacy');
      await put(join(legacy, 'conductor.json'), '{"scripts":{"setup":"make deps"}}');
      const plain = m.repo('plain');
      await mkdir(plain, { recursive: true });
      const local = m.repo('local');
      await put(join(local, '.conductor', 'settings.toml'), '[scripts]\nsetup = "shared one"\n');
      await put(localSettingsPath(local), '[git]\nremote = "upstream"\n\n[scripts]\nsetup = "my own"\n');

      assert.equal(await runConductorInstall(m.deps()), 0);
      const ours = (kind: 'setup' | 'archive') => slipstreamCommand(kind, { node: '/opt/node-24/bin/node', cli: m.cli, store: m.store });

      const personal = await read(join(m.home, '.conductor', 'settings.toml'));
      assert.match(personal, /^\[ui\]\ntheme = "dark"\n/);
      assert.deepEqual(readTomlScripts(personal, 'p'), { setup: chainScript(ours('setup'), 'echo personal'), archive: ours('archive') });
      assert.deepEqual(readTomlScripts(await read(localSettingsPath(shared)), 'l'),
        { setup: chainScript(ours('setup'), 'npm ci'), archive: chainScript(ours('archive'), 'rm -rf tmp') });
      assert.deepEqual(readTomlScripts(await read(localSettingsPath(legacy)), 'l'), { setup: chainScript(ours('setup'), 'make deps') });
      await assert.rejects(read(localSettingsPath(plain)), { code: 'ENOENT' });
      const localText = await read(localSettingsPath(local));
      assert.match(localText, /\[git\]\nremote = "upstream"/);
      assert.deepEqual(readTomlScripts(localText, 'l'), { setup: chainScript(ours('setup'), 'my own') });

      const record = await readManagedInstall(m.store);
      assert.equal(record?.package_version, '0.3.0');
      assert.deepEqual(record?.repos.map((r) => [r.root, r.setup, r.archive]),
        [[legacy, 'make deps', null], [local, 'shared one', null], [shared, 'npm ci', 'rm -rf tmp']]);
    });
  });

  it('changes nothing on a second run', async () => {
    await withMachine(async (m) => {
      const shared = m.repo('shared');
      await put(join(shared, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      await runConductorInstall(m.deps());
      const before = [await read(join(m.home, '.conductor', 'settings.toml')), await read(localSettingsPath(shared))];
      assert.equal(await runConductorInstall(m.deps()), 0);
      assert.deepEqual([await read(join(m.home, '.conductor', 'settings.toml')), await read(localSettingsPath(shared))], before);
      assert.ok(m.out.some((l) => /LaunchAgent: .*\(unchanged\)/.test(l)));
    });
  });

  it('follows a repo script that changed since the last install, but keeps a hand-edited chain', async () => {
    await withMachine(async (m) => {
      const a = m.repo('a');
      const b = m.repo('b');
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      await put(join(b, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      await runConductorInstall(m.deps());
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "pnpm i"\n');
      await put(join(b, '.conductor', 'settings.toml'), '[scripts]\nsetup = "pnpm i"\n');
      const bLocal = await read(localSettingsPath(b));
      await writeFile(localSettingsPath(b), bLocal.replace('npm ci', 'npm ci --legacy'));
      await runConductorInstall(m.deps());
      assert.equal(chainedOwn(readTomlScripts(await read(localSettingsPath(a)), 'l').setup!)?.own, 'pnpm i');
      assert.equal(chainedOwn(readTomlScripts(await read(localSettingsPath(b)), 'l').setup!)?.own, 'npm ci --legacy');
    });
  });

  it('rewrites every script and the LaunchAgent to the new absolute paths after an upgrade', async () => {
    await withMachine(async (m) => {
      const a = m.repo('a');
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      await runConductorInstall(m.deps());
      const newCli = join(m.home, 'new-prefix', 'dist', 'cli.js');
      await put(newCli, '');
      assert.equal(await runConductorInstall(m.deps({ execPath: '/opt/node-24.12/bin/node', cliPath: newCli, packageVersion: '0.4.0' })), 0);
      const files = [join(m.home, '.conductor', 'settings.toml'), localSettingsPath(a), plistPath(m.home)];
      for (const file of files) {
        const text = await read(file);
        assert.match(text, /\/opt\/node-24\.12\/bin\/node/, file);
        assert.ok(text.includes(newCli), file);
        assert.doesNotMatch(text, /\/opt\/node-24\/bin\/node/, file);
        assert.ok(!text.includes(m.cli), file);
      }
      const record = await readManagedInstall(m.store);
      assert.deepEqual([record?.node, record?.cli, record?.package_version], ['/opt/node-24.12/bin/node', newCli, '0.4.0']);
    });
  });

  it('writes nothing when a settings file is in a form it does not edit', async () => {
    await withMachine(async (m) => {
      const a = m.repo('a');
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      const b = m.repo('b');
      await put(join(b, '.conductor', 'settings.toml'), 'scripts = { setup = "npm ci" }\n');
      assert.equal(await runConductorInstall(m.deps()), 1);
      await assert.rejects(read(localSettingsPath(a)), { code: 'ENOENT' });
      await assert.rejects(read(join(m.home, '.conductor', 'settings.toml')), { code: 'ENOENT' });
      await assert.rejects(read(plistPath(m.home)), { code: 'ENOENT' });
      assert.ok(m.out.some((l) => l.includes(join(b, '.conductor', 'settings.toml'))));
    });
  });

  it('warns about an override git would commit, managed scripts, and a missing repo', async () => {
    await withMachine(async (m) => {
      const a = m.repo('a');
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      m.repo('gone');
      await put(join(m.home, '.conductor', 'settings.managed.toml'), '[scripts]\nsetup = "corp"\n');
      assert.equal(await runConductorInstall(m.deps()), 0);
      assert.ok(m.out.some((l) => l.startsWith(`warning: ${localSettingsPath(a)} is not ignored by git`)));
      assert.ok(m.out.some((l) => /settings\.managed\.toml sets Conductor scripts/.test(l)));
      assert.ok(m.out.some((l) => /^skipped .*gone: Conductor lists it/.test(l)));
    }, { gitIgnored: false });
  });

  it('refuses a Node older than 24', async () => {
    await withMachine(async (m) => {
      assert.equal(await runConductorInstall(m.deps({ nodeVersion: '22.4.0' })), 1);
      assert.ok(m.out.some((l) => /Node 24/.test(l)));
    });
  });
});

describe('slipstream conductor setup', () => {
  const base = (o: Partial<Parameters<typeof runConductorSetup>[0]> = {}) => {
    const err: string[] = [];
    const attached: string[] = [];
    return {
      err, attached,
      deps: {
        env: { CONDUCTOR_WORKSPACE_PATH: '/w/one' }, store: '/nonexistent-store', packageVersion: '0.3.0',
        ensureDaemon: async () => {}, attach: async (dir: string) => { attached.push(dir); return 0; },
        err: (l: string) => err.push(l), ...o,
      },
    };
  };

  it('is a usage error outside a Conductor setup script', async () => {
    const s = base({ env: {} });
    assert.equal(await runConductorSetup(s.deps), 2);
    assert.deepEqual(s.attached, []);
  });

  it('passes on the waiting attach\'s outcome', async () => {
    for (const code of [0, 1, 3]) {
      const s = base({ attach: async () => code });
      assert.equal(await runConductorSetup(s.deps), code);
    }
  });

  it('fails visibly, attaching nothing, when the daemon cannot start', async () => {
    const s = base({ ensureDaemon: async () => { throw new Error('the daemon did not start. See /log for why.'); } });
    assert.equal(await runConductorSetup(s.deps), 1);
    assert.deepEqual(s.attached, []);
    assert.deepEqual(s.err, ['slipstream: the daemon did not start. See /log for why.', 'slipstream: /w/one is NOT recording.']);
  });

  it('warns when the repo\'s own script or the Slipstream version drifted since install', async () => {
    await withMachine(async (m) => {
      const a = m.repo('a');
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "npm ci"\n');
      await runConductorInstall(m.deps());
      await put(join(a, '.conductor', 'settings.toml'), '[scripts]\nsetup = "pnpm i"\n');
      const s = base({ store: m.store, packageVersion: '0.4.0', env: { CONDUCTOR_WORKSPACE_PATH: '/w/one', CONDUCTOR_ROOT_PATH: a } });
      assert.equal(await runConductorSetup(s.deps), 0);
      assert.ok(s.err.some((l) => /recorded by Slipstream 0\.3\.0, but this is 0\.4\.0/.test(l)));
      assert.ok(s.err.some((l) => /own setup script changed since/.test(l)));
      assert.ok(!s.err.some((l) => /own archive script/.test(l)));
    });
  });
});

describe('slipstream conductor archive', () => {
  it('withdraws the workspace Conductor is archiving', async () => {
    const targets: string[] = [];
    assert.equal(await runConductorArchive({ env: { CONDUCTOR_WORKSPACE_PATH: '/w/one' }, err: () => {},
      withdraw: async (t) => { targets.push(t); return 0; } }), 0);
    assert.deepEqual(targets, ['/w/one']);
    assert.equal(await runConductorArchive({ env: {}, err: () => {}, withdraw: async () => 0 }), 2);
  });
});

describe('slipstream conductor enroll', () => {
  function daemon(replies: Record<string, ResponseEnvelope>) {
    const asked: string[] = [];
    return {
      asked,
      control: async (req: Record<string, unknown>) => {
        asked.push(String(req.worktree));
        return replies[String(req.worktree)] ?? { v: 1, ok: true, session_id: 's', state: 'queued', created: true };
      },
    };
  }
  const limit: ResponseEnvelope = { v: 1, ok: false, code: 'CAPTURE_LIMIT_REACHED', message: '16/16 capture slots in use.' };

  it('asks in order, discloses the order, and tells the user to archive when workspaces wait', async () => {
    const d = daemon({ '/w/c': limit, '/w/b': { v: 1, ok: true, session_id: 's', state: 'recording', created: false } });
    const out: string[] = [];
    const code = await runConductorEnroll({ workspaces: ['/w/a', '/w/b', '/w/c'], byActivity: true },
      { ensureDaemon: async () => {}, control: d.control, out: (l) => out.push(l), err: (l) => out.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(d.asked, ['/w/a', '/w/b', '/w/c']);
    assert.match(out[0]!, /most recently active first/);
    assert.ok(out.includes('/w/c: waiting for a capture slot (NOT recording)'));
    assert.ok(out.includes('1 recording, 1 starting, 1 waiting, 0 not recording.'));
    assert.ok(out.some((l) => /Archive workspaces you no longer use/.test(l)));
  });

  it('reports each failed workspace and exits 1', async () => {
    const d = daemon({ '/w/gone': { v: 1, ok: false, code: 'CAPTURE_NOT_READY', message: 'ENOENT' } });
    const out: string[] = [];
    const code = await runConductorEnroll({ workspaces: ['/w/gone', '/w/ok'], byActivity: false },
      { ensureDaemon: async () => {}, control: d.control, out: (l) => out.push(l), err: (l) => out.push(l) });
    assert.equal(code, 1);
    assert.match(out[0]!, /inventory order/);
    assert.ok(out.includes('slipstream: /w/gone: NOT recording (CAPTURE_NOT_READY: ENOENT)'));
    assert.deepEqual(d.asked, ['/w/gone', '/w/ok']);
  });
});

describe('Conductor\'s workspace inventory', () => {
  function makeDb(path: string, withActivity = true): DatabaseSync {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE workspaces (id TEXT, state TEXT, workspace_path TEXT${withActivity ? ', last_activity_at TEXT' : ''})`);
    db.exec('CREATE TABLE repos (id TEXT, root_path TEXT)');
    db.exec(`INSERT INTO repos VALUES ('r1', '/repos/one'), ('r2', '')`);
    return db;
  }

  it('lists non-archived workspaces, sleeping ones too, most recently active first', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'conductor.db');
      const db = makeDb(path);
      db.exec(`INSERT INTO workspaces VALUES
        ('1', 'ready', '/w/old', '2026-10-01T00:00:00Z'),
        ('2', 'sleeping', '/w/newest', '2026-10-16T00:00:00Z'),
        ('3', 'archived', '/w/archived', '2026-10-17T00:00:00Z'),
        ('4', 'ready', '/w/never', NULL),
        ('5', 'ready', '', '2026-10-15T00:00:00Z'),
        ('6', 'ready', '/w/mid', '2026-10-10T00:00:00Z')`);
      db.close();
      assert.deepEqual(await readConductorInventory(path),
        { workspaces: ['/w/newest', '/w/mid', '/w/old', '/w/never'], byActivity: true, repos: ['/repos/one'] });
    });
  });

  it('falls back to inventory order without an activity time', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'conductor.db');
      const db = makeDb(path, false);
      db.exec(`INSERT INTO workspaces VALUES ('1', 'ready', '/w/b'), ('2', 'ready', '/w/a')`);
      db.close();
      assert.deepEqual((await readConductorInventory(path)).workspaces, ['/w/b', '/w/a']);
      assert.equal((await readConductorInventory(path)).byActivity, false);
    });
  });

  it('refuses a database whose shape it does not recognize', async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'conductor.db');
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE workspaces (id TEXT, path TEXT)');
      db.exec('CREATE TABLE repos (id TEXT, root_path TEXT)');
      db.close();
      await assert.rejects(readConductorInventory(path),
        (err: Error) => err instanceof InventoryError && /workspaces\.state, workspaces\.workspace_path/.test(err.message));
      await assert.rejects(readConductorInventory(join(dir, 'missing.db')), InventoryError);
    });
  });
});
