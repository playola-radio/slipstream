import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  publishTombstone, removeSessionHistory, sessionExists, reclaimUnreferencedBlobs,
} from './maintenance.ts';
import { readTombstone, blobPath, sessionLogPath, tombstonePath } from './store-reader.ts';
import { StorageError } from './storage.ts';
import { LogCorruptError } from './log-reader.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NEVER_ABORT = () => false;

const HEX_LIVE = 'a'.repeat(64);
const HEX_DEAD = 'b'.repeat(64);
const HEX_SHARED = 'c'.repeat(64);
const HEX_FUTURE = 'd'.repeat(64);

async function emptyStore(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'slip-maint-'));
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Write a session log of contiguous records; `removed` also drops a tombstone. */
async function writeSession(
  dir: string, id: string, records: Record<string, unknown>[], opts: { removed?: boolean } = {},
): Promise<void> {
  await mkdir(join(dir, 'sessions', id), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  await writeFile(sessionLogPath(dir, id), body, 'utf8');
  if (opts.removed) await writeFile(tombstonePath(dir, id), '{"version":1}', 'utf8');
}

function baselined(seq: number, sha: string): Record<string, unknown> {
  return {
    seq: String(seq), type: 'slipstream.file.baselined.v1',
    data: { session_id: A, path: `f${seq}`, snapshot: { kind: 'content', sha256: sha, size: 3 } },
  };
}

async function writeBlob(dir: string, hex: string): Promise<void> {
  const path = blobPath(dir, hex);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'xyz', 'utf8');
}

describe('maintenance: durable tombstone marker', () => {
  it('publishes removed.json = {"version":1} the reader validates', async () => {
    const dir = await emptyStore();
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    await publishTombstone(dir, A);
    assert.deepEqual(await readTombstone(dir, A), { version: 1 });
    assert.equal((await stat(tombstonePath(dir, A))).mode & 0o077, 0);
  });

  it('is idempotent: republishing over an existing marker still succeeds', async () => {
    const dir = await emptyStore();
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    await publishTombstone(dir, A);
    await publishTombstone(dir, A);
    assert.deepEqual(await readTombstone(dir, A), { version: 1 });
  });
});

describe('maintenance: history removal', () => {
  it('unlinks events.jsonl but preserves the tombstone and session dir', async () => {
    const dir = await emptyStore();
    await writeSession(dir, A, [baselined(1, HEX_LIVE)], { removed: true });
    await removeSessionHistory(dir, A);
    assert.equal(await exists(sessionLogPath(dir, A)), false);
    assert.equal(await exists(tombstonePath(dir, A)), true);
    assert.equal(await exists(join(dir, 'sessions', A)), true);
  });

  it('is a no-op when the history is already gone', async () => {
    const dir = await emptyStore();
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    await removeSessionHistory(dir, A); // must not throw on ENOENT
  });
});

describe('maintenance: sessionExists', () => {
  it('reports presence of the session dir', async () => {
    const dir = await emptyStore();
    assert.equal(await sessionExists(dir, A), false);
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    assert.equal(await sessionExists(dir, A), true);
  });
});

