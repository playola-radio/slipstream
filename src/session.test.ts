import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture, type CaptureSession } from './session.ts';
import type { LoggedRecord } from './log.ts';

async function readRecords(logPath: string): Promise<LoggedRecord[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoggedRecord);
}

async function waitForRecords(
  logPath: string,
  predicate: (recs: LoggedRecord[]) => boolean,
  timeoutMs = 8000,
): Promise<LoggedRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recs = await readRecords(logPath);
    if (predicate(recs)) return recs;
    if (Date.now() > deadline) return recs;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withSession(
  setup: (root: string) => Promise<void>,
  fn: (ctx: { root: string; session: CaptureSession; records: () => Promise<LoggedRecord[]>; waitFor: (p: (r: LoggedRecord[]) => boolean) => Promise<LoggedRecord[]> }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
  let session: CaptureSession | undefined;
  try {
    await setup(root);
    session = await startCapture({ root, storeDir: store });
    await fn({
      root,
      session,
      records: () => readRecords(session!.logPath),
      waitFor: (p) => waitForRecords(session!.logPath, p),
    });
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

const changesFor = (recs: LoggedRecord[], path: string) =>
  recs.filter((r) => r.type === 'file.changed' && r.path === path);

test('a dirty worktree is baselined: pre-existing content is not reported as a new edit', async () => {
  await withSession(
    async (root) => {
      await writeFile(join(root, 'existing.ts'), 'already here before attach');
    },
    async ({ root, waitFor }) => {
      // Touch a *different* file so we have a definite event to wait on, then
      // assert the pre-existing file produced no change record.
      await writeFile(join(root, 'trigger.ts'), 'new');
      const recs = await waitFor((r) => changesFor(r, 'trigger.ts').length >= 1);
      assert.equal(changesFor(recs, 'existing.ts').length, 0);
    },
  );
});

test('creating a file emits absent -> content', async () => {
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

test('modifying a baselined file emits content -> content with the new bytes', async () => {
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

test('deleting a file emits content -> absent', async () => {
  await withSession(
    async (root) => {
      await writeFile(join(root, 'doomed.ts'), 'bye');
    },
    async ({ root, waitFor }) => {
      await rm(join(root, 'doomed.ts'));
      const recs = await waitFor((r) => changesFor(r, 'doomed.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'absent'));
      const c = changesFor(recs, 'doomed.ts').at(-1);
      if (c?.type === 'file.changed') assert.equal(c.after.kind, 'absent');
      else assert.fail('expected a deletion');
    },
  );
});

test('an empty file is captured as a zero-byte content snapshot, not absent', async () => {
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

test('an atomic save (write-temp + rename) resolves to a change at the final path', async () => {
  await withSession(
    async (root) => {
      await writeFile(join(root, 'atomic.ts'), 'original');
    },
    async ({ root, waitFor }) => {
      const tmp = join(root, '.atomic.ts.tmp');
      await writeFile(tmp, 'rewritten atomically');
      await rename(tmp, join(root, 'atomic.ts'));
      const recs = await waitFor((r) =>
        changesFor(r, 'atomic.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'content' && c.after.size === 'rewritten atomically'.length),
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

test('an oversize file emits an unavailable/oversize snapshot, never a fake blob', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
  let session: CaptureSession | undefined;
  try {
    session = await startCapture({ root, storeDir: store, maxBytes: 16 });
    await writeFile(join(root, 'big.ts'), Buffer.alloc(64, 1));
    const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'big.ts').length >= 1);
    const [c] = changesFor(recs, 'big.ts');
    if (c?.type === 'file.changed') {
      assert.equal(c.after.kind, 'unavailable');
      if (c.after.kind === 'unavailable') assert.equal(c.after.reason, 'oversize');
    } else {
      assert.fail('expected an oversize unavailable snapshot');
    }
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test('rapid successive writes capture the correct endpoint and never a state that never existed', async () => {
  await withSession(
    async (root) => {
      await writeFile(join(root, 'hot.ts'), 'v0');
    },
    async ({ root, waitFor }) => {
      const { createHash } = await import('node:crypto');
      const sha = (s: string) => createHash('sha256').update(s).digest('hex');
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
      // The endpoint must be captured (intermediate loss is acceptable burst).
      assert.ok(changes.some((c) => c.type === 'file.changed' && c.after.kind === 'content' && c.after.sha256 === endpointSha));
      // Every recorded content must be a version we actually wrote — a torn
      // read fabricating a state that never existed would be a fatal defect.
      for (const c of changes) {
        if (c.type === 'file.changed' && c.after.kind === 'content') {
          assert.ok(writtenShas.has(c.after.sha256), `recorded a state that was never written: ${c.after.sha256}`);
        }
      }
    },
  );
});

test('a binary file is captured verbatim', async () => {
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

test('a file that becomes unreadable emits an unavailable/unreadable snapshot', async () => {
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
          changesFor(recs, 'secret.ts').some((c) => c.type === 'file.changed' && c.after.kind === 'unavailable' && c.after.reason === 'unreadable'),
        );
      } finally {
        await chmod(p, 0o644);
      }
    },
  );
});

test('the capture store is never itself captured', async () => {
  // storeDir lives outside root here, but assert no record ever references the
  // store path even if a nested layout is used.
  await withSession(
    async () => {},
    async ({ root, waitFor }) => {
      await writeFile(join(root, 'x.ts'), 'data');
      const recs = await waitFor((r) => changesFor(r, 'x.ts').length >= 1);
      assert.ok(recs.every((r) => !r.path.includes('events.jsonl') && !r.path.includes('sha256')));
    },
  );
});
