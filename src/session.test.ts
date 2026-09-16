import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { changesFor, withSession } from './test/helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('session', () => {
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
    it('never captures the capture store itself', async () => {
      await withSession(
        async () => {},
        async ({ root, waitFor }) => {
          await writeFile(join(root, 'x.ts'), 'data');
          const recs = await waitFor((r) => changesFor(r, 'x.ts').length >= 1);
          assert.ok(recs.every((r) => !r.path.includes('events.jsonl') && !r.path.includes('sha256')));
        },
      );
    });
  });
});
