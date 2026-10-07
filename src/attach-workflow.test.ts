import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, chmod, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAttachWorkflow, type AttachDeps } from './attach-workflow.ts';
import { defaultDaemonStore } from './daemon-location.ts';
import type { ResponseEnvelope } from './control-protocol.ts';

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CODEX_ID = '019a0000-0000-7000-8000-000000000001';
const NODE = '/opt/node/bin/node';

interface Fixture {
  root: string; home: string; worktree: string; store: string; cli: string;
  out: string[]; err: string[]; requests: Record<string, unknown>[]; commands: string[][];
  started: number;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ss-attach-')));
  const worktree = join(root, 'work');
  await mkdir(worktree);
  execFileSync('git', ['init', '-q', worktree]);
  const cli = join(root, 'pkg', 'cli.js');
  await mkdir(join(root, 'pkg'));
  await writeFile(cli, '');
  await writeFile(join(root, 'pkg', 'mcp-forwarder.js'), '');
  return { root, home: join(root, 'home'), worktree, store: join(root, 'store'), cli,
    out: [], err: [], requests: [], commands: [], started: 0 };
}

async function claudeTranscript(f: Fixture, version = '2.1.283', entrypoint = 'sdk-cli'): Promise<string> {
  const dir = join(f.home, '.claude', 'projects', '-work');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${CLAUDE_ID}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: f.worktree, version, entrypoint,
    userType: 'external', isSidechain: false, message: { role: 'user', content: 'hi' } })}\n`);
  return path;
}

async function codexTranscript(f: Fixture, version = '0.155.1'): Promise<string> {
  const dir = join(f.home, '.codex', 'sessions', '2026', '10', '07');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-07T10-00-00-${CODEX_ID}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { id: CODEX_ID, session_id: CODEX_ID,
    cwd: f.worktree, originator: 'codex_sdk_ts', source: 'exec', cli_version: version } })}\n`);
  return path;
}

interface Daemon { live: boolean; status?: Record<string, unknown>; attach?: Record<string, unknown> }

function deps(f: Fixture, env: Record<string, string>, daemon: Daemon): AttachDeps {
  return {
    env, home: f.home, nodePath: NODE, cliPath: f.cli,
    out: (line) => f.out.push(line),
    err: (line) => f.err.push(line),
    probe: async () => daemon.live ? 'live' : 'stale',
    startDaemon: () => { f.started += 1; daemon.live = true; return { exited: new Promise(() => {}) }; },
    control: async (req) => {
      f.requests.push(req);
      const fields = req.verb === 'status' ? daemon.status ?? { state: 'detached' }
        : daemon.attach ?? { session_id: 'cap-1', agent_connection: 'setup_pending' };
      return { v: 1, ok: true, ...fields } as ResponseEnvelope;
    },
    run: async (command, args) => { f.commands.push([command, ...args]); return { code: 0, output: '' }; },
    pollIntervalMs: 1,
  };
}

const claudeEnv = { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CLAUDE_CODE_EXECPATH: '/opt/claude' };
const codexEnv = { CODEX_THREAD_ID: CODEX_ID };

function attachRequests(f: Fixture): Record<string, unknown>[] {
  return f.requests.filter((r) => r.verb === 'attach');
}

