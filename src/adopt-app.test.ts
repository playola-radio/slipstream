import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runAdoptApp, type AdoptDeps } from './adopt-app.ts';
import { emptyIntent } from './capture-intent.ts';
import { saveIntent } from './intent-store.ts';

const NODE = '/Users/x/.nvm/versions/node/v24.11.0/bin/node';
const PKG = '/Users/x/.nvm/versions/node/v24.11.0/lib/node_modules/@playola-radio/slipstream/dist';
const OLD_CLI = `${PKG}/cli.js`;
const OLD_FORWARDER = `${PKG}/mcp-forwarder.js`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'slip-adopt-'));
  const home = join(dir, 'home');
  const store = join(dir, 'store');
  const rt = join(dir, 'rt');
  const roots = [join(dir, 'w1'), join(dir, 'w2')];
  for (const root of roots) await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  const record = emptyIntent();
  record.captures = roots.map((root, i) => ({ session_id: `cap-${i}`, root, root_identity: null, intent: 'running',
    withdrawn_reason: null, capture_mode: 'watch-only', last_failure: null }));
  await saveIntent(store, record);
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const deps: AdoptDeps = {
    env: { SLIPSTREAM_APP_RUNTIME: rt, CODEX_HOME: join(home, '.codex') }, home, store,
    out: (line) => lines.push(line), err: (line) => errors.push(line),
    run: async (command, args, cwd) => { calls.push({ command, args, cwd }); return { code: 0, output: '' }; },
  };
  return { dir, home, store, rt, roots, lines, errors, calls, deps,
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function oldHook(harness: string, store: string): string {
  return `${NODE} ${OLD_CLI} hook ${harness} post-tool-use --store ${store}`;
}

function hooksFile(command: string): string {
  return `${JSON.stringify({ hooks: { PostToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "unrelated"' }] },
    { matcher: '*', hooks: [{ type: 'command', command, timeout: 3 }] },
  ] } }, null, 2)}\n`;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** The backups of `path` kept in the store, as full paths. */
async function backups(store: string, path: string): Promise<string[]> {
  const dir = join(store, 'backups', dirname(path));
  const names = await readdir(dir).catch(() => []);
  return names.filter((n) => n.startsWith(`${basename(path)}.slipstream-backup-`)).map((n) => join(dir, n));
}

async function besideBackups(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).filter((n) => n.includes('.slipstream-backup-'));
}

describe('adopt-app', () => {
  it('rewritesWorktreeHooks', async () => {
    const f = await fixture();
    try {
      const claude = join(f.roots[0]!, '.claude', 'settings.local.json');
      const codex = join(f.roots[1]!, '.codex', 'hooks.json');
      const claudeBefore = hooksFile(oldHook('claude-code', f.store));
      const codexBefore = hooksFile(oldHook('codex', f.store));
      await put(claude, claudeBefore);
      await put(codex, codexBefore);

      assert.equal(await runAdoptApp(f.deps), 0);

      const claudeHook = `${f.rt}/bin/slipstream hook claude-code post-tool-use --store ${f.store}`;
      const codexHook = `${f.rt}/bin/slipstream hook codex post-tool-use --store ${f.store}`;
      assert.equal(await readFile(claude, 'utf8'),
        claudeBefore.replace(JSON.stringify(oldHook('claude-code', f.store)), JSON.stringify(claudeHook)));
      assert.equal(await readFile(codex, 'utf8'),
        codexBefore.replace(JSON.stringify(oldHook('codex', f.store)), JSON.stringify(codexHook)));
      const [claudeBackup] = await backups(f.store, claude);
      assert.match(claudeBackup!, /\.slipstream-backup-\d+$/);
      assert.equal(await readFile(claudeBackup!, 'utf8'), claudeBefore);
      assert.ok(f.lines.includes(`rewrote ${claude} (backup ${claudeBackup})`), f.lines.join('\n'));
      assert.equal((await backups(f.store, codex)).length, 1);
      assert.deepEqual(await besideBackups(claude), []);
      assert.deepEqual(await besideBackups(codex), []);
    } finally { await f.cleanup(); }
  });

  it('leaves a hook for another store alone', async () => {
    const f = await fixture();
    try {
      const claude = join(f.roots[0]!, '.claude', 'settings.local.json');
      const before = hooksFile(oldHook('claude-code', '/elsewhere/store'));
      await put(claude, before);
      assert.equal(await runAdoptApp(f.deps), 0);
      assert.equal(await readFile(claude, 'utf8'), before);
      assert.deepEqual(f.lines, [`unchanged ${claude}`]);
    } finally { await f.cleanup(); }
  });

  it('rewritesCodexTool', async () => {
    const f = await fixture();
    try {
      const old = `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(NODE)}\n`
        + `args = [${JSON.stringify(OLD_FORWARDER)}, "--store", ${JSON.stringify(f.store)}]\n`;
      const other = '# mine\n[mcp_servers.other]\ncommand = "other"\n\n';
      const project = join(f.roots[0]!, '.codex', 'config.toml');
      const user = join(f.home, '.codex', 'config.toml');
      await put(project, `${other}${old}startup_timeout_sec = 20\n`);
      await put(user, `${old}\n[profiles.fast]\nmodel = "x"\n`);

      assert.equal(await runAdoptApp(f.deps), 0);

      const shim = `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(`${f.rt}/bin/slipstream-mcp`)}\n`
        + `args = ["--store", ${JSON.stringify(f.store)}]\n`;
      assert.equal(await readFile(project, 'utf8'), `${other}${shim}startup_timeout_sec = 20\n`);
      assert.equal(await readFile(user, 'utf8'), `${shim}\n[profiles.fast]\nmodel = "x"\n`);
      assert.equal((await backups(f.store, user)).length, 1);
    } finally { await f.cleanup(); }
  });

  it('reregistersClaudeTool', async () => {
    const f = await fixture();
    try {
      const server = { type: 'stdio', command: NODE, args: [OLD_FORWARDER, '--store', f.store], env: {} };
      const config = join(f.home, '.claude.json');
      await put(config, JSON.stringify({ mcpServers: { slipstream: server },
        projects: { [f.roots[0]!]: { mcpServers: { slipstream: server } }, [f.roots[1]!]: { mcpServers: {} } } }));

      assert.equal(await runAdoptApp(f.deps), 0);

      const shim = [`${f.rt}/bin/slipstream-mcp`, '--store', f.store];
      assert.deepEqual(f.calls, [
        { command: 'claude', args: ['mcp', 'remove', '--scope', 'local', 'slipstream'], cwd: f.roots[0] },
        { command: 'claude', args: ['mcp', 'add', '--scope', 'local', 'slipstream', '--', ...shim], cwd: f.roots[0] },
        { command: 'claude', args: ['mcp', 'remove', '--scope', 'user', 'slipstream'], cwd: f.home },
        { command: 'claude', args: ['mcp', 'add', '--scope', 'user', 'slipstream', '--', ...shim], cwd: f.home },
      ]);
      const [backup] = await backups(f.store, config);
      assert.ok(f.lines.includes(`rewrote ${config} (backup ${backup})`), f.lines.join('\n'));
    } finally { await f.cleanup(); }
  });

  it('puts the old Claude entry back when the new one cannot be added', async () => {
    const f = await fixture();
    try {
      const config = join(f.home, '.claude.json');
      const old = [OLD_FORWARDER, '--store', f.store];
      await put(config, JSON.stringify({ mcpServers: { slipstream: { type: 'stdio', command: NODE, args: old } } }));
      f.deps.run = async (command, args, cwd) => {
        f.calls.push({ command, args, cwd });
        return args[1] === 'add' && args.includes(`${f.rt}/bin/slipstream-mcp`) ? { code: 1, output: 'boom' } : { code: 0, output: '' };
      };

      assert.equal(await runAdoptApp(f.deps), 1);

      assert.deepEqual(f.calls.at(-1), { command: 'claude', args: ['mcp', 'add', '--scope', 'user', 'slipstream', '--', NODE, ...old], cwd: f.home });
      const [backup] = await backups(f.store, config);
      assert.ok(f.lines.some((l) => l.startsWith(`failed ${config}: `) && l.includes('boom')
        && l.includes('the previous entry was put back') && l.includes(`backup ${backup}`)), f.lines.join('\n'));
    } finally { await f.cleanup(); }
  });

  it('leaves a symlinked worktree file alone', async () => {
    const f = await fixture();
    try {
      const shared = join(f.dir, 'shared', 'settings.local.json');
      const before = hooksFile(oldHook('claude-code', f.store));
      await put(shared, before);
      const link = join(f.roots[0]!, '.claude', 'settings.local.json');
      await mkdir(dirname(link), { recursive: true });
      await symlink(shared, link);

      assert.equal(await runAdoptApp(f.deps), 1);

      assert.equal(await readFile(shared, 'utf8'), before);
      assert.deepEqual(await backups(f.store, shared), []);
      assert.deepEqual(await backups(f.store, link), []);
      assert.ok(f.lines.some((l) => l.startsWith(`failed ${link}: `) && l.includes('symbolic link')), f.lines.join('\n'));
    } finally { await f.cleanup(); }
  });

  it('leaves old backups in a symlinked worktree directory alone', async () => {
    const f = await fixture();
    try {
      const path = join(f.roots[0]!, '.claude', 'settings.local.json');
      const shared = join(f.dir, 'shared-claude');
      const backup = join(shared, 'settings.local.json.slipstream-backup-1794438280389');
      await put(backup, 'before\n');
      await symlink(shared, dirname(path));

      assert.equal(await runAdoptApp(f.deps), 0);

      assert.equal(await readFile(backup, 'utf8'), 'before\n');
      assert.deepEqual(await backups(f.store, path), []);
    } finally { await f.cleanup(); }
  });

  it('idempotent', async () => {
    const f = await fixture();
    try {
      const config = join(f.home, '.claude.json');
      const server = (command: string, args: string[]) => ({ command, args });
      let claudeJson = { projects: { [f.roots[0]!]: { mcpServers: { slipstream: server(NODE, [OLD_FORWARDER, '--store', f.store]) } } } };
      await put(config, JSON.stringify(claudeJson));
      f.deps.run = async (_command, args) => {
        if (args[1] === 'add') {
          const [command, ...rest] = args.slice(args.indexOf('--') + 1);
          claudeJson = { projects: { [f.roots[0]!]: { mcpServers: { slipstream: server(command!, rest) } } } };
          await writeFile(config, JSON.stringify(claudeJson));
        }
        return { code: 0, output: '' };
      };
      const hook = join(f.roots[0]!, '.codex', 'hooks.json');
      const toml = join(f.roots[0]!, '.codex', 'config.toml');
      await put(hook, hooksFile(oldHook('codex', f.store)));
      await put(toml, `[mcp_servers.slipstream]\ncommand = "${NODE}"\nargs = ["${OLD_FORWARDER}", "--store", "${f.store}"]\n`);

      assert.equal(await runAdoptApp(f.deps), 0);
      f.lines.length = 0;
      assert.equal(await runAdoptApp(f.deps), 0);

      assert.deepEqual(f.lines.sort(), [`unchanged ${config}`, `unchanged ${toml}`, `unchanged ${hook}`].sort());
      for (const path of [config, hook, toml]) assert.equal((await backups(f.store, path)).length, 1, path);
    } finally { await f.cleanup(); }
  });

  it('moves backups an earlier run left in a worktree into the store', async () => {
    const f = await fixture();
    try {
      const claude = join(f.roots[0]!, '.claude', 'settings.local.json');
      const codex = join(f.roots[1]!, '.codex', 'config.toml');
      const unrelated = join(f.roots[0]!, '.claude', 'notes.slipstream-backup-1.txt');
      await put(`${claude}.slipstream-backup-1794438280389`, 'claude before\n');
      await put(`${codex}.slipstream-backup-1794438280390`, 'codex before\n');
      await put(unrelated, 'mine\n');

      assert.equal(await runAdoptApp(f.deps), 0);

      const moved = join(f.store, 'backups', `${claude}.slipstream-backup-1794438280389`);
      assert.equal(await readFile(moved, 'utf8'), 'claude before\n');
      assert.equal(await readFile(join(f.store, 'backups', `${codex}.slipstream-backup-1794438280390`), 'utf8'), 'codex before\n');
      assert.deepEqual(await besideBackups(claude), ['notes.slipstream-backup-1.txt']);
      assert.deepEqual(await besideBackups(codex), []);
      assert.ok(f.lines.includes(`moved ${claude}.slipstream-backup-1794438280389 to ${moved}`), f.lines.join('\n'));
    } finally { await f.cleanup(); }
  });

  it('finishes interrupted backup moves only when both copies match', async () => {
    const f = await fixture();
    try {
      const claude = join(f.roots[0]!, '.claude', 'settings.local.json');
      const codex = join(f.roots[1]!, '.codex', 'config.toml');
      const claudeBackup = `${claude}.slipstream-backup-1794438280389`;
      const codexBackup = `${codex}.slipstream-backup-1794438280390`;
      await put(claudeBackup, 'same\n');
      await put(codexBackup, 'source\n');
      await put(join(f.store, 'backups', claudeBackup), 'same\n');
      await put(join(f.store, 'backups', codexBackup), 'destination\n');

      assert.equal(await runAdoptApp(f.deps), 1);

      await assert.rejects(readFile(claudeBackup));
      assert.equal(await readFile(codexBackup, 'utf8'), 'source\n');
      assert.equal(await readFile(join(f.store, 'backups', codexBackup), 'utf8'), 'destination\n');
      assert.ok(f.lines.some((l) => l.startsWith(`failed ${codex}: `) && l.includes('different contents')), f.lines.join('\n'));
    } finally { await f.cleanup(); }
  });

  it('creates a fresh backup store owner-only', async () => {
    const f = await fixture();
    try {
      await rm(f.store, { recursive: true, force: true });
      const config = join(f.home, '.codex', 'config.toml');
      await put(config, `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(NODE)}\n`
        + `args = [${JSON.stringify(OLD_FORWARDER)}, "--store", ${JSON.stringify(f.store)}]\n`);

      assert.equal(await runAdoptApp(f.deps), 0);

      assert.equal((await stat(f.store)).mode & 0o777, 0o700);
      assert.equal((await stat(join(f.store, 'backups'))).mode & 0o777, 0o700);
    } finally { await f.cleanup(); }
  });

  it('reportsPerFileErrors', async () => {
    const f = await fixture();
    try {
      const locked = join(f.roots[0]!, '.claude', 'settings.local.json');
      const open = join(f.roots[1]!, '.claude', 'settings.local.json');
      await put(locked, hooksFile(oldHook('claude-code', f.store)));
      await put(open, hooksFile(oldHook('claude-code', f.store)));
      await chmod(locked, 0o000);

      assert.equal(await runAdoptApp(f.deps), 1);

      assert.ok(f.lines.some((l) => l.startsWith(`failed ${locked}: `)), f.lines.join('\n'));
      assert.ok(f.lines.some((l) => l.startsWith(`rewrote ${open} (backup `)), f.lines.join('\n'));
      await chmod(locked, 0o600);
    } finally { await f.cleanup(); }
  });

  it('refuses outside the Slipstream app', async () => {
    const f = await fixture();
    try {
      f.deps.env = {};
      assert.equal(await runAdoptApp(f.deps), 2);
      assert.deepEqual(f.lines, []);
      assert.match(f.errors.join('\n'), /SLIPSTREAM_APP_RUNTIME/);
    } finally { await f.cleanup(); }
  });
});
