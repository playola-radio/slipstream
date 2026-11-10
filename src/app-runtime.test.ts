import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentEntries, appRuntime } from './app-runtime.ts';

describe('appRuntime', () => {
  it('is null outside the Slipstream app', () => {
    assert.equal(appRuntime({}), null);
  });

  it('derives both shim paths from the runtime root the shims set', () => {
    assert.deepEqual(appRuntime({ SLIPSTREAM_APP_RUNTIME: '/rt' }),
      { root: '/rt', cli: '/rt/bin/slipstream', mcp: '/rt/bin/slipstream-mcp' });
  });
});

describe('agentEntries', () => {
  it('runs the CLI and the forwarder beside it with this Node outside the app', () => {
    assert.deepEqual(agentEntries({}, '/n/node', '/pkg/dist/cli.js'), {
      entry: { command: '/n/node', args: ['/pkg/dist/cli.js'] },
      mcpEntry: { command: '/n/node', args: ['/pkg/dist/mcp-forwarder.js'] },
    });
  });

  it('runs the app\'s stable shims in the app', () => {
    assert.deepEqual(agentEntries({ SLIPSTREAM_APP_RUNTIME: '/rt' }, '/n/node', '/pkg/dist/cli.js'), {
      entry: { command: '/rt/bin/slipstream', args: [] },
      mcpEntry: { command: '/rt/bin/slipstream-mcp', args: [] },
    });
  });
});
