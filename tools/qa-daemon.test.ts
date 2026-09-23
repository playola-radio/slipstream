import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs, curlCommands, probeStoreLiveness, runQaDaemon, ArgError } from './qa-daemon.ts';
import { prepareRoot } from './qa/safety.ts';

describe('qa-daemon parseArgs', () => {
  const home = '/home/u';

  it('defaults to ~/.slipstream-qa/local with no scenario and fresh mode', () => {
    const a = parseArgs([], home);
    assert.equal(a.root, join(home, '.slipstream-qa', 'local'));
    assert.equal(a.scenario, null);
    assert.equal(a.keep, false);
    assert.equal(a.reuse, false);
  });

  it('resolves --root against cwd and reads scenario/keep/reuse', () => {
    const a = parseArgs(['--root', 'sandbox', '--scenario', 'T-QA', '--keep', '--reuse'], home);
    assert.equal(a.root, resolve('sandbox'));
    assert.equal(a.scenario, 'T-QA');
    assert.equal(a.keep, true);
    assert.equal(a.reuse, true);
  });

  it('throws on a flag missing its value', () => {
    assert.throws(() => parseArgs(['--root'], home), ArgError);
    assert.throws(() => parseArgs(['--scenario'], home), ArgError);
  });

  it('throws on an unknown flag', () => {
    assert.throws(() => parseArgs(['--nope'], home), ArgError);
  });

  it('reads an explicit --run-id launch nonce (defaults to null → generated)', () => {
    assert.equal(parseArgs([], home).runId, null);
    assert.equal(parseArgs(['--run-id', 'nonce-42'], home).runId, 'nonce-42');
    assert.throws(() => parseArgs(['--run-id'], home), ArgError);
  });
});

describe('qa-daemon probeStoreLiveness', () => {
  it('maps a store that never ran a daemon (no socket) to none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-probe-'));
    try {
      assert.equal(await probeStoreLiveness(dir), 'none');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('qa-daemon curlCommands', () => {
  it('emits authenticated finite, replay and SSE-follow commands for the session', () => {
    const cmds = curlCommands({ url: 'http://127.0.0.1:9', token: 'T', sessionId: 'qa:1' });
    assert.equal(cmds.length, 3);
    assert.ok(cmds.every((c) => c.includes('authorization: Bearer T')));
    assert.ok(cmds[0]!.includes('/v1/sessions'));
    assert.ok(cmds[1]!.includes('/v1/sessions/qa:1/events?after=0'));
    assert.ok(cmds[2]!.includes('follow=true') && cmds[2]!.includes('curl -N'));
  });
});

describe('runQaDaemon startup-failure cleanup', () => {
  it('stops the daemon it started when a step AFTER startDaemon throws (scenario seeding)', async () => {
    // Keep the prefix short: the control socket path must stay under macOS's
    // ~104-byte UNIX_PATH_MAX, or connect() fails with ENAMETOOLONG, which
    // probeSocket maps to 'ambiguous' — a false refusal unrelated to this test.
    const root = join(await mkdtemp(join(tmpdir(), 'ss-qa-d-')), 'root');
    const runId = randomUUID();
    // --reuse requires a pre-existing owned root, so build the real layout
    // ourselves via the same prepareRoot production uses, then sabotage the
    // worktree so the REAL T-QA scenario's writeFile throws during seeding — a
    // genuine failure strictly after startDaemon and well before the keep-alive
    // await. (Fresh mode can't be used here: it requires an absent/empty root,
    // and asserting root-deletion afterward is meaningless under --reuse, which
    // deliberately retains the root — so this test's signal is "the daemon this
    // call started got stopped", not "the root is gone".)
    const { store, worktree } = await prepareRoot(root, runId);
    await chmod(worktree, 0o500);
    try {
      const sink = { out: [] as string[], err: [] as string[] };
      // The sabotaged write throws inside scenario.seed, well past startDaemon;
      // runQaDaemon propagates it as a rejection (matching the top-level
      // `.then(_, err => process.exit(1))` fatal handler), not a return value.
      await assert.rejects(
        () => runQaDaemon({
          home: tmpdir(),
          argv: ['--root', root, '--reuse', '--scenario', 'T-QA', '--run-id', runId],
          stdout: (l) => sink.out.push(l),
          stderr: (l) => sink.err.push(l),
          cwd: process.cwd(),
        }),
        /EACCES/,
        'the seeding failure must still propagate so the fatal handler reports non-zero',
      );
      assert.equal(
        await probeStoreLiveness(store),
        'none',
        'the daemon started before the failure must be stopped by cleanup, not left running',
      );
    } finally {
      await chmod(worktree, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
