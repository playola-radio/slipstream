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

it('watch refuses a store dir already owned by a daemon (control.sock present)', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'slip-cli-guard-'));
  const root = join(dir, 'work'); const store = join(dir, 'store');
  await mkdir(root); await mkdir(store, { mode: 0o700 });
  await writeFile(join(store, 'control.sock'), '');
  try {
    const result = await new Promise<{ error: Error | null; stderr: string }>(resolve => {
      execFile(process.execPath, ['src/cli.ts', 'watch', root, '--store', store],
        { timeout: 5000 }, (error, _stdout, stderr) => resolve({ error, stderr }));
    });
    assert.ok(result.error, 'watch exited non-zero');
    assert.match(result.stderr, /daemon|control\.sock/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
