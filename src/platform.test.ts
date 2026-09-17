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
    stopObserving: async () => sub.close(),
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

  it('routes failWith to onError as an honest coverage-gap signal', async () => {
    const platform = createFakePlatform();
    const errors: Error[] = [];
    await platform.watch({ root: '/root', ignore: [], onObservation: () => {}, onError: (e) => errors.push(e) });
    platform.failWith(new Error('watch lapsed'));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /watch lapsed/);
  });

  it('throws if driven before watch() so misuse is caught, not silently dropped', async () => {
    const platform = createFakePlatform();
    assert.throws(() => platform.observe('a.ts'), /before watch/);
    assert.throws(() => platform.failWith(new Error('x')), /before watch/);
  });
});
