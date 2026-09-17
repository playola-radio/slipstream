import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePlatform } from './test/fake-platform.ts';
import { describePlatformContract, type ObservationHarness } from './test/platform-contract.ts';

// The fake never touches disk, but a real temp root keeps absolute-path math
// identical to the real driver in platform.os.test.ts.
const fakeHarness = async ({ ignore = [] }: { ignore?: string[] }): Promise<ObservationHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'slip-fake-'));
  const observations: string[] = [];
  const platform = createFakePlatform();
  const sub = await platform.watch({
    root,
    ignore: ignore.map((d) => join(root, d)),
    onObservation: (abs) => observations.push(abs),
    onError: () => {},
  });
  return {
    root,
    observations,
    mutate: async (rel) => platform.observe(rel),
    settle: async () => {},
    close: async () => {
      await sub.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

describePlatformContract('fake', fakeHarness);

describe('FakePlatform', () => {
  it('delivers a relative observation as an absolute path under the watched root', async () => {
    const platform = createFakePlatform();
    const observations: Array<[string, number]> = [];
    await platform.watch({ root: '/root', ignore: [], onObservation: (p, at) => observations.push([p, at]), onError: () => {} });
    platform.observe('src/a.ts', 123);
    assert.deepEqual(observations, [['/root/src/a.ts', 123]]);
  });

  it('routes failWith to onError as an honest coverage-gap signal', async () => {
    const platform = createFakePlatform();
    const errors: Error[] = [];
    await platform.watch({ root: '/root', ignore: [], onObservation: () => {}, onError: (e) => errors.push(e) });
    platform.failWith(new Error('watch lapsed'));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /watch lapsed/);
  });

  it('stops delivering observations after close', async () => {
    const platform = createFakePlatform();
    const observations: string[] = [];
    const sub = await platform.watch({ root: '/root', ignore: [], onObservation: (p) => observations.push(p), onError: () => {} });
    await sub.close();
    platform.observe('a.ts');
    assert.deepEqual(observations, []);
    assert.equal(platform.closed, true);
    assert.equal(platform.watching, false);
  });

  it('throws if driven before watch() so misuse is caught, not silently dropped', async () => {
    const platform = createFakePlatform();
    assert.throws(() => platform.observe('a.ts'), /before watch/);
    assert.throws(() => platform.failWith(new Error('x')), /before watch/);
  });
});
