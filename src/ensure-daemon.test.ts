import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonUnavailableError, ensureDaemon, type EnsureDaemonDeps } from './ensure-daemon.ts';
import type { BuildCheck } from './daemon-version.ts';

const never = () => ({ exited: new Promise<number | null>(() => {}) });
const same = async (): Promise<BuildCheck> => ({ kind: 'same' });
const refuse: EnsureDaemonDeps['mismatch'] = async () => ({ message: 'The daemon is 0.1.0; this CLI is 0.3.0. Restart it with `x`.' });

describe('ensureDaemon', () => {
  it('refuses without probing, starting or restarting anything when the store\'s daemon belongs to another owner', async () => {
    const calls: string[] = [];
    await assert.rejects(ensureDaemon('/s', {
      refusal: 'Slipstream.app manages the recorder for /s.',
      probe: async () => { calls.push('probe'); return 'live'; },
      startDaemon: () => { calls.push('start'); return never(); },
      checkBuild: async () => { calls.push('build'); return { kind: 'same' }; },
      mismatch: async (d) => { calls.push('mismatch'); return refuse(d); },
    }), (err: Error) => err instanceof DaemonUnavailableError
      && err.message === 'Slipstream.app manages the recorder for /s. Nothing was recorded.');
    assert.deepEqual(calls, []);
  });

  it('keeps a live daemon of this build without starting another', async () => {
    let started = 0;
    await ensureDaemon('/s', { probe: async () => 'live', startDaemon: () => { started++; return never(); }, checkBuild: same, mismatch: refuse });
    assert.equal(started, 0);
  });

  it('waits for a started daemon to answer', async () => {
    let answers = false;
    await ensureDaemon('/s', {
      probe: async () => answers ? 'live' : 'stale',
      startDaemon: () => { setTimeout(() => { answers = true; }, 30); return never(); },
      checkBuild: same, mismatch: refuse, pollIntervalMs: 5,
    });
  });

  it('points at the managed daemon\'s log when its start fails', async () => {
    await assert.rejects(ensureDaemon('/s', {
      probe: async () => 'stale', startDaemon: () => ({ exited: Promise.resolve(113) }), checkBuild: same, mismatch: refuse,
      logPath: '/home/Library/Logs/slipstream/daemon.log', pollIntervalMs: 5,
    }), (err: Error) => err instanceof DaemonUnavailableError && /See \/home\/Library\/Logs\/slipstream\/daemon\.log/.test(err.message));
  });

  for (const [name, daemon] of [['an older version', { version: '0.2.0', build: null }], ['no version', null]] as const) {
    it(`refuses a live daemon that reports ${name} when it cannot be restarted in place`, async () => {
      let started = 0;
      await assert.rejects(ensureDaemon('/s', {
        probe: async () => 'live', startDaemon: () => { started++; return never(); },
        checkBuild: async () => ({ kind: 'different', daemon }),
        mismatch: async (d) => { assert.deepEqual(d, daemon); return refuse(d); },
      }), (err: Error) => err instanceof DaemonUnavailableError
        && err.message === 'The daemon is 0.1.0; this CLI is 0.3.0. Restart it with `x`. Nothing was recorded.');
      assert.equal(started, 0);
    });
  }

  it('refuses a daemon it started when that one is another build too', async () => {
    let answers = false;
    await assert.rejects(ensureDaemon('/s', {
      probe: async () => answers ? 'live' : 'stale',
      startDaemon: () => { answers = true; return never(); },
      checkBuild: async () => ({ kind: 'different', daemon: { version: '0.1.0', build: null } }), mismatch: refuse, pollIntervalMs: 5,
    }), /this CLI is 0\.3\.0/);
  });

  it('restarts a daemon of another build in place when the install allows it, then uses it', async () => {
    let restarted = 0;
    await ensureDaemon('/s', {
      probe: async () => 'live', startDaemon: never,
      checkBuild: async () => restarted > 0 ? { kind: 'same' } : { kind: 'different', daemon: null },
      mismatch: async (d) => ({ ...await refuse(d), restart: () => { restarted++; return never(); } }),
      pollIntervalMs: 5,
    });
    assert.equal(restarted, 1);
  });

  it('does not restart when another caller replaces the daemon while the remedy is computed', async () => {
    let checks = 0;
    let restarted = 0;
    await ensureDaemon('/s', {
      probe: async () => 'live', startDaemon: never,
      checkBuild: async () => ++checks === 1 ? { kind: 'different', daemon: null } : { kind: 'same' },
      mismatch: async (d) => ({ ...await refuse(d), restart: () => { restarted++; return never(); } }),
    });
    assert.equal(restarted, 0);
    assert.equal(checks, 2);
  });

  it('refuses when a restart in place does not bring up this build', async () => {
    let restarted = 0;
    await assert.rejects(ensureDaemon('/s', {
      probe: async () => 'live', startDaemon: never,
      checkBuild: async () => ({ kind: 'different', daemon: null }),
      mismatch: async (d) => ({ ...await refuse(d), restart: () => { restarted++; return { exited: Promise.resolve(1) }; } }),
      logPath: '/l/daemon.log', pollIntervalMs: 5,
    }), (err: Error) => err instanceof DaemonUnavailableError
      && /Restart it with `x`\. Restarting it did not bring up this version; see \/l\/daemon\.log\. Nothing was recorded\.$/.test(err.message));
    assert.equal(restarted, 1);
  });

  it('refuses a daemon whose build it cannot read', async () => {
    await assert.rejects(ensureDaemon('/s', {
      probe: async () => 'live', startDaemon: never,
      checkBuild: async () => ({ kind: 'unreadable', message: 'PROTOCOL: bad' }), mismatch: refuse,
    }), (err: Error) => err instanceof DaemonUnavailableError && /couldn't confirm .* \(PROTOCOL: bad\)/.test(err.message));
  });
});
