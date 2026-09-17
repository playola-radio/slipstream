import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createFakePlatform } from './test/fake-platform.ts';
import { describePlatformContract, type ObservationHarness } from './test/platform-contract.ts';

// The fake does pure path arithmetic and synchronous delivery — no disk — so a
// fixed absolute root is enough. The real driver in platform.os.test.ts is what
// exercises real filesystem resources against the same contract.
const FAKE_ROOT = join('/', 'slip-fake-root');

const fakeHarness = async ({ ignore = [] }: { ignore?: string[] }): Promise<ObservationHarness> => {
  const observations: string[] = [];
  const platform = createFakePlatform();
  const sub = await platform.watch({
    root: FAKE_ROOT,
    ignore: ignore.map((d) => join(FAKE_ROOT, d)),
    onObservation: (abs) => observations.push(abs),
    onError: () => {},
  });
  return {
    root: FAKE_ROOT,
    observations,
    mutate: async (rel) => platform.observe(rel),
    settle: async () => {},
    close: async () => sub.close(),
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

  it('drops an observation that resolves outside the watched root', async () => {
    const platform = createFakePlatform();
    const observations: string[] = [];
    await platform.watch({ root: '/root', ignore: [], onObservation: (p) => observations.push(p), onError: () => {} });
    platform.observe('../outside.ts');
    assert.deepEqual(observations, [], 'the real watcher never reports a path outside root');
  });

  it('drops a "..name" file inside an ignored subtree (not just its plain children)', async () => {
    const platform = createFakePlatform();
    const observations: string[] = [];
    await platform.watch({ root: '/root', ignore: ['/root/ignored'], onObservation: (p) => observations.push(p), onError: () => {} });
    platform.observe('ignored/..notes.ts');
    assert.deepEqual(observations, [], 'a "..notes.ts" under an ignored dir is still ignored');
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
  });

  it('throws if driven before watch() so misuse is caught, not silently dropped', async () => {
    const platform = createFakePlatform();
    assert.throws(() => platform.observe('a.ts'), /before watch/);
    assert.throws(() => platform.failWith(new Error('x')), /before watch/);
  });
});
