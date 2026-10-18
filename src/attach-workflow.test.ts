import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, chmod, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAttachWorkflow, runWatchOnlyAttach, runIdentityAttach, type AttachDeps } from './attach-workflow.ts';
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

interface Daemon { live: boolean; legacy?: boolean; status?: Record<string, unknown>; attach?: Record<string, unknown> }

function deps(f: Fixture, env: Record<string, string>, daemon: Daemon): AttachDeps {
  return {
    env, home: f.home, nodePath: NODE, cliPath: f.cli,
    out: (line) => f.out.push(line),
    err: (line) => f.err.push(line),
    probe: async () => daemon.live ? 'live' : 'stale',
    startDaemon: () => { f.started += 1; daemon.live = true; return { exited: new Promise(() => {}) }; },
    control: async (req) => {
      f.requests.push(req);
      const fields = req.verb === 'status'
        ? { attach_features: daemon.legacy ? undefined : FEATURES, captures: [], binding_slots: { used: 0, limit: 10 },
          ...daemon.status }
        : daemon.attach ?? LINKED;
      return { v: 1, ok: true, ...fields } as ResponseEnvelope;
    },
    run: async (command, args) => { f.commands.push([command, ...args]); return { code: 0, output: '' }; },
    pollIntervalMs: 1,
  };
}

const FEATURES = ['agent-connection-v1', 'capture-table-v1'];
const LINKED = { session_id: 'cap-1', state: 'recording', binding_generation: '1', agent_connection: 'setup_pending',
  created: true };

