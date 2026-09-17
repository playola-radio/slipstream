/**
 * Real-OS tier for capture. Excluded from `npm test`; run with `npm run test:os`
 * on a developer Mac. These assert the platform-dependent claims the fake cannot
 * prove — that real FSEvents actually delivers the change, that real permission
 * transitions are observed, and that rapid real writes still land the correct
 * endpoint. A failure here is a real capture gap on the supported platform, and
 * (per the honesty constraints) must not be papered over.
 *
 * Note the permission tests assume an UNPRIVILEGED user: root bypasses mode bits,
 * so `chmod 0o000` would not deny it. That is the environmental prerequisite for
 * this tier, not a reason to weaken the assertion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { changesFor, withSession } from './test/helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('session (real OS)', () => {
  it('emits absent -> content when a file is created (real FSEvents delivery)', async () => {
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

  it('records a baseline-unreadable gap and never fabricates absent for a file under it', async () => {
    await withSession(
      async (root) => {
        const locked = join(root, 'locked');
        await mkdir(locked);
        await writeFile(join(locked, 'existing.ts'), 'pre-existing');
        await chmod(locked, 0o000); // unreadable when the baseline scan reaches it
      },
      async ({ root, waitFor }) => {
        const locked = join(root, 'locked');
        try {
          const gapRecs = await waitFor((r) =>
            r.some((x) => x.type === 'capture.gap' && x.reason === 'baseline-unreadable' && x.path === 'locked'),
          );
          assert.ok(
            gapRecs.some((x) => x.type === 'capture.gap' && x.reason === 'baseline-unreadable' && x.path === 'locked'),
            'expected a baseline-unreadable gap for the locked directory',
          );
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
            changesFor(r, 'secret.ts').some(
              (c) => c.type === 'file.changed' && c.after.kind === 'unavailable' && c.after.reason === 'unreadable',
            ),
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
