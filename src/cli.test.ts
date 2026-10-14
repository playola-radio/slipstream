import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, retryGuidance } from './cli.ts';

const ASK_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASK_REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('cli ask', () => {
  it('parses an explicit Codex hook store and root transcript attachment', () => {
    assert.deepEqual(parseArgs(['hook', 'codex', 'post-tool-use', '--store', '/s']),
      { command: 'codex-hook', store: '/s' });
    assert.deepEqual(parseArgs(['attach', '/work', '--store', '/s', '--harness', 'codex',
      '--harness-session-id', 'root', '--root-transcript', '/transcript.jsonl']),
      { command: 'attach', dir: '/work', store: '/s', harness: 'codex',
        harnessSessionId: 'root', rootTranscript: '/transcript.jsonl' });
  });
  it('parses the Claude hook and exits silently on invalid callback input', async () => {
    assert.deepEqual(parseArgs(['hook', 'claude-code', 'post-tool-use', '--store', '/s']),
      { command: 'claude-hook', store: '/s' });
    const { execFile } = await import('node:child_process');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = execFile(process.execPath, ['src/cli.ts', 'hook', 'claude-code', 'post-tool-use', '--store', '/missing'],
        { timeout: 5000 }, (error, stdout, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr }));
      child.stdin?.end('{invalid');
    });
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  });
  it('parses the required store, capture session, request id, and input flags', () => {
    assert.deepEqual(parseArgs([
      'ask', '--store', '/s', '--session', ASK_SESSION,
      '--request-id', ASK_REQUEST, '--input', '/question.json',
    ]), {
      command: 'ask', store: '/s', sessionId: ASK_SESSION,
      requestId: ASK_REQUEST, inputPath: '/question.json',
    });
  });

  it('rejects missing, duplicate, and non-canonical ask identity flags', () => {
    assert.equal(parseArgs(['ask', '--store', '/s', '--session', ASK_SESSION, '--request-id', ASK_REQUEST]), null);
    assert.equal(parseArgs(['ask', '--store', '/s', '--session', ASK_SESSION.toUpperCase(), '--request-id', ASK_REQUEST, '--input', '/q']), null);
    assert.equal(parseArgs(['ask', '--store', '/s', '--session', ASK_SESSION, '--request-id', ASK_REQUEST.toUpperCase(), '--input', '/q']), null);
    assert.equal(parseArgs(['ask', '--store', '/s', '--store', '/other', '--session', ASK_SESSION, '--request-id', ASK_REQUEST, '--input', '/q']), null);
  });

  it('sends file input and prints only the structured acknowledgment', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:net');
    const { execFile } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-ask-'));
    const store = join(dir, 'store'); const input = join(dir, 'question.json');
    await mkdir(store, { mode: 0o700 });
    await writeFile(input, JSON.stringify({
      text: 'What changed?',
      context: {
        change_seq: '9007199254740993', path: 'src/example.ts',
        snapshot_sha256: 'a'.repeat(64), line_start: 2, line_end: 4,
      },
      reply_to_question_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }));
    let received: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      let text = '';
      socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
      socket.on('end', () => undefined);
      socket.once('data', () => {
        received = JSON.parse(text) as Record<string, unknown>;
        socket.end(JSON.stringify({
          v: 1, ok: true, session_id: ASK_SESSION, request_id: ASK_REQUEST,
          question_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', seq: '7',
          queued_at_ms: 10, expires_at_ms: 1_800_010, duplicate: false,
        }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, ['src/cli.ts', 'ask', '--store', store, '--session', ASK_SESSION,
          '--request-id', ASK_REQUEST, '--input', input], { timeout: 5000 }, (error, stdout, stderr) =>
          resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr }));
      });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        v: 1, ok: true, session_id: ASK_SESSION, request_id: ASK_REQUEST,
        question_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', seq: '7',
        queued_at_ms: 10, expires_at_ms: 1_800_010, duplicate: false,
      });
      assert.equal(result.stderr, '');
      assert.deepEqual(received, {
        v: 1, verb: 'ask', session_id: ASK_SESSION, request_id: ASK_REQUEST,
        text: 'What changed?',
        context: {
          change_seq: '9007199254740993', path: 'src/example.ts',
          snapshot_sha256: 'a'.repeat(64), line_start: 2, line_end: 4,
        },
        reply_to_question_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSON, non-objects, non-regular files, and oversized input locally', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { MAX_MESSAGE_BYTES } = await import('./control-protocol.ts');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-ask-bad-'));
    const input = join(dir, 'question.json');
    try {
      for (const item of [
        { path: input, body: '{not JSON' },
        { path: input, body: '[]' },
        { path: input, body: ' '.repeat(MAX_MESSAGE_BYTES + 1) },
        { path: '/dev/zero' },
        { path: dir },
      ]) {
        if (item.body !== undefined) await writeFile(input, item.body);
        const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>((resolve) => {
          execFile(process.execPath, ['src/cli.ts', 'ask', '--store', join(dir, 'store'), '--session', ASK_SESSION,
            '--request-id', ASK_REQUEST, '--input', item.path], { timeout: 5000 }, (error, stdout, stderr) =>
            resolve({ code: error?.code ?? 0, stdout, stderr }));
        });
        assert.equal(result.code, 2);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /input/i);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('allows an ask request exactly at the routed control line cap and rejects one byte over before connecting', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:net');
    const { execFile } = await import('node:child_process');
    const { MAX_MESSAGE_BYTES } = await import('./control-protocol.ts');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-ask-envelope-'));
    const store = join(dir, 'store');
    const input = join(dir, 'question.json');
    const context = { change_seq: '1', path: 'x.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1 };
    const envelope = { v: 1, verb: 'ask', session_id: ASK_SESSION, request_id: ASK_REQUEST, text: '', context };
    const textLength = MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(envelope));
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.once('data', () => socket.end(JSON.stringify({
        v: 1, ok: true, session_id: ASK_SESSION, request_id: ASK_REQUEST,
        question_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', seq: '7',
        queued_at_ms: 10, expires_at_ms: 1_800_010, duplicate: false,
      }) + '\n'));
    });
    await mkdir(store, { mode: 0o700 });
    await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
    try {
      const cases: Array<[number, number]> = [[textLength, 0], [textLength + 1, 2]];
      for (const [length, expectedCode] of cases) {
        await writeFile(input, JSON.stringify({ text: 'x'.repeat(length), context }));
        const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>((resolve) => {
          execFile(process.execPath, ['src/cli.ts', 'ask', '--store', store, '--session', ASK_SESSION,
            '--request-id', ASK_REQUEST, '--input', input], { timeout: 5000 }, (error, stdout, stderr) =>
            resolve({ code: error?.code ?? 0, stdout, stderr }));
        });
        assert.equal(result.code, expectedCode);
        if (expectedCode === 0) assert.equal(JSON.parse(result.stdout).ok, true);
        else {
          assert.equal(result.stdout, '');
          assert.match(result.stderr, /control message byte cap/i);
        }
      }
      assert.equal(connections, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves semantic admission to the daemon and makes storage uncertainty retry-safe', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:net');
    const { execFile } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-ask-error-'));
    const store = join(dir, 's'); const input = join(dir, 'question.json');
    await mkdir(store, { mode: 0o700 });
    const body = { text: 'Question', context: { change_seq: 'bad' }, target: 'spoof', session_id: 'spoof' };
    await writeFile(input, JSON.stringify(body));
    try {
      for (const code of ['INVALID_CONTEXT', 'STORAGE_UNAVAILABLE']) {
        let received: unknown;
        const server = createServer((socket) => socket.once('data', (chunk) => {
          received = JSON.parse(chunk.toString());
          socket.end(JSON.stringify({ v: 1, ok: false, code, message: 'fixture failure' }) + '\n');
        }));
        await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
        try {
          const result = await new Promise<{ code: unknown; stdout: string; stderr: string }>((resolve) => {
            execFile(process.execPath, ['src/cli.ts', 'ask', '--store', store, '--session', ASK_SESSION,
              '--request-id', ASK_REQUEST, '--input', input], { timeout: 5000 }, (error, stdout, stderr) =>
              resolve({ code: error?.code ?? 0, stdout, stderr }));
          });
          assert.equal(result.code, code === 'STORAGE_UNAVAILABLE' ? 3 : 1);
          assert.equal(result.stdout, '');
          const reply = JSON.parse(result.stderr);
          assert.equal(reply.code, code);
          assert.equal(reply.ok, false);
          assert.match(reply.message, /fixture failure/);
          if (code === 'STORAGE_UNAVAILABLE') {
            assert.match(reply.message, /outcome unknown/);
            assert.match(reply.message, /same --request-id, --session, and input body/i);
          }
          assert.deepEqual(received, { v: 1, verb: 'ask', session_id: ASK_SESSION,
            request_id: ASK_REQUEST, text: body.text, context: body.context });
        } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('treats malformed durable identity and timestamps in an acknowledgment as outcome unknown', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:net');
    const { execFile } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-ask-invalid-ack-'));
    const store = join(dir, 's');
    const input = join(dir, 'question.json');
    await mkdir(store, { mode: 0o700 });
    await writeFile(input, JSON.stringify({ text: 'Question', context: {
      change_seq: '1', path: 'x.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
    } }));
    const good = {
      v: 1, ok: true, session_id: ASK_SESSION, request_id: ASK_REQUEST,
      question_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', seq: '7',
      queued_at_ms: 10, expires_at_ms: 1_800_010, duplicate: false,
    };
    const invalid = [
      { v: 1, ok: true, seq: '1' },
      { ...good, question_id: '' },
      { ...good, seq: '07' },
      { ...good, queued_at_ms: -1 },
      { ...good, queued_at_ms: 10.5 },
      { ...good, expires_at_ms: 1_800_009 },
    ];
    try {
      for (const reply of invalid) {
        const server = createServer((socket) => socket.once('data', () => socket.end(JSON.stringify(reply) + '\n')));
        await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
        try {
          const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
            execFile(process.execPath, ['src/cli.ts', 'ask', '--store', store, '--session', ASK_SESSION,
              '--request-id', ASK_REQUEST, '--input', input], { timeout: 5000 }, (error, _stdout, stderr) =>
              resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stderr }));
          });
          assert.equal(result.code, 3);
          assert.match(result.stderr, /outcome unknown/i);
          assert.match(result.stderr, /same --request-id, --session, and input body/i);
          assert.match(result.stderr, /do not retarget an old capture/i);
        } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('cli', () => {
  describe('parseArgs', () => {
    it('rejects --store without a following value', () => {
      assert.equal(parseArgs(['watch', '--store']), null);
    });

    it('parses watch with dir and store', () => {
      assert.deepEqual(parseArgs(['watch', '/w', '--store', '/s']),
        { command: 'watch', dir: '/w', store: '/s' });
    });
  });
});

describe('cli parseArgs (reader commands)', () => {
  it('parses serve with a store override', () => {
    assert.deepEqual(parseArgs(['serve', '/w', '--store', '/s']),
      { command: 'serve', dir: '/w', store: '/s' });
  });
  it('parses view passing through remaining args', () => {
    const parsed = parseArgs(['view', '--store', '/s', '--session', 'abc', '--disk']);
    assert.equal(parsed?.command, 'view');
  });
});

it('serve releases the capture lock when reader descriptor publication fails', async () => {
  const { mkdtemp, mkdir, writeFile, readdir, access, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'slip-cli-fail-'));
  const root = join(dir, 'work'); const store = join(dir, 'store');
  await mkdir(root); await mkdir(store, { mode: 0o700 });
  await writeFile(join(store, 'runtime'), 'blocks descriptor directory');
  try {
    const result = await new Promise<{ error: Error | null; stderr: string }>(resolve => {
      execFile(process.execPath, ['src/cli.ts', 'serve', root, '--store', store],
        { timeout: 5000 }, (error, _stdout, stderr) => resolve({ error, stderr }));
    });
    assert.ok(result.error);
    assert.match(result.stderr, /EEXIST|ENOTDIR/);
    const ids = await readdir(join(store, 'sessions'));
    assert.equal(ids.length, 1, 'capture actually started');
    await assert.rejects(access(join(store, 'sessions', ids[0]!, 'owner.lock')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

describe('cli attach (one command)', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const cleanEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...extra };
    return env;
  };
  const run = async (args: string[], env: NodeJS.ProcessEnv) => {
    const { execFile } = await import('node:child_process');
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, ['src/cli.ts', ...args], { env, timeout: 20_000 }, (error, stdout, stderr) =>
        done({ code: error ? Number(error.code) : 0, stdout, stderr }));
    });
  };

  it('refuses outside an agent chat without starting a daemon', async () => {
    const { mkdtemp, mkdir, access, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'slip-cli-attach-'));
    try {
      await mkdir(join(dir, 'work'));
      const result = await run(['attach', join(dir, 'work'), '--store', join(dir, 'store')], cleanEnv({ HOME: dir }));
      assert.equal(result.code, 1);
      assert.match(result.stderr, /no Claude Code or Codex chat detected/);
      await assert.rejects(access(join(dir, 'store')), { code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('starts a stopped daemon, records once, and reuses the capture on a repeat', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'slip-cli-attach-')));
    const work = join(dir, 'work'); const store = join(dir, 'store'); const config = join(dir, 'claude');
    let pid: number | undefined;
    try {
      await mkdir(work);
      await mkdir(join(config, 'projects', 'p'), { recursive: true });
      await writeFile(join(config, 'projects', 'p', `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user',
        sessionId, cwd: work, version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false })}\n`);
      const fakeClaude = join(dir, 'claude-bin');
      // Stands in for `claude mcp add --scope local`: record the call and the local server entry.
      await writeFile(fakeClaude, `#!${process.execPath}\nconst fs = require('node:fs');\n`
        + `const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(join(dir, 'claude-calls'))}, args.join(' ') + '\\n');\n`
        + `const sep = args.indexOf('--'); fs.writeFileSync(${JSON.stringify(join(config, '.claude.json'))}, JSON.stringify({ projects: `
        + `{ [process.cwd()]: { mcpServers: { slipstream: { type: 'stdio', command: args[sep + 1], args: args.slice(sep + 2) } } } } }));\n`);
      await chmod(fakeClaude, 0o755);
      const env = cleanEnv({ HOME: dir, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: sessionId,
        CLAUDE_CODE_EXECPATH: fakeClaude });
      const first = await run(['attach', work, '--store', store], env);
      pid = (JSON.parse(await readFile(join(store, 'owner.lock'), 'utf8')) as { pid: number }).pid;
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /Recording .*; agent setup pending/);
      const capture = /session_id: (\S+)/.exec(first.stdout)?.[1];
      const second = await run(['attach', work, '--store', store], env);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Already recording/);
      assert.equal(/session_id: (\S+)/.exec(second.stdout)?.[1], capture);
      assert.equal((await readFile(join(dir, 'claude-calls'), 'utf8')).split('\n').filter(Boolean).length, 1);
    } finally {
      if (pid !== undefined) {
        process.kill(pid, 'SIGTERM');
        const { probeSocket } = await import('./daemon.ts');
        while (await probeSocket(join(store, 'control.sock'), 200) === 'live') await new Promise((r) => setTimeout(r, 50));
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cli parseArgs (daemon commands)', () => {
  it('parses start with a store override and no worktree', () => {
    assert.deepEqual(parseArgs(['start', '--store', '/s']), {
      command: 'start',
      store: '/s',
      configPath: undefined,
      overrides: {},
    });
  });
  it('parses start enrichment overrides into a config override layer', () => {
    const parsed = parseArgs(['start', '--enable', 'claude-code', '--window-ms', '3000', '--codex-scan-limit', '50']);
    assert.equal(parsed?.command, 'start');
    assert.deepEqual((parsed as { overrides: unknown }).overrides, {
      sources: { 'claude-code': 'configured' },
      windowMs: 3000,
      codexScanLimit: 50,
    });
  });
  it('rejects start with a bad numeric override or unknown harness', () => {
    assert.equal(parseArgs(['start', '--window-ms', 'oops']), null);
    assert.equal(parseArgs(['start', '--window-ms', '0']), null);
    assert.equal(parseArgs(['start', '--enable', 'gemini']), null);
  });
  it('rejects start with a stray positional (start takes store options only)', () => {
    assert.equal(parseArgs(['start', '/some/dir']), null);
  });
  it('parses status and detach as store-only commands', () => {
    assert.deepEqual(parseArgs(['status', '--store', '/s']), { command: 'status', store: '/s' });
    assert.deepEqual(parseArgs(['detach', '--store', '/s']), { command: 'detach', store: '/s' });
  });
  it('parses attach with worktree, store, and identity flags', () => {
    assert.deepEqual(
      parseArgs(['attach', '/w', '--store', '/s', '--harness', 'claude-code', '--harness-session-id', 'abc']),
      { command: 'attach', dir: '/w', store: '/s', harness: 'claude-code', harnessSessionId: 'abc' },
    );
  });
  it('parses attach with no identity flags (the one-command workflow detects the chat)', () => {
    const parsed = parseArgs(['attach', '/w', '--store', '/s']);
    assert.equal(parsed?.command, 'attach');
    assert.equal(parsed && 'harness' in parsed ? parsed.harness : 'set', undefined);
  });
  it('rejects --harness without a following value', () => {
    assert.equal(parseArgs(['attach', '/w', '--harness']), null);
  });
});

describe('cli retryGuidance (unknown-outcome recovery)', () => {
  it('points delete at a rerun / listing check, never at status (status cannot confirm a tombstone)', () => {
    const g = retryGuidance('delete_session');
    assert.match(g, /idempotent/);
    assert.match(g, /410|listing/);
    assert.doesNotMatch(g, /slipstream status/);
  });
  it('points gc at a safe rerun, never at status', () => {
    const g = retryGuidance('gc');
    assert.match(g, /idempotent|rerun/);
    assert.doesNotMatch(g, /slipstream status/);
  });
  it('keeps the status hint for attach-state verbs', () => {
    assert.match(retryGuidance('detach'), /slipstream status/);
  });

});

describe('cli parseArgs (maintenance commands)', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  it('parses gc as a store-only command', () => {
    assert.deepEqual(parseArgs(['gc', '--store', '/s']), { command: 'gc', store: '/s' });
  });
  it('rejects gc with a stray positional', () => {
    assert.equal(parseArgs(['gc', 'extra']), null);
  });
  it('parses delete with a session id and store override (kept verbatim, never path-resolved)', () => {
    assert.deepEqual(parseArgs(['delete', UUID, '--store', '/s']),
      { command: 'delete', store: '/s', sessionId: UUID });
  });
  it('rejects delete with no session id', () => {
    assert.equal(parseArgs(['delete', '--store', '/s']), null);
  });
  it('rejects delete with a second positional', () => {
    assert.equal(parseArgs(['delete', UUID, 'again']), null);
  });
});

it('delete rejects a malformed session id client-side with exit code 2', async () => {
  const { execFile } = await import('node:child_process');
  const result = await new Promise<{ code: number | null; stderr: string }>((res) => {
    execFile(process.execPath, ['src/cli.ts', 'delete', 'not-a-uuid', '--store', '/tmp/none'],
      { timeout: 5000 }, (error, _stdout, stderr) =>
        res({ code: error && typeof error.code === 'number' ? error.code : 0, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /valid session id/i);
});

it('watch refuses a store dir already owned by a daemon (live control socket)', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'slip-cli-guard-'));
  const root = join(dir, 'work'); const store = join(dir, 'store');
  await mkdir(root); await mkdir(store, { mode: 0o700 });
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(join(store, 'control.sock'), resolve));
  try {
    const result = await new Promise<{ error: Error | null; stderr: string }>(resolve => {
      execFile(process.execPath, ['src/cli.ts', 'watch', root, '--store', store],
        { timeout: 5000 }, (error, _stdout, stderr) => resolve({ error, stderr }));
    });
    assert.ok(result.error, 'watch exited non-zero');
    assert.match(result.stderr, /daemon|control\.sock/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects two attach worktrees and accepts one with identity flags', () => {
  assert.equal(parseArgs(['attach', 'a', 'b', '--harness', 'x', '--harness-session-id', 'y']), null);
  const parsed = parseArgs(['attach', 'a', '--harness', 'x', '--harness-session-id', 'y']);
  assert.equal(parsed?.command, 'attach');
  assert.ok(parsed && 'harness' in parsed);
  assert.equal(parsed.harness, 'x');
  assert.equal(parsed.harnessSessionId, 'y');
});

for (const kind of ['file', 'stale socket'] as const) {
  for (const command of ['watch', 'serve']) {
    it(`${command} passes the daemon guard with a ${kind}`, async () => {
      const { mkdtemp, writeFile, rename, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { execFile } = await import('node:child_process');
      const { createServer } = await import('node:net');
      const store = await mkdtemp(join(tmpdir(), 'slip-guard-'));
      const socketPath = join(store, 'control.sock');
      try {
        if (kind === 'file') await writeFile(socketPath, 'unrelated file');
        else {
          const server = createServer();
          await new Promise<void>((resolve) => server.listen(socketPath, resolve));
          await rename(socketPath, socketPath + '.saved');
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rename(socketPath + '.saved', socketPath);
        }
        // A missing worktree makes capture fail promptly after passing the guard,
        // without relying on an OS watcher or a signal to end the child process.
        const result = await new Promise<{ error: Error | null; stderr: string }>((resolve) => {
          execFile(process.execPath, ['src/cli.ts', command, join(store, 'missing-worktree'), '--store', store],
            { timeout: 5000 }, (error, _stdout, stderr) => resolve({ error, stderr }));
        });
        assert.ok(result.error);
        assert.match(result.stderr, /ENOENT.*missing-worktree/);
        assert.doesNotMatch(result.stderr, /owned by a running daemon/);
      } finally { await rm(store, { recursive: true, force: true }); }
    });
  }
}