describe('maintenance: mark-and-sweep blob reclamation', () => {
  it('keeps blobs a retained session references and deletes the rest', async () => {
    const dir = await emptyStore();
    await writeSession(dir, A, [baselined(1, HEX_LIVE)]);
    await writeBlob(dir, HEX_LIVE);
    await writeBlob(dir, HEX_DEAD);
    const removed = await reclaimUnreferencedBlobs(dir, NEVER_ABORT);
    assert.equal(removed, 1);
    assert.equal(await exists(blobPath(dir, HEX_LIVE)), true);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), false);
  });

  it('does not let a removed session protect a blob', async () => {
    const dir = await emptyStore();
    // A removed session's history is gone (gc removes it before the sweep), so it
    // contributes no references. Model that end state: tombstone, no log.
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    await writeFile(tombstonePath(dir, A), '{"version":1}', 'utf8');
    await writeBlob(dir, HEX_DEAD);
    const removed = await reclaimUnreferencedBlobs(dir, NEVER_ABORT);
    assert.equal(removed, 1);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), false);
  });

  it('keeps a blob two retained sessions both reference', async () => {
    const dir = await emptyStore();
    await writeSession(dir, A, [baselined(1, HEX_SHARED)]); // both retained sessions
    await writeSession(dir, B, [baselined(1, HEX_SHARED)]); // reference the same blob
    await writeBlob(dir, HEX_SHARED);
    const removed = await reclaimUnreferencedBlobs(dir, NEVER_ABORT);
    assert.equal(removed, 0);
    assert.equal(await exists(blobPath(dir, HEX_SHARED)), true);
  });

  it('marks a content snapshot in any field (a future additive blob field is not swept)', async () => {
    const dir = await emptyStore();
    // A changed.v1 event carrying a content snapshot in a field this version does
    // not hard-code — nested, to lock the recursive walk. GC recognizes a blob
    // reference by the canonical content-snapshot shape wherever it appears, so a
    // future additive blob field is marked, never orphaned and swept.
    await writeSession(dir, A, [{
      seq: '1', type: 'slipstream.file.changed.v1',
      data: {
        session_id: A, path: 'f1',
        before: { kind: 'absent' },
        after: { kind: 'content', sha256: HEX_LIVE, size: 3 },
        meta: { origin: { kind: 'content', sha256: HEX_FUTURE, size: 3 } },
      },
    }]);
    await writeBlob(dir, HEX_LIVE);
    await writeBlob(dir, HEX_FUTURE);
    await writeBlob(dir, HEX_DEAD);
    const removed = await reclaimUnreferencedBlobs(dir, NEVER_ABORT);
    assert.equal(removed, 1);
    assert.equal(await exists(blobPath(dir, HEX_LIVE)), true);
    assert.equal(await exists(blobPath(dir, HEX_FUTURE)), true, 'a nested content snapshot is still marked');
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), false);
  });

  it('aborts (deletes nothing) when the log tail rewinds below its high-water', async () => {
    const dir = await emptyStore();
    // A physically-last record whose seq (1) is below an interior record (2): the
    // mark must read past the declared high-water, not stop at it, or record 2's
    // blob is missed and swept. Record 2 references HEX_DEAD; only reading to EOF
    // (and catching the rewind) keeps it.
    await writeSession(dir, A, [baselined(1, HEX_LIVE), baselined(2, HEX_DEAD), baselined(1, HEX_LIVE)]);
    await writeBlob(dir, HEX_DEAD);
    await assert.rejects(() => reclaimUnreferencedBlobs(dir, NEVER_ABORT), LogCorruptError);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), true, 'no blob deleted on a rewound-tail mark');
  });

  it('an incomplete mark phase (corrupt retained log) deletes nothing', async () => {
    const dir = await emptyStore();
    await mkdir(join(dir, 'sessions', A), { recursive: true });
    await writeFile(sessionLogPath(dir, A), 'not json\n', 'utf8');
    await writeBlob(dir, HEX_DEAD);
    await assert.rejects(() => reclaimUnreferencedBlobs(dir, NEVER_ABORT), LogCorruptError);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), true, 'no blob deleted on an aborted mark');
  });

  it('aborts (deletes nothing) on an unknown/newer event type', async () => {
    const dir = await emptyStore();
    await writeSession(dir, A, [{ seq: '1', type: 'slipstream.file.changed.v2', data: {} }]);
    await writeBlob(dir, HEX_DEAD);
    await assert.rejects(() => reclaimUnreferencedBlobs(dir, NEVER_ABORT), LogCorruptError);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), true);
  });

  it('aborts (deletes nothing) when a retained session log is missing', async () => {
    const dir = await emptyStore();
    await mkdir(join(dir, 'sessions', A), { recursive: true }); // dir but no events.jsonl, not removed
    await writeBlob(dir, HEX_DEAD);
    await assert.rejects(() => reclaimUnreferencedBlobs(dir, NEVER_ABORT), StorageError);
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), true);
  });

  it('stops deleting when the abort signal trips mid-sweep', async () => {
    const dir = await emptyStore();
    await writeBlob(dir, HEX_DEAD);
    await assert.rejects(
      () => reclaimUnreferencedBlobs(dir, () => true),
      StorageError,
    );
    assert.equal(await exists(blobPath(dir, HEX_DEAD)), true);
  });

  it('never touches a non-blob or misplaced file in the CAS tree', async () => {
    const dir = await emptyStore();
    const shard = join(dir, 'blobs', 'sha256', 'aa');
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, 'not-a-hash.tmp'), 'stray', 'utf8'); // not 64-hex: leave it
    const removed = await reclaimUnreferencedBlobs(dir, NEVER_ABORT);
    assert.equal(removed, 0);
    assert.equal(await exists(join(shard, 'not-a-hash.tmp')), true);
  });
});
