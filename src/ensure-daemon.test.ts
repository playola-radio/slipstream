import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonUnavailableError, ensureDaemon } from './ensure-daemon.ts';

describe('ensureDaemon', () => {
  it('keeps a live daemon without starting another', async () => {
    let started = 0;
    await ensureDaemon('/s', { probe: async () => 'live', startDaemon: () => { started++; return { exited: new Promise(() => {}) }; } });
    assert.equal(started, 0);
  });

  it('waits for a started daemon to answer', async () => {
    let answers = false;
    await ensureDaemon('/s', {
      probe: async () => answers ? 'live' : 'stale',
      startDaemon: () => { setTimeout(() => { answers = true; }, 30); return { exited: new Promise(() => {}) }; },
      pollIntervalMs: 5,
    });
  });

  it('points at the managed daemon\'s log when its start fails', async () => {
    await assert.rejects(ensureDaemon('/s', {
      probe: async () => 'stale', startDaemon: () => ({ exited: Promise.resolve(113) }),
      logPath: '/home/Library/Logs/slipstream/daemon.log', pollIntervalMs: 5,
    }), (err: Error) => err instanceof DaemonUnavailableError && /See \/home\/Library\/Logs\/slipstream\/daemon\.log/.test(err.message));
  });
});
