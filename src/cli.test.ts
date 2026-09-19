import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './cli.ts';

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

describe('cli parseArgs (daemon commands)', () => {
  it('parses start with a store override and no worktree', () => {
    assert.deepEqual(parseArgs(['start', '--store', '/s']), { command: 'start', store: '/s' });
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
  it('parses attach with no identity flags (daemon fails it closed, not the parser)', () => {
    const parsed = parseArgs(['attach', '/w', '--store', '/s']);
    assert.equal(parsed?.command, 'attach');
    assert.equal(parsed && 'harness' in parsed ? parsed.harness : 'set', undefined);
  });
  it('rejects --harness without a following value', () => {
    assert.equal(parseArgs(['attach', '/w', '--harness']), null);
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
  it('parses delete with a session id and store override', () => {
    assert.deepEqual(parseArgs(['delete', UUID, '--store', '/s']),
      { command: 'delete', store: '/s', sessionId: UUID });
  });
  it('keeps the session id verbatim (never resolves it as a path)', () => {
    const parsed = parseArgs(['delete', UUID, '--store', '/s']);
    assert.equal(parsed?.command === 'delete' && parsed.sessionId, UUID);
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
