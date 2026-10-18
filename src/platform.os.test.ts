/**
 * Real-OS tier: the contract run against the actual `@parcel/watcher` boundary.
 * Excluded from `npm test` (it needs real FSEvents); run with `npm run test:os`
 * on a developer Mac. This is what keeps the fake honest — if the fake's
 * resolution or exclusion semantics ever diverge from the real watcher, one of
 * these two runs fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPlatform } from './platform.ts';
import { describePlatformContract, type ObservationHarness } from './test/platform-contract.ts';

const realHarness = async ({ ignore = [] }: { ignore?: string[] }): Promise<ObservationHarness> => {
  // The native watcher reports realpaths; resolve the root the same way the
  // session does so relative-path math lines up. `root` sits inside a scratch
  // dir, so a `../` mutation lands outside the watched root but inside scratch
  // and is still cleaned up.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'slip-os-')));
  const root = join(scratch, 'root');
  await mkdir(root);
  const observations: string[] = [];
  const platform = createPlatform();
  const sub = await platform.watch({
    root,
    ignore: ignore.map((d) => join(root, d)),
    onObservation: (abs) => observations.push(abs),
    onError: () => {},
    onClosed: () => {},
  });
  let stopped = false;
  const stopObserving = async () => {
    if (!stopped) {
      stopped = true;
      await sub.close();
    }
  };
  return {
    root,
    observations,
    mutate: async (rel) => {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, `content-${Math.random()}`);
    },
    settle: async () => new Promise((r) => setTimeout(r, 250)),
    stopObserving,
    close: async () => {
      await stopObserving();
      await rm(scratch, { recursive: true, force: true });
    },
  };
};

describePlatformContract('real @parcel/watcher', realHarness);

// The session detects a deleted root from the root's own delete event, because
// @parcel/watcher stops its FSEvents stream silently when the root goes away.
describe('real @parcel/watcher on a deleted root', () => {
  it('reports the root path itself', async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'slip-os-')));
    const root = join(scratch, 'root');
    await mkdir(root);
    const observations: string[] = [];
    const sub = await createPlatform().watch({
      root, ignore: [], onObservation: (abs) => observations.push(abs), onError: () => {}, onClosed: () => {},
    });
    try {
      await new Promise((r) => setTimeout(r, 250));
      await rm(root, { recursive: true });
      const deadline = Date.now() + 5000;
      while (!observations.includes(root) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(observations.includes(root), `expected an observation of ${root}, got ${JSON.stringify(observations)}`);
    } finally {
      await sub.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
