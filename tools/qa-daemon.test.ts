import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { parseArgs, defaultRoot, curlCommands, ArgError } from './qa-daemon.ts';

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

  it('defaultRoot honors the passed home', () => {
    assert.equal(defaultRoot('/tmp/x'), join('/tmp/x', '.slipstream-qa', 'local'));
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
