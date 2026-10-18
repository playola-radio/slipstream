import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import fsp, { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startCapture, type CaptureSession } from './session.ts';
import { createCas } from './cas.ts';
import { createFakePlatform } from './test/fake-platform.ts';

// Counting tests: each one counts operations, never time.

async function withTempPair(fn: (root: string, store: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-cwt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-cst-'));
  try {
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

/** Every blob file in the store, keyed by name, with its inode. */
async function blobInodes(store: string): Promise<Map<string, number>> {
  const base = join(store, 'blobs', 'sha256');
  const out = new Map<string, number>();
  for (const shard of await readdir(base)) {
    for (const name of await readdir(join(base, shard))) {
      out.set(name, (await stat(join(base, shard, name))).ino);
    }
  }
  return out;
}

/** Count fsyncs of open files whose inode is in `inodes`, while `fn` runs. */
async function countFileSyncs(inodes: Set<number>, fn: () => Promise<void>): Promise<number> {
  const probe = await open(import.meta.filename, 'r');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void>; datasync: () => Promise<void> };
  await probe.close();
  let count = 0;
  const counting = (original: () => Promise<void>) =>
    function (this: { fd: number }) {
      if (inodes.has(fstatSync(this.fd).ino)) count += 1;
      return original.call(this);
    };
  const sync = mock.method(proto, 'sync', counting(proto.sync));
  const datasync = mock.method(proto, 'datasync', counting(proto.datasync));
  try {
    await fn();
  } finally {
    sync.mock.restore();
    datasync.mock.restore();
  }
  return count;
}

async function seedWorktree(root: string): Promise<void> {
  await mkdir(join(root, 'src'));
  for (let i = 0; i < 20; i++) await writeFile(join(root, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
}

describe('counting: starting a capture over blobs already in the store', () => {
  it('a new capture publishes no new blobs and fsyncs no blob files', async () => {
    await withTempPair(async (root, store) => {
      await seedWorktree(root);
      const first = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
      await first.stop();
      const before = await blobInodes(store);
      assert.ok(before.size >= 20);

      const syncs = await countFileSyncs(new Set(before.values()), async () => {
        const second = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
        await second.stop();
      });

      assert.deepEqual(await blobInodes(store), before);
      assert.equal(syncs, 0);
    });
  });

  it('resuming a capture publishes no new blobs and fsyncs no blob files', async () => {
    await withTempPair(async (root, store) => {
      await seedWorktree(root);
      const first = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
      const sessionId = first.sessionId;
      await first.stop();
      const before = await blobInodes(store);

      const syncs = await countFileSyncs(new Set(before.values()), async () => {
        const resumed = await startCapture(
          { root, storeDir: store, resumeSessionId: sessionId },
          { platform: createFakePlatform() },
        );
        await resumed.stop();
      });

      assert.deepEqual(await blobInodes(store), before);
      assert.equal(syncs, 0);
    });
  });
});

/** Count, while `fn` runs, worktree listings and content reads under `root`
 * and every git process spawned. Builtin module exports are patched in place
 * so the capture's own imports see the counting versions. */
async function countWorktreeWork(root: string, fn: () => Promise<void>): Promise<{ listings: number; reads: number; git: number }> {
  const counts = { listings: 0, reads: 0, git: 0 };
  root = await fsp.realpath(root); // the capture works on the real path
  const under = (p: unknown) => typeof p === 'string' && (p === root || p.startsWith(`${root}/`));
  const fsCounter = (key: 'listings' | 'reads', original: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...a: unknown[]) {
      if (under(a[0])) counts[key] += 1;
      return original.apply(this, a);
    };
  const gitCounter = (original: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...a: unknown[]) {
      if (a[0] === 'git') counts.git += 1;
      return original.apply(this, a);
    };
  const fsMod = fsp as unknown as Record<string, (...a: unknown[]) => unknown>;
  const cpMod = childProcess as unknown as Record<string, (...a: unknown[]) => unknown>;
  const mocks = [
    mock.method(fsMod, 'readdir', fsCounter('listings', fsMod.readdir!)),
    mock.method(fsMod, 'opendir', fsCounter('listings', fsMod.opendir!)),
    // Every content read starts with an lstat of the file; the reader keeps its own `open`.
    mock.method(fsMod, 'lstat', fsCounter('reads', fsMod.lstat!)),
    mock.method(fsMod, 'open', fsCounter('reads', fsMod.open!)),
    mock.method(fsMod, 'readFile', fsCounter('reads', fsMod.readFile!)),
    mock.method(cpMod, 'spawn', gitCounter(cpMod.spawn!)),
    mock.method(cpMod, 'execFile', gitCounter(cpMod.execFile!)),
  ];
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
  return counts;
}

async function changedPaths(session: CaptureSession): Promise<string[]> {
  const text = await readFile(session.logPath, 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: { path?: string } })
    .filter((e) => e.type === 'slipstream.file.changed.v1').map((e) => e.data.path!);
}

async function waitForChange(session: CaptureSession, path: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await changedPaths(session)).includes(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`${path} never appeared as a change`);
}

function gitWorktree(root: string): void {
  execFileSync('git', ['init', '-q', root]);
}

describe('counting: an idle capture', () => {
  it('makes no worktree listings, content reads or git spawns once settled', async () => {
    await withTempPair(async (root, store) => {
      gitWorktree(root);
      await seedWorktree(root);
      const platform = createFakePlatform();
      const session = await startCapture({ root, storeDir: store }, { platform });
      try {
        // Settle: one ordinary change goes through classification and capture.
        await writeFile(join(root, 'src', 'f0.ts'), 'export const v0 = 100;\n');
        platform.observe('src/f0.ts');
        await waitForChange(session, 'src/f0.ts');

        // Longer than every periodic timer a capture runs (the lock heartbeat).
        const idle = await countWorktreeWork(root, () => new Promise((r) => setTimeout(r, 2_500)));
        assert.deepEqual(idle, { listings: 0, reads: 0, git: 0 });

        // The counters do see a capture's work: one change reads and asks git.
        const busy = await countWorktreeWork(root, async () => {
          await writeFile(join(root, 'src', 'f1.ts'), 'export const v1 = 100;\n');
          platform.observe('src/f1.ts');
          await waitForChange(session, 'src/f1.ts');
        });
        assert.ok(busy.reads > 0 && busy.git > 0, JSON.stringify(busy));
      } finally {
        await session.stop();
      }
    });
  });
});

describe('counting: writes beside a baseline', () => {
  it('every write to a live capture appears as a change while another capture baselines', async () => {
    const dirs = await Promise.all(['a', 'b', 'big', 'store'].map((n) => mkdtemp(join(tmpdir(), `slip-cb-${n}-`))));
    const [rootA, rootB, rootBig, store] = dirs as [string, string, string, string];
    const sessions: CaptureSession[] = [];
    try {
      for (const root of [rootA, rootB, rootBig]) await seedWorktree(root);
      const cas = await createCas(join(store, 'blobs'));
      const live = [];
      for (const root of [rootA, rootB]) {
        const platform = createFakePlatform();
        const session = await startCapture({ root, storeDir: store, cas }, { platform });
        sessions.push(session);
        live.push({ root, platform, session });
      }

      // The third capture's baseline lists its first file, then waits for the release.
      let reached!: () => void;
      const inBaseline = new Promise<void>((r) => { reached = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const holding = startCapture({ root: rootBig, storeDir: store, cas }, {
        platform: createFakePlatform(),
        enumerate: async (root, dir, isExcluded, handlers) => {
          const walk = async (d: string): Promise<void> => {
            for (const entry of await readdir(d, { withFileTypes: true })) {
              const abs = join(d, entry.name);
              if (isExcluded(abs) || entry.isSymbolicLink()) continue;
              if (entry.isDirectory()) await walk(abs);
              else if (entry.isFile()) {
                await handlers.onFile(relative(root, abs));
                reached();
                await released;
              }
            }
          };
          await walk(dir);
        },
      });
      await inBaseline;

      const written: Array<{ session: CaptureSession; path: string }> = [];
      for (let i = 0; i < 5; i++) {
        for (const { root, platform, session } of live) {
          const path = `src/new${i}.ts`;
          await writeFile(join(root, path), `export const n${i} = ${i};\n`);
          platform.observe(path);
          written.push({ session, path });
        }
      }
      for (const { session, path } of written) await waitForChange(session, path);

      release();
      sessions.push(await holding);
      for (const { session } of live) {
        const changed = await changedPaths(session);
        for (let i = 0; i < 5; i++) assert.ok(changed.includes(`src/new${i}.ts`), `src/new${i}.ts in ${session.sessionId}`);
      }
    } finally {
      await Promise.all(sessions.map((s) => s.stop()));
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });
});