function row(f: Fixture, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 'cap-1', root: f.worktree, state: 'recording', reason: null, capture_mode: 'watch-only',
    binding: null, ...fields };
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

  it('installs chat setup when a predicted slot refusal becomes a successful link', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const d = deps(f, claudeEnv, { live: true, status: { binding_slots: { used: 10, limit: 10 } } });
      assert.equal(await runAttachWorkflow({ dir: f.worktree, store: f.store }, d), 0);
      const settings = JSON.parse(await readFile(join(f.worktree, '.claude', 'settings.local.json'), 'utf8'));
      assert.equal(settings.hooks.PostToolUse.length, 1);
      assert.equal(f.commands.length, 1);
      assert.match(f.out.join('\n'), /claude --resume/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
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

  it('refuses a live daemon without setup-check support before changing config or attaching', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, {
        live: true, legacy: true, status: { state: 'detached' },
      }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /running daemon does not support chat setup checks/);
      assert.match(f.err.join('\n'), new RegExp(`slipstream stop --store ${f.store}`));
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.claude')));
      assert.deepEqual(f.commands, []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a daemon that runs only one capture at a time before changing anything', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const d = deps(f, claudeEnv, { live: true, status: { attach_features: ['agent-connection-v1'] } });
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /running daemon does not support/);
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.claude')));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('quotes a spaced store path in the legacy-daemon recovery instructions', async () => {
    const f = await fixture();
    try {
      f.store = join(f.root, 'store with spaces');
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, {
        live: true, legacy: true, status: { state: 'detached' },
      }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /slipstream stop --store '.*store with spaces'/);
      assert.match(f.err.join('\n'), /slipstream attach --store '.*store with spaces'/);
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
        status: { captures: [row(f, { binding: { harness: 'claude-code', harness_session_id: CLAUDE_ID,
          binding_generation: '1', state: 'connected' } })] },
        attach: { ...LINKED, already_active: true, agent_connection: 'connected' } }));
      assert.equal(code, 0);
      assert.equal((await stat(settingsPath)).mtimeMs, before.mtimeMs);
      assert.equal(await readFile(join(f.worktree, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);
      assert.deepEqual(f.commands, []);
      assert.match(f.out.join('\n'), /Attached successfully.*already/);
      assert.match(f.out.join('\n'), /agent_connection: connected$/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('links alongside the capture of another workspace', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        status: { captures: [row(f, { session_id: 'cap-0', root: '/elsewhere' })] } }));
      assert.equal(code, 0, f.err.join('\n'));
      assert.equal(attachRequests(f).length, 1);
      assert.match(f.out.join('\n'), /session_id: cap-1/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const [what, status, refusal] of [
    ['this chat is linked to another workspace', (f: Fixture) => ({ captures: [row(f, { root: '/elsewhere',
      binding: { harness: 'claude-code', harness_session_id: CLAUDE_ID, binding_generation: '1', state: 'connected' } })] }),
    { code: 'BINDING_EXISTS', message: 'claude-code chat x is already linked to the capture of /elsewhere' }],
    ['another chat is linked to this workspace', (f: Fixture) => ({ captures: [row(f, {
      binding: { harness: 'codex', harness_session_id: 'other', binding_generation: '1', state: 'connected' } })] }),
    { code: 'BINDING_EXISTS', message: 'codex chat other is already linked' }],
    ['this workspace waits for a capture slot', (f: Fixture) => ({ captures: [row(f, { state: 'not_recording',
      reason: 'capture-limit-reached' })] }),
    { code: 'CAPTURE_LIMIT_REACHED', message: '16/16 capture slots in use.' }],
    ['every chat slot is used', () => ({ binding_slots: { used: 10, limit: 10 } }),
    { code: 'BINDING_LIMIT_REACHED', message: '10/10 chats linked.' }],
  ] as const) {
    it(`installs nothing and reports the daemon's refusal when ${what}`, async () => {
      const f = await fixture();
      try {
        await claudeTranscript(f);
        const d = deps(f, claudeEnv, { live: true, status: status(f) });
        const control = d.control;
        d.control = async (req) => req.verb === 'attach'
          ? { v: 1, ok: false, ...refusal } as ResponseEnvelope : control(req);
        const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
        assert.equal(code, 1);
        assert.match(f.err.join('\n'), new RegExp(`${refusal.code}: ${refusal.message.replaceAll('.', '\\.')}`));
        await assert.rejects(stat(join(f.worktree, '.claude')));
        assert.deepEqual(f.commands, []);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it('waits for a starting capture past the control timeout, then links the chat', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      let now = 0;
      let polls = 0;
      const d = deps(f, claudeEnv, { live: true });
      d.now = () => now;
      d.sleep = async (ms) => { now += ms; };
      d.pollIntervalMs = 5_000;
      d.control = async (req) => {
        f.requests.push(req);
        if (req.verb === 'status' && req.target === undefined) {
          return { v: 1, ok: true, attach_features: FEATURES, captures: [], binding_slots: { used: 0, limit: 10 } };
        }
        if (req.verb === 'status') {
          polls += 1;
          return { v: 1, ok: true, capture: row(f, { state: polls < 5 ? 'baselining' : 'recording' }) };
        }
        return { v: 1, ok: true, ...(polls < 5 ? { session_id: 'cap-1', state: 'queued', reason: null, created: true }
          : LINKED) } as ResponseEnvelope;
      };
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 0, f.err.join('\n'));
      assert.ok(now > 15_000, 'outlived one control timeout');
      assert.equal(polls, 5);
      assert.equal(attachRequests(f).length, 2);
      assert.match(f.out.join('\n'), /agent_connection: setup_pending$/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('says the outcome is unknown, with a distinct exit, when the capture is still starting at the deadline', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      let now = 0;
      const d = deps(f, claudeEnv, { live: true });
      d.now = () => now;
      d.sleep = async (ms) => { now += ms; };
      d.pollIntervalMs = 5_000;
      const control = d.control;
      d.control = async (req) => req.verb === 'status' && req.target !== undefined
        ? { v: 1, ok: true, capture: row(f, { state: 'baselining' }) }
        : req.verb === 'attach' ? { v: 1, ok: true, session_id: 'cap-1', state: 'baselining', reason: null, created: false }
          : control(req);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, d);
      assert.equal(code, 3);
      assert.match(f.err.join('\n'), /still pending, outcome unknown \(session cap-1\)/);
      assert.doesNotMatch(f.out.join('\n'), /Recording|Attached/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses when the capture could not start', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        attach: { session_id: 'cap-1', state: 'not_recording', reason: 'resume-failed', message: 'log is corrupt' } }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /is not recording \(not_recording\): log is corrupt/);
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

  it('uses an identical user-scope Claude server without adding a duplicate local server', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      await mkdir(f.home, { recursive: true });
      await writeFile(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { slipstream: {
        command: NODE, args: [join(f.root, 'pkg', 'mcp-forwarder.js'), '--store', f.store],
      } } }));
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true }));
      assert.equal(code, 0, f.err.join('\n'));
      assert.deepEqual(f.commands, []);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a different user-scope Codex server before changing workspace config or attaching', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      await mkdir(join(f.home, '.codex'), { recursive: true });
      await writeFile(join(f.home, '.codex', 'config.toml'), '[mcp_servers.slipstream]\ncommand = "elsewhere"\n');
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /user-wide `slipstream` MCP server/);
      assert.equal(attachRequests(f).length, 0);
      await assert.rejects(stat(join(f.worktree, '.codex')));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('refuses a conflicting project Codex server even when the user-wide server matches', async () => {
    const f = await fixture();
    try {
      await codexTranscript(f);
      const args = [join(f.root, 'pkg', 'mcp-forwarder.js'), '--store', f.store];
      await mkdir(join(f.home, '.codex'), { recursive: true });
      await writeFile(join(f.home, '.codex', 'config.toml'), `[mcp_servers.slipstream]\ncommand = ${JSON.stringify(NODE)}\n`
        + `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`);
      await mkdir(join(f.worktree, '.codex'));
      const project = '[mcp_servers.slipstream]\ncommand = "elsewhere"\n';
      await writeFile(join(f.worktree, '.codex', 'config.toml'), project);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, codexEnv, { live: true }));
      assert.equal(code, 1);
      assert.match(f.err.join('\n'), /workspace `slipstream` MCP server/);
      assert.equal(await readFile(join(f.worktree, '.codex', 'config.toml'), 'utf8'), project);
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
        ? { v: 1, ok: true, attach_features: FEATURES, captures: [] } as ResponseEnvelope
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
      'mcp_servers.slipstream.command = "x"\n', '[[mcp_servers]]\nname = "x"\n',
      '["mcp_\\u0073ervers".slipstream]\ncommand = "x"\n']) {
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

  it('does not report pending when the daemon says the chat is disconnected', async () => {
    const f = await fixture();
    try {
      await claudeTranscript(f);
      const code = await runAttachWorkflow({ dir: f.worktree, store: f.store }, deps(f, claudeEnv, { live: true,
        attach: { ...LINKED, already_active: true, agent_connection: 'disconnected' } }));
      assert.equal(code, 1);
      assert.doesNotMatch(f.out.join('\n'), /setup pending|Attached successfully/);
      assert.match(f.err.join('\n'), /reported this chat as disconnected; it is not connected/);
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

describe('slipstream attach --watch-only', () => {
  const run = async (replies: Record<string, unknown>[], wait: boolean, clock?: { now: number }) => {
    const out: string[] = []; const err: string[] = []; const requests: Record<string, unknown>[] = [];
    const code = await runWatchOnlyAttach({ dir: '/w', wait }, {
      out: (l) => out.push(l), err: (l) => err.push(l),
      control: async (req) => { requests.push(req); return { v: 1, ...replies.shift()! } as ResponseEnvelope; },
      ...(clock ? { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; } } : {}),
      pollIntervalMs: 5_000,
    });
    return { code, out: out.join('\n'), err: err.join('\n'), requests };
  };

  it('records a workspace without a chat', async () => {
    const r = await run([{ ok: true, session_id: 's1', state: 'recording', reason: null, created: true }], false);
    assert.equal(r.code, 0);
    assert.deepEqual(r.requests, [{ verb: 'attach', mode: 'watch-only', worktree: '/w' }]);
    assert.match(r.out, /Recording \/w; this command linked no chat\.\nsession_id: s1\nstate: recording/);
  });

  it('reports a starting capture honestly without --wait', async () => {
    const r = await run([{ ok: true, session_id: 's1', state: 'baselining', reason: null, created: true }], false);
    assert.equal(r.code, 0);
    assert.match(r.out, /is starting \(baselining\); it is not recording yet/);
    assert.equal(r.requests.length, 1);
  });

  it('with --wait, polls with short status requests past the control timeout until recording', async () => {
    const clock = { now: 0 };
    const starting = { ok: true, capture: { session_id: 's1', state: 'baselining' } };
    const r = await run([{ ok: true, session_id: 's1', state: 'queued', reason: null, created: true },
      starting, starting, starting, starting, { ok: true, capture: { session_id: 's1', state: 'recording' } }], true, clock);
    assert.equal(r.code, 0, r.err);
    assert.ok(clock.now > 15_000);
    assert.deepEqual(r.requests.slice(1).map((q) => q.target), ['s1', 's1', 's1', 's1', 's1']);
    assert.match(r.out, /state: recording/);
  });

  it('with --wait, says the outcome is unknown at its own deadline', async () => {
    const clock = { now: 0 };
    const replies = [{ ok: true, session_id: 's1', state: 'baselining', reason: null, created: true },
      ...Array.from({ length: 50 }, () => ({ ok: true, capture: { session_id: 's1', state: 'baselining' } }))];
    const r = await run(replies, true, clock);
    assert.equal(r.code, 3);
    assert.match(r.err, /still pending, outcome unknown/);
  });

  it('exits non-zero with the exact capture-limit text when every slot is used', async () => {
    const text = '16/16 capture slots in use. This workspace is NOT recording. It starts automatically when another '
      + 'workspace is archived or detached.';
    const r = await run([{ ok: false, code: 'CAPTURE_LIMIT_REACHED', message: text }], true);
    assert.equal(r.code, 1);
    assert.equal(r.err, `slipstream: CAPTURE_LIMIT_REACHED: ${text}`);
  });
});

describe('slipstream attach with identity flags', () => {
  const request = { verb: 'attach' as const, worktree: '/w', harness: 'codex', harness_session_id: 'c1', root_transcript: '/t.jsonl' };
  const run = async (replies: Record<string, unknown>[], clock = { now: 0 }) => {
    const err: string[] = []; const reported: Record<string, unknown>[] = []; const requests: Record<string, unknown>[] = [];
    const code = await runIdentityAttach(request, {
      out: () => {}, err: (l) => err.push(l), report: (res) => reported.push(res),
      control: async (req) => { requests.push(req); return { v: 1, ...replies.shift()! } as ResponseEnvelope; },
      now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; }, pollIntervalMs: 5_000,
    });
    return { code, err: err.join('\n'), reported, requests };
  };

  it('links the chat once a starting capture records', async () => {
    const r = await run([{ ok: true, session_id: 's1', state: 'queued', reason: null, created: true },
      { ok: true, capture: { session_id: 's1', state: 'recording' } },
      { ok: true, session_id: 's1', state: 'recording', binding_generation: '1', agent_connection: 'setup_pending' }]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.requests.map((q) => q.verb), ['attach', 'status', 'attach']);
    assert.equal(r.reported[0]!.binding_generation, '1');
  });

  it('says the outcome is unknown when the capture is still starting at its deadline', async () => {
    const r = await run([{ ok: true, session_id: 's1', state: 'baselining', reason: null, created: true },
      ...Array.from({ length: 50 }, () => ({ ok: true, capture: { session_id: 's1', state: 'baselining' } }))]);
    assert.equal(r.code, 3);
    assert.match(r.err, /still pending, outcome unknown/);
    assert.equal(r.reported.length, 0);
  });
});