describe('slipstream attach (one command)', () => {
  it('refuses without capture when no agent chat or two agent chats are detected', async () => {
    for (const env of [{}, { ...claudeEnv, ...codexEnv }] as Record<string, string>[]) {
      const f = await fixture();
      try {
        const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, env, { live: true }));
        assert.equal(code, 1);
        assert.equal(f.requests.length, 0);
        assert.equal(f.started, 0);
        assert.match(f.err.join('\n'), env.CODEX_THREAD_ID ? /both a Claude Code and a Codex chat/ : /no Claude Code or Codex chat/);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  it('starts the daemon, installs the Claude hook and tool, and reports setup pending with the exact step', async () => {
    const f = await fixture();
    try {
      const transcript = await claudeTranscript(f);
      await mkdir(join(f.worktree, '.claude'));
      const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
      await writeFile(join(f.worktree, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [unrelated] } }));
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: false }));
      assert.equal(code, 0, f.err.join('\n'));
      assert.equal(f.started, 1);
      const settings = JSON.parse(await readFile(join(f.worktree, '.claude', 'settings.local.json'), 'utf8'));
      assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
      assert.deepEqual(settings.hooks.PostToolUse, [unrelated, { matcher: '*', hooks: [{ type: 'command',
        command: `${NODE} ${f.cli} hook claude-code post-tool-use --store ${f.store}`, timeout: 3 }] }]);
      assert.deepEqual(f.commands, [['/opt/claude', 'mcp', 'add', '--scope', 'local', 'slipstream', '--',
        NODE, join(f.root, 'pkg', 'mcp-forwarder.js'), '--store', f.store]]);
      assert.deepEqual(attachRequests(f), [{ verb: 'attach', worktree: f.worktree, harness: 'claude-code',
        harness_session_id: CLAUDE_ID, root_transcript: transcript }]);
      const out = f.out.join('\n');
      assert.match(out, /agent setup pending/);
      assert.match(out, new RegExp(`claude --resume ${CLAUDE_ID}`));
      assert.doesNotMatch(out, /Attached successfully/);
      assert.match(out, /session_id: cap-1\nagent_connection: setup_pending$/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('repeats without changing config or capture and says so', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const settingsPath = join(f.worktree, '.claude', 'settings.local.json');
      await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      await mkdir(join(f.home), { recursive: true });
      await writeFile(join(f.home, '.claude.json'), JSON.stringify({ projects: { [f.worktree]: { mcpServers: {
        slipstream: { type: 'stdio', command: NODE, args: [join(f.root, 'pkg', 'mcp-forwarder.js'), '--store', f.store], env: {} },
      } } } }));
      const before = await stat(settingsPath);
      const excludeBefore = await readFile(join(f.worktree, '.git', 'info', 'exclude'), 'utf8');
      f.out.length = 0; f.commands.length = 0;
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        status: { state: 'active', worktree: f.worktree, harness: 'claude-code', harness_session_id: CLAUDE_ID },
        attach: { session_id: 'cap-1', already_active: true, agent_connection: 'connected' } }));
      assert.equal(code, 0);
      assert.equal((await stat(settingsPath)).mtimeMs, before.mtimeMs);
      assert.equal(await readFile(join(f.worktree, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);
      assert.deepEqual(f.commands, []);
      assert.match(f.out.join('\n'), /Attached successfully.*already/);
      assert.match(f.out.join('\n'), /agent_connection: connected$/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses before any write when another workspace is being recorded', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        status: { state: 'active', worktree: '/elsewhere', harness: 'codex', harness_session_id: 'x' } }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /\/elsewhere is being recorded/);
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.claude')));
      assert.deepEqual(f.commands, []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses an unverified runtime honestly, with nothing installed or recorded', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f, '9.9.9');
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /not a runtime Slipstream has verified/);
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.claude')));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses when the chat transcript cannot be found', async () => {
    const f = await fixture();
    try {
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /could not find this chat's transcript/);
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses invalid existing settings without touching them', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      await mkdir(join(f.worktree, '.claude'));
      await writeFile(join(f.worktree, '.claude', 'settings.local.json'), '{ nope');
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /settings\.local\.json is not valid JSON/);
      assert.equal(await readFile(join(f.worktree, '.claude', 'settings.local.json'), 'utf8'), '{ nope');
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a Slipstream hook that points at another store instead of replacing it', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      await mkdir(join(f.worktree, '.claude'));
      const other = { hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command',
        command: `${NODE} ${f.cli} hook claude-code post-tool-use --store /other`, timeout: 3 }] }] } };
      await writeFile(join(f.worktree, '.claude', 'settings.local.json'), JSON.stringify(other));
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /already has a different Slipstream hook/);
      assert.deepEqual(JSON.parse(await readFile(join(f.worktree, '.claude', 'settings.local.json'), 'utf8')), other);
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('installs the Codex hook and tool alongside existing Codex config, once', async () => {
    const f = await fixture();
    try {
      const transcript = await codexTranscript(f);
      await mkdir(join(f.worktree, '.codex'));
      await writeFile(join(f.worktree, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n');
      for (let i = 0; i < 2; i++) {
        const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
        assert.equal(code, 0, f.err.join('\n'));
      }
      const hooks = JSON.parse(await readFile(join(f.worktree, '.codex', 'hooks.json'), 'utf8'));
      assert.deepEqual(hooks, { hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command',
        command: `${NODE} ${f.cli} hook codex post-tool-use --store ${f.store}`, timeout: 3 }] }] } });
      assert.equal(await readFile(join(f.worktree, '.codex', 'config.toml'), 'utf8'),
        'model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n\n[mcp_servers.slipstream]\n'
        + `command = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(join(f.root, 'pkg', 'mcp-forwarder.js'))}, "--store", ${JSON.stringify(f.store)}]\n`);
      assert.deepEqual(attachRequests(f)[0], { verb: 'attach', worktree: f.worktree, harness: 'codex',
        harness_session_id: CODEX_ID, root_transcript: transcript });
      assert.match(f.out.join('\n'), new RegExp(`codex resume ${CODEX_ID}`));
      assert.deepEqual(f.commands, []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a different Codex Slipstream server entry instead of replacing it', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      await mkdir(join(f.worktree, '.codex'));
      const toml = '[mcp_servers.slipstream]\ncommand = "slipstream-mcp"\n';
      await writeFile(join(f.worktree, '.codex', 'config.toml'), toml);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /already has a different Slipstream server/);
      assert.equal(await readFile(join(f.worktree, '.codex', 'config.toml'), 'utf8'), toml);
      await assert.rejects(stat(join(f.worktree, '.codex', 'hooks.json')));
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('explains a daemon that does not come up instead of attaching', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const d = deps(f, claudeEnv, { live: false });
      d.startDaemon = () => ({ exited: Promise.resolve(1) });
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), new RegExp(`slipstream start --store ${f.store}`));
      assert.equal(f.requests.length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('reports a daemon refusal of the attach and exits non-zero', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const d = deps(f, claudeEnv, { live: true });
      d.control = async (req) => req.verb === 'status'
        ? { v: 1, ok: true, state: 'detached' } as ResponseEnvelope
        : { v: 1, ok: false, code: 'STORAGE_UNAVAILABLE', message: 'disk full' } as ResponseEnvelope;
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /STORAGE_UNAVAILABLE: disk full/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('names launch mode, not only the directory, when the transcript does not match', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f, '2.1.283', 'cli');
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /launched in a way Slipstream has not verified \(such as an interactive `claude`/);
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('repeats a non-default store in the printed next step, and omits the default one', async () => {
    for (const isDefault of [false, true]) {
      const f = await fixture();
      try {
        await claudeTranscript(f);
        const store = isDefault ? defaultDaemonStore(f.home) : f.store;
        await runAttachWorkflow({ dir: f.worktree, store }, deps(f, claudeEnv, { live: true }));
        assert.match(f.out.join('\n'), isDefault ? /run `slipstream attach` again there/
          : new RegExp(`run \`slipstream attach --store ${f.store}\` again there`));
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  it('refuses with an explanation when the chat cannot write the workspace config', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      await mkdir(join(f.worktree, '.codex'));
      await chmod(join(f.worktree, '.codex'), 0o500);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /could not write .*\.codex\/hooks\.json \(EACCES\).*sandbox.*Nothing was recorded/s);
      assert.equal(attachRequests(f).length, 0);
    } finally {
      await chmod(join(f.worktree, '.codex'), 0o700);
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('tells a Codex chat to trust the Slipstream hook through Codex itself', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.match(f.out.join('\n'), /trust the Slipstream hook when Codex shows its hook review/);
      f.out.length = 0;
      await runAttachWorkflow({ dir: f.worktree, store: f.store },
        deps(f, { ...codexEnv, CONDUCTOR_SESSION_ID: 'c-1' }, { live: true }));
      assert.match(f.out.join('\n'),
        new RegExp(`run \`codex\` in ${f.worktree}, trust the Slipstream hook in its hook review`));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('refuses Codex config that declares the Slipstream server in another TOML form, unchanged', async () => {
    for (const toml of ['[ mcp_servers . slipstream ]\ncommand = "x"\n', '["mcp_servers"."slipstream"]\ncommand = "x"\n',
      'mcp_servers.slipstream.command = "x"\n', '[[mcp_servers]]\nname = "x"\n']) {
      const f = await fixture();
      try {
        await codexTranscript(f);
        await mkdir(join(f.worktree, '.codex'));
        await writeFile(join(f.worktree, '.codex', 'config.toml'), toml);
        const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
        assert.equal(code, 1, toml);
        assert.match(f.err.join('\n'), /declares MCP servers in a form attach cannot safely edit/);
        assert.equal(await readFile(join(f.worktree, '.codex', 'config.toml'), 'utf8'), toml);
        assert.equal(attachRequests(f).length, 0);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  it('refuses instead of overwriting config that changed while attach was running', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const settings = join(f.worktree, '.claude', 'settings.local.json');
      const d = deps(f, claudeEnv, { live: false });
      const start = d.startDaemon;
      d.startDaemon = () => {
        execFileSync('mkdir', ['-p', join(f.worktree, '.claude')]);
        execFileSync('sh', ['-c', `printf '{"permissions":{}}' > '${settings}'`]);
        return start();
      };
      d.probe = async () => f.started > 0 ? 'live' : 'stale';
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /changed while attach was running/);
      assert.equal(await readFile(settings, 'utf8'), '{"permissions":{}}');
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a same-chat capture that was attached without question delivery', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        status: { state: 'active', worktree: f.worktree, harness: 'claude-code', harness_session_id: CLAUDE_ID,
          agent_connection: 'disconnected' } }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /without question delivery.*slipstream detach/s);
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.claude')));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('does not report pending when the daemon says the chat is disconnected', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        attach: { session_id: 'cap-1', already_active: true, agent_connection: 'disconnected' } }));
      assert.equal(code, 1);
      assert.doesNotMatch(f.out.join('\n'), /setup pending|Attached successfully/);
      assert.match(f.err.join('\n'), /without question delivery/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('keeps the permissions of a config file it edits', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      await mkdir(join(f.worktree, '.codex'));
      const toml = join(f.worktree, '.codex', 'config.toml');
      await writeFile(toml, 'model = "x"\n', { mode: 0o600 });
      await chmod(toml, 0o600);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.equal(code, 0, f.err.join('\n'));
      assert.equal((await stat(toml)).mode & 0o777, 0o600);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses to edit config reached through a symbolic link', async () => {
    for (const link of ['dir', 'file'] as const) {
      const f = await fixture();
      try {
        await codexTranscript(f);
        const shared = join(f.root, 'shared');
        await mkdir(shared);
        await writeFile(join(shared, 'config.toml'), 'model = "x"\n');
        if (link === 'dir') await symlink(shared, join(f.worktree, '.codex'));
        else {
          await mkdir(join(f.worktree, '.codex'));
          await symlink(join(shared, 'config.toml'), join(f.worktree, '.codex', 'config.toml'));
        }
        const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
        assert.equal(code, 1, link);
        assert.match(f.err.join('\n'), /symbolic link/);
        assert.equal(await readFile(join(shared, 'config.toml'), 'utf8'), 'model = "x"\n');
        await assert.rejects(stat(join(shared, 'hooks.json')));
        assert.equal(attachRequests(f).length, 0);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  });

  it('refuses a Slipstream hook that only runs for some tools instead of treating it as installed', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      await mkdir(join(f.worktree, '.claude'));
      const narrow = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: `${NODE} ${f.cli} hook claude-code post-tool-use --store ${f.store}`, timeout: 3 }] }] } };
      await writeFile(join(f.worktree, '.claude', 'settings.local.json'), JSON.stringify(narrow));
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /already has a different Slipstream hook/);
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a malformed existing Claude answer-tool entry without crashing', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      await mkdir(f.home, { recursive: true });
      await writeFile(join(f.home, '.claude.json'),
        JSON.stringify({ projects: { [f.worktree]: { mcpServers: { slipstream: null } } } }));
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /different `slipstream` MCP server/);
      assert.equal(attachRequests(f).length, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
