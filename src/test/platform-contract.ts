import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';

/**
 * A driver that exercises one `Platform` implementation. The real driver mutates
 * real files under a watched temp root; the fake driver delivers observations
 * directly. The contract asserts the properties that must hold for BOTH — an
 * observed in-root change surfaces as an absolute path under root, an ignored
 * subtree is never reported, a change outside root is never reported, and no
 * change is reported after the subscription is closed — so the centralized
 * `FakePlatform` cannot drift from the real boundary's resolution, exclusion,
 * and lifecycle semantics.
 *
 * It deliberately does NOT assert notification *sequences* (one-per-write,
 * ordering, metadata-change delivery). Those are platform capabilities, proven
 * only by the real-OS probes, never by fake conformance.
 */
export interface ObservationHarness {
  readonly root: string;
  /** Absolute paths delivered to `onObservation`, in delivery order. */
  readonly observations: readonly string[];
  /** Cause a change at `relPath` (real: write the file; fake: deliver it). A
   *  `../`-prefixed `relPath` targets a location outside the watched root. */
  mutate(relPath: string): Promise<void>;
  /** Give any in-flight delivery a chance to arrive (for negative assertions). */
  settle(): Promise<void>;
  /** Stop the subscription without tearing down the harness, so a post-close
   *  mutation can be attempted against a root that still exists. */
  stopObserving(): Promise<void>;
  close(): Promise<void>;
}

type HarnessFactory = (opts: { ignore?: string[] }) => Promise<ObservationHarness>;

const CONTRACT_TIMEOUT_MS = 8000;

function isObserved(h: ObservationHarness, relPath: string): boolean {
  return h.observations.some((abs) => relative(h.root, abs) === relPath);
}

async function waitObserved(h: ObservationHarness, relPath: string): Promise<void> {
  const deadline = Date.now() + CONTRACT_TIMEOUT_MS;
  while (!isObserved(h, relPath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for an observation of ${relPath}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function describePlatformContract(label: string, make: HarnessFactory): void {
  describe(`Platform contract: ${label}`, () => {
    it('delivers an in-root change as an absolute path under root', async () => {
      // A subscription that was not ready would never deliver this, so this also
      // stands in for subscription readiness.
      const h = await make({});
      try {
        await h.mutate('a.ts');
        await waitObserved(h, 'a.ts'); // throws if the change never surfaces under root
      } finally {
        await h.close();
      }
    });

    it('does not report a change inside an ignored subtree', async () => {
      const h = await make({ ignore: ['ignored'] });
      try {
        await h.mutate('ignored/x.ts');
        await h.mutate('ignored/..edge.ts'); // a "..name" child must still count as inside
        await h.mutate('kept.ts');
        // The control observation arriving means delivery is working; the ignored
        // ones have had at least as long to arrive and must be absent.
        await waitObserved(h, 'kept.ts');
        await h.settle();
        assert.equal(isObserved(h, 'ignored/x.ts'), false, 'an ignored subtree must not be reported');
        assert.equal(isObserved(h, 'ignored/..edge.ts'), false, 'a "..name" file under an ignored dir must not be reported');
      } finally {
        await h.close();
      }
    });

    it('does not report a change outside the watched root', async () => {
      const h = await make({});
      try {
        await h.mutate('inside.ts');
        await waitObserved(h, 'inside.ts'); // delivery is working
        await h.mutate('../outside.ts'); // escapes the watched root
        await h.settle();
        assert.equal(isObserved(h, '../outside.ts'), false, 'a change outside root must not be reported');
      } finally {
        await h.close();
      }
    });

    it('stops reporting changes after the subscription is closed', async () => {
      const h = await make({});
      try {
        await h.mutate('before.ts');
        await waitObserved(h, 'before.ts'); // live delivery confirmed
        await h.stopObserving();
        await h.mutate('after.ts');
        await h.settle();
        assert.equal(isObserved(h, 'after.ts'), false, 'no observation may arrive after close');
      } finally {
        await h.close();
      }
    });
  });
}
