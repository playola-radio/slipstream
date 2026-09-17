import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import type { Log } from './log.ts';
import { changesFor, waitForRecords, withSession } from './test/helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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
      await withSession(
        async (root) => {
          await writeFile(join(root, 'existing.ts'), 'already here before attach');
        },
        async ({ root, waitFor }) => {
          // Touch a different file to get a definite event, then assert the
          // pre-existing file produced no change record.
          await writeFile(join(root, 'trigger.ts'), 'new');
          const recs = await waitFor((r) => changesFor(r, 'trigger.ts').length >= 1);
          assert.equal(changesFor(recs, 'existing.ts').length, 0);
        },
      );
    });

    it('records a baseline-unreadable gap and never fabricates absent for a file under it', async () => {
      await withSession(
        async (root) => {
          const locked = join(root, 'locked');
          await mkdir(locked);
          await writeFile(join(locked, 'existing.ts'), 'pre-existing'); // baselined? no — dir is locked
          await chmod(locked, 0o000); // unreadable when the baseline scan reaches it
        },
        async ({ root, waitFor }) => {
          const locked = join(root, 'locked');
          try {
            // The scan discloses the incomplete baseline as a gap...
            const gapRecs = await waitFor((r) =>
              r.some((x) => x.type === 'capture.gap' && x.reason === 'baseline-unreadable' && x.path === 'locked'),
            );
            assert.ok(
              gapRecs.some((x) => x.type === 'capture.gap' && x.reason === 'baseline-unreadable' && x.path === 'locked'),
              'expected a baseline-unreadable gap for the locked directory',
            );
            // ...and once the file becomes observable and changes, its prior
            // state is honestly unknown, never a fabricated "absent" that would
            // imply the pre-existing file was newly created.
            await chmod(locked, 0o755);
            await writeFile(join(locked, 'existing.ts'), 'changed after restore');
            const recs = await waitFor((r) => changesFor(r, join('locked', 'existing.ts')).length >= 1);
            const [c] = changesFor(recs, join('locked', 'existing.ts'));
            assert.equal(c?.type, 'file.changed');
            if (c?.type === 'file.changed') {
              assert.equal(c.before.kind, 'unavailable');
              if (c.before.kind === 'unavailable') assert.equal(c.before.reason, 'baseline-unknown');
              assert.equal(c.after.kind, 'content');
            }
          } finally {
            await chmod(locked, 0o755); // restore so cleanup can remove it
          }
        },
      );
    });
  });

  describe('capture', () => {
    it('emits absent -> content when a file is created', async () => {
      await withSession(
        async () => {},
        async ({ root, waitFor }) => {
          await writeFile(join(root, 'created.ts'), 'hello world');
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
      await withSession(
        async (root) => {
          await writeFile(join(root, 'f.ts'), 'v1');
        },
        async ({ root, session, waitFor }) => {
          await writeFile(join(root, 'f.ts'), 'v2-changed');
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
      await withSession(
        async (root) => {
          await writeFile(join(root, 'doomed.ts'), 'bye');
        },
        async ({ root, waitFor }) => {
          await rm(join(root, 'doomed.ts'));
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
      await withSession(
        async () => {},
        async ({ root, waitFor }) => {
          await writeFile(join(root, 'empty.ts'), '');
          const recs = await waitFor((r) => changesFor(r, 'empty.ts').length >= 1);
          const [c] = changesFor(recs, 'empty.ts');
          if (c?.type === 'file.changed') {
            assert.equal(c.after.kind, 'content');
            if (c.after.kind === 'content') assert.equal(c.after.size, 0);
          }
        },
      );
    });

    it('resolves an atomic save (write-temp + rename) to a change at the final path', async () => {
      await withSession(
        async (root) => {
          await writeFile(join(root, 'atomic.ts'), 'original');
        },
        async ({ root, waitFor }) => {
          const tmp = join(root, '.atomic.ts.tmp');
          await writeFile(tmp, 'rewritten atomically');
          await rename(tmp, join(root, 'atomic.ts'));
          const recs = await waitFor((r) =>
            changesFor(r, 'atomic.ts').some(
              (c) => c.type === 'file.changed' && c.after.kind === 'content' && c.after.size === 'rewritten atomically'.length,
            ),
          );
          const c = changesFor(recs, 'atomic.ts').at(-1);
          if (c?.type === 'file.changed' && c.after.kind === 'content') {
            assert.equal(c.after.size, 'rewritten atomically'.length);
          } else {
            assert.fail('expected the rewritten content at the final path');
          }
        },
      );
    });

    it('emits an unavailable/oversize snapshot for a large file, never a fake blob', async () => {
      await withSession(
        async () => {},
        async ({ root, waitFor }) => {
          await writeFile(join(root, 'big.ts'), Buffer.alloc(64, 1));
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

    it('captures the correct endpoint under rapid writes and never a state that never existed', async () => {
      await withSession(
        async (root) => {
          await writeFile(join(root, 'hot.ts'), 'v0');
        },
        async ({ root, waitFor }) => {
          const writtenShas = new Set<string>([sha('v0')]);
          for (let i = 1; i <= 25; i++) {
            const body = `version-${i}`;
            writtenShas.add(sha(body));
            await writeFile(join(root, 'hot.ts'), body);
          }
          const endpointSha = sha('version-25');
          const recs = await waitFor((r) =>
            changesFor(r, 'hot.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'content' && c.after.sha256 === endpointSha),
          );
          const changes = changesFor(recs, 'hot.ts');
          assert.ok(changes.some((c) => c.type === 'file.changed' && c.after.kind === 'content' && c.after.sha256 === endpointSha));
          // A torn read fabricating a state that was never written would be fatal.
          for (const c of changes) {
            if (c.type === 'file.changed' && c.after.kind === 'content') {
              assert.ok(writtenShas.has(c.after.sha256), `recorded a state that was never written: ${c.after.sha256}`);
            }
          }
        },
      );
    });

    it('captures a binary file verbatim', async () => {
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);
      await withSession(
        async () => {},
        async ({ root, session, waitFor }) => {
          await writeFile(join(root, 'blob.bin'), bytes);
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
      await withSession(
        async () => {},
        async ({ root, waitFor }) => {
          await writeFile(join(root, '..notes.ts'), 'kept');
          const recs = await waitFor((r) => changesFor(r, '..notes.ts').length >= 1);
          assert.ok(changesFor(recs, '..notes.ts').length >= 1, 'a "..notes.ts" file must still be captured');
        },
      );
    });

    it('emits an unavailable/unreadable snapshot when a file becomes unreadable', async () => {
      await withSession(
        async (root) => {
          await writeFile(join(root, 'secret.ts'), 'readable');
        },
        async ({ root, waitFor }) => {
          const p = join(root, 'secret.ts');
          await writeFile(p, 'about to lock');
          await chmod(p, 0o000);
          try {
            const recs = await waitFor((r) =>
              changesFor(r, 'secret.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'unavailable'),
            );
            assert.ok(
              changesFor(recs, 'secret.ts').some(
                (c) => c.type === 'file.changed' && c.after.kind === 'unavailable' && c.after.reason === 'unreadable',
              ),
            );
          } finally {
            await chmod(p, 0o644);
          }
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
      // Store *inside* root is the case that matters: the exclusion is what
      // stops the watcher from observing its own log and blob writes. A store
      // outside root would pass trivially.
      const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
      const store = join(root, '.slipstream');
      const session = await startCapture({ root, storeDir: store });
      try {
        await writeFile(join(root, 'x.ts'), 'data');
        const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'x.ts').length >= 1);
        // The real edit is captured...
        assert.ok(changesFor(recs, 'x.ts').length >= 1, 'a real edit inside root must be captured');
        // ...and the store's own writes (log + blobs) never appear as changes.
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
