import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './test/helpers.ts';
import type { RequestEnvelope, ResponseEnvelope } from './control-protocol.ts';
import { checkDaemonBuild, mismatchMessage, remedyFor, thisBuild, versionGate, type Build } from './daemon-version.ts';

const OWN: Build = { version: '0.3.0', build: null };

function daemon(status: ResponseEnvelope) {
  const sent: RequestEnvelope[] = [];
  const send = async (request: RequestEnvelope): Promise<ResponseEnvelope> => {
    sent.push(request);
    return request.verb === 'status' ? status : { v: 1, ok: true, verb: request.verb };
  };
  return { sent, send };
}

describe('thisBuild', () => {
  it('reports the package version, and no build id when run from source', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.deepEqual(await thisBuild(), { version: pkg.version, build: null });
  });
});

describe('checkDaemonBuild', () => {
  it('matches a daemon of the same version and build', async () => {
    const { send } = daemon({ v: 1, ok: true, daemon_version: '0.3.0', daemon_build: null });
    assert.deepEqual(await checkDaemonBuild(send, OWN), { kind: 'same' });
  });

  it('treats a daemon that reports no version as older', async () => {
    const { send } = daemon({ v: 1, ok: true, reader_url: 'http://127.0.0.1:1' });
    assert.deepEqual(await checkDaemonBuild(send, OWN), { kind: 'different', daemon: null });
  });

  it('tells apart two builds of the same version', async () => {
    const { send } = daemon({ v: 1, ok: true, daemon_version: '0.3.0', daemon_build: 'abc' });
    assert.deepEqual(await checkDaemonBuild(send, OWN), { kind: 'different', daemon: { version: '0.3.0', build: 'abc' } });
  });

  it('reports no daemon as absent', async () => {
    const { send } = daemon({ v: 1, ok: false, code: 'DAEMON_UNAVAILABLE', message: 'no socket' });
    assert.deepEqual(await checkDaemonBuild(send, OWN), { kind: 'absent' });
  });
});

describe('mismatchMessage', () => {
  it('names both versions and the remedy', () => {
    assert.equal(mismatchMessage('/s', { version: '0.2.0', build: 'x' }, OWN, 'Restart it with `y`.'),
      'The Slipstream daemon running for /s is 0.2.0; this CLI is 0.3.0. Restart it with `y`.');
  });

  it('calls a daemon without a version an older version', () => {
    assert.match(mismatchMessage('/s', null, OWN, 'R.'), /is an older version \(it does not report one\); this CLI is 0\.3\.0\. R\.$/);
  });

  it('shows builds when the versions are equal', () => {
    assert.match(mismatchMessage('/s', { version: '0.3.0', build: '0123456789' }, OWN, 'R.'),
      /is 0\.3\.0 \(build 01234567\); this CLI is 0\.3\.0 \(run from source\)/);
  });
});

describe('remedyFor', () => {
  it('tells a detached daemon\'s user which process to stop, without stopping it', async () => {
    await withTempDir(async (store) => {
      await writeFile(join(store, 'owner.lock'), JSON.stringify({ pid: 4242, nonce: 'n' }));
      const remedy = await remedyFor(store, null, OWN);
      assert.equal(remedy.restart, undefined);
      assert.match(remedy.text, /^Stop it with `kill 4242`, then run this command again to start one on 0\.3\.0\./);
      assert.match(remedy.text, /record folders an older daemon was recording again/);
    });
  });

  it('names the start command when the daemon\'s pid is unknown', async () => {
    await withTempDir(async (store) => {
      const remedy = await remedyFor(store, { version: '0.4.0', build: null }, OWN);
      assert.match(remedy.text, /^Stop the `slipstream start --store \S+` process, then/);
      assert.match(remedy.text, /resumes its recordings with a marked gap\.$/);
    });
  });

  it('sends a managed install on other paths to conductor install', async () => {
    await withTempDir(async (store) => {
      await mkdir(join(store, 'control'));
      await writeFile(join(store, 'control', 'install.json'), JSON.stringify({
        version: 1, package_version: '0.1.0', node: '/old/node', cli: '/old/cli.js', log: '/l', repos: [],
      }));
      const remedy = await remedyFor(store, null, OWN);
      assert.equal(remedy.restart, undefined);
      assert.match(remedy.text, /^Restart it on this version with `slipstream conductor install --store \S+`\.$/);
    });
  });
});

describe('versionGate', () => {
  it('passes requests to a daemon of this build', async () => {
    const d = daemon({ v: 1, ok: true, daemon_version: '0.3.0', daemon_build: null });
    const gated = versionGate(d.send, '/s', OWN);
    assert.equal((await gated({ v: 1, verb: 'detach' })).ok, true);
    assert.equal((await gated({ v: 1, verb: 'detach' })).ok, true);
    assert.deepEqual(d.sent.map((r) => r.verb), ['status', 'detach', 'detach']);
  });

  it('sends nothing to a daemon that reports no version', async () => {
    await withTempDir(async (store) => {
      const d = daemon({ v: 1, ok: true });
      const res = await versionGate(d.send, store, OWN)({ v: 1, verb: 'detach' });
      assert.equal(res.ok, false);
      assert.equal(!res.ok && res.code, 'DAEMON_VERSION_MISMATCH');
      assert.match(!res.ok ? res.message : '', /is an older version/);
      assert.deepEqual(d.sent.map((r) => r.verb), ['status']);
    });
  });

  it('sends nothing to a daemon of an older version', async () => {
    await withTempDir(async (store) => {
      const d = daemon({ v: 1, ok: true, daemon_version: '0.2.0', daemon_build: null });
      const res = await versionGate(d.send, store, OWN)({ v: 1, verb: 'detach' });
      assert.equal(!res.ok && res.code, 'DAEMON_VERSION_MISMATCH');
      assert.deepEqual(d.sent.map((r) => r.verb), ['status']);
    });
  });

  it('lets an unanswered request report the daemon unavailable', async () => {
    const sent: string[] = [];
    const send = async (request: RequestEnvelope): Promise<ResponseEnvelope> => {
      sent.push(request.verb);
      return { v: 1, ok: false, code: 'DAEMON_UNAVAILABLE', message: 'no socket' };
    };
    const res = await versionGate(send, '/s', OWN)({ v: 1, verb: 'detach' });
    assert.equal(!res.ok && res.code, 'DAEMON_UNAVAILABLE');
    assert.deepEqual(sent, ['status', 'detach']);
  });
});
