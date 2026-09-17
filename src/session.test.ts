import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { startCapture } from './session.ts';
import type { Platform } from './platform.ts';
import type { Log } from './log.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { changesFor, waitForRecords, withFakeSession } from './test/helpers.ts';

// The deterministic tier: capture logic driven by the centralized FakePlatform.
// Every observation is delivered explicitly via `observe`, so nothing here
// depends on real FSEvents timing or permission enforcement. The genuinely
// platform-dependent claims live in session.os.test.ts (the real-OS tier).

describe('session', () => {
  it('closes the watcher and log when baseline startup throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
    const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
    let watcherClosed = false;
    let logClosed = false;
    const fakeLog: Log = {
      append: async () => {},
      close: async () => { logClosed = true; },
    };
    try {
      await assert.rejects(
        startCapture(
          { root, storeDir: store },
          {
            createLog: async () => fakeLog,
            platform: { watch: async () => ({ close: async () => { watcherClosed = true; } }) },
            enumerate: async () => { throw new Error('baseline failed'); },
          },
        ),
        /baseline failed/,
      );
      assert.equal(watcherClosed, true);
      assert.equal(logClosed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  describe('baseline', () => {
    it('does not report pre-existing content in a dirty worktree as a new edit', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'existing.ts'), 'already here before attach');
        },
        async ({ root, observe, waitFor }) => {
          // Touch a different file to get a definite event, then assert the
          // pre-existing file produced no change record.
          await writeFile(join(root, 'trigger.ts'), 'new');
          observe('trigger.ts');
          const recs = await waitFor((r) => changesFor(r, 'trigger.ts').length >= 1);
          assert.equal(changesFor(recs, 'existing.ts').length, 0);
        },
      );
    });

    it('never fabricates absent for a file whose baseline directory was unreadable', async () => {
      await withFakeSession(
        async (root) => {
          await mkdir(join(root, 'locked'));
          await writeFile(join(root, 'locked', 'existing.ts'), 'pre-existing');
        },
        async ({ root, observe, waitFor }) => {
          const rel = join('locked', 'existing.ts');
          await writeFile(join(root, 'locked', 'existing.ts'), 'changed after restore');
          observe(rel);
          const recs = await waitFor((r) => changesFor(r, rel).length >= 1);
          // The incomplete baseline is disclosed as a gap...
          assert.ok(
            recs.some((x) => x.type === 'capture.gap' && x.reason === 'baseline-unreadable' && x.path === 'locked'),
            'expected a baseline-unreadable gap for the locked directory',
          );
          // ...and the later change carries an honest unavailable/baseline-unknown
          // before-state, never a fabricated absent implying a brand-new file.
          const [c] = changesFor(recs, rel);
          assert.equal(c?.type, 'file.changed');
          if (c?.type === 'file.changed') {
            assert.equal(c.before.kind, 'unavailable');
            if (c.before.kind === 'unavailable') assert.equal(c.before.reason, 'baseline-unknown');
            assert.equal(c.after.kind, 'content');
          }
        },
        {
          // Simulate an unreadable 'locked' dir deterministically — no chmod, so
          // this holds even when the suite runs as root.
          enumerate: async (_root, _dir, _isExcluded, handlers) => {
            await handlers.onDirError('locked');
          },
        },
      );
    });
  });

  describe('capture', () => {
    it('emits absent -> content when a file is created', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'created.ts'), 'hello world');
          observe('created.ts');
          const recs = await waitFor((r) => changesFor(r, 'created.ts').length >= 1);
          const [c] = changesFor(recs, 'created.ts');
          assert.equal(c?.type, 'file.changed');
          if (c?.type === 'file.changed') {
            assert.equal(c.before.kind, 'absent');
            assert.equal(c.after.kind, 'content');
          }
        },
      );
    });

    it('emits content -> content with the new bytes when a baselined file is modified', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'f.ts'), 'v1');
        },
        async ({ root, session, observe, waitFor }) => {
          await writeFile(join(root, 'f.ts'), 'v2-changed');
          observe('f.ts');
          const recs = await waitFor((r) => changesFor(r, 'f.ts').length >= 1);
          const [c] = changesFor(recs, 'f.ts');
          if (c?.type === 'file.changed' && c.after.kind === 'content') {
            const stored = await readFile(join(session.blobsDir, 'sha256', c.after.sha256.slice(0, 2), c.after.sha256), 'utf8');
            assert.equal(stored, 'v2-changed');
          } else {
            assert.fail('expected a content change');
          }
        },
      );
    });

    it('emits content -> absent when a file is deleted', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'doomed.ts'), 'bye');
        },
        async ({ root, observe, waitFor }) => {
          await rm(join(root, 'doomed.ts'));
          observe('doomed.ts');
          const recs = await waitFor((r) =>
            changesFor(r, 'doomed.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'absent'),
          );
          const c = changesFor(recs, 'doomed.ts').at(-1);
          if (c?.type === 'file.changed') assert.equal(c.after.kind, 'absent');
          else assert.fail('expected a deletion');
        },
      );
    });

    it('captures an empty file as a zero-byte content snapshot, not absent', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'empty.ts'), '');
          observe('empty.ts');
          const recs = await waitFor((r) => changesFor(r, 'empty.ts').length >= 1);
          const [c] = changesFor(recs, 'empty.ts');
          if (c?.type === 'file.changed') {
            assert.equal(c.after.kind, 'content');
            if (c.after.kind === 'content') assert.equal(c.after.size, 0);
          }
        },
      );
    });

    it('emits an unavailable/oversize snapshot for a large file, never a fake blob', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'big.ts'), Buffer.alloc(64, 1));
          observe('big.ts');
          const recs = await waitFor((r) => changesFor(r, 'big.ts').length >= 1);
          const [c] = changesFor(recs, 'big.ts');
          if (c?.type === 'file.changed') {
            assert.equal(c.after.kind, 'unavailable');
            if (c.after.kind === 'unavailable') assert.equal(c.after.reason, 'oversize');
          } else {
            assert.fail('expected an oversize unavailable snapshot');
          }
        },
        { maxBytes: 16 },
      );
    });

    it('captures a binary file verbatim', async () => {
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);
      await withFakeSession(
        async () => {},
        async ({ root, session, observe, waitFor }) => {
          await writeFile(join(root, 'blob.bin'), bytes);
          observe('blob.bin');
          const recs = await waitFor((r) => changesFor(r, 'blob.bin').length >= 1);
          const [c] = changesFor(recs, 'blob.bin');
          if (c?.type === 'file.changed' && c.after.kind === 'content') {
            const stored = await readFile(join(session.blobsDir, 'sha256', c.after.sha256.slice(0, 2), c.after.sha256));
            assert.deepEqual(stored, bytes);
          } else {
            assert.fail('expected binary content');
          }
        },
      );
    });

    it('captures a file whose name merely starts with ".." rather than dropping it as an escape', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, '..notes.ts'), 'kept');
          observe('..notes.ts');
          const recs = await waitFor((r) => changesFor(r, '..notes.ts').length >= 1);
          assert.ok(changesFor(recs, '..notes.ts').length >= 1, 'a "..notes.ts" file must still be captured');
        },
      );
    });
  });

  describe('exclusions', () => {
    it('rejects a store directory that equals the watched root', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
      try {
        await assert.rejects(startCapture({ root, storeDir: root }), /store directory.*watched root/i);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects a store directory that contains the watched root', async () => {
      const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
      const root = join(store, 'worktree');
      await mkdir(root);
      try {
        await assert.rejects(startCapture({ root, storeDir: store }), /store directory.*watched root/i);
      } finally {
        await rm(store, { recursive: true, force: true });
      }
    });

    it('never captures the capture store even when it lives inside the watched root', async () => {
      // Store *inside* root is the case that matters: the exclusion is what stops
      // the watcher from observing its own log and blob writes. Verify both the
      // wiring (the store is handed to the observation source's ignore list) and
      // the behavior (a real file written inside the store is never captured,
      // while a real edit elsewhere in root is).
      const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
      const store = join(root, '.slipstream');
      const fake = createFakePlatform();
      let watchedIgnore: readonly string[] = [];
      const platform: Platform = {
        watch: async (o) => {
          watchedIgnore = o.ignore;
          return fake.watch(o);
        },
      };
      const session = await startCapture({ root, storeDir: store }, { platform });
      try {
        // session resolves symlinks in the store path (macOS /var -> /private/var),
        // so compare against the resolved form.
        const resolvedStore = await realpath(store);
        assert.ok(
          watchedIgnore.some((e) => e === resolvedStore || e.startsWith(resolvedStore + sep)),
          'the store directory must be handed to the watcher ignore list',
        );
        // A real blob inside the store: without the exclusion this would be read
        // and captured, so its absence from the log is a real signal, not a
        // vacuous one against a nonexistent path.
        const blobDir = join(store, 'blobs', 'sha256', 'ab');
        await mkdir(blobDir, { recursive: true });
        await writeFile(join(blobDir, 'deadbeef'), 'internal blob bytes');
        await writeFile(join(root, 'x.ts'), 'data');
        fake.observe(join('.slipstream', 'blobs', 'sha256', 'ab', 'deadbeef')); // store write: must be ignored
        fake.observe('x.ts');
        const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'x.ts').length >= 1);
        assert.ok(changesFor(recs, 'x.ts').length >= 1, 'a real edit inside root must be captured');
        assert.ok(
          recs.every((r) => !r.path.startsWith('.slipstream')),
          'no record may reference a path inside the capture store',
        );
      } finally {
        await session.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
