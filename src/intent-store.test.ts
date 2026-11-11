import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitCapture, emptyIntent, linkBinding } from './capture-intent.ts';
import { IntentCorruptError, intentPath, loadIntent, saveIntent, unlinkOffline, withdrawOffline } from './intent-store.ts';
import { acquireSessionLock, SessionOwnedError } from './lock.ts';

async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-intent-'));
  await chmod(dir, 0o700);
  return dir;
}

const capture = (n: number, root = `/w/${n}`) => ({ session_id: `s${n}`, root, root_identity: { dev: '1', ino: String(n) } });

describe('durable intent record', () => {
  it('reads an absent record as empty', async () => {
    assert.deepEqual(await loadIntent(await store()), emptyIntent());
  });

  it('round-trips through an owner-only file and leaves no temp files', async () => {
    const dir = await store();
    const record = emptyIntent();
    admitCapture(record, capture(1));
    linkBinding(record, { session_id: 's1', harness: 'codex', harness_session_id: 'c1', canonical_worktree: '/w/1',
      verified_transcript_path: '/t/1.jsonl' });
    await saveIntent(dir, record);
    assert.deepEqual(await loadIntent(dir), record);
    assert.equal((await stat(intentPath(dir))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'control'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(dir, 'control')), ['intent.json']);
  });

  it('refuses a record that is not JSON instead of resetting it', async () => {
    const dir = await store();
    await mkdir(join(dir, 'control'), { mode: 0o700 });
    await writeFile(intentPath(dir), '{"version":1,', { mode: 0o600 });
    await assert.rejects(loadIntent(dir), IntentCorruptError);
  });

  it('refuses a record from a newer Slipstream without suggesting it be moved aside', async () => {
    const dir = await store();
    await mkdir(join(dir, 'control'), { mode: 0o700 });
    await writeFile(intentPath(dir), JSON.stringify({ ...emptyIntent(), version: 2 }), { mode: 0o600 });
    await assert.rejects(loadIntent(dir), (err: Error) => /written by a newer Slipstream \(intent version 2; this one reads version 1\)/.test(err.message)
      && !/move the file aside/.test(err.message));
  });

  it('refuses an unknown version or a malformed entry', async () => {
    const dir = await store();
    await mkdir(join(dir, 'control'), { mode: 0o700 });
    await writeFile(intentPath(dir), JSON.stringify({ ...emptyIntent(), version: 0 }), { mode: 0o600 });
    await assert.rejects(loadIntent(dir), /unsupported version 0/);
    const bad = emptyIntent();
    admitCapture(bad, capture(1));
    (bad.captures[0] as { intent: string }).intent = 'paused';
    await writeFile(intentPath(dir), JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(loadIntent(dir), /captures\[0\]\.intent is unknown/);
  });

  it('loads a legacy waiting entry as paused', async () => {
    const dir = await store();
    const record = emptyIntent();
    admitCapture(record, capture(1));
    admitCapture(record, capture(2));
    Object.assign(record.captures[1]!, {
      intent: 'waiting',
      last_failure: { reason: 'watcher-failed', message: 'watch closed', at_ms: 1, next_attempt_at_ms: null },
    });
    await saveIntent(dir, record);
    const before = await readFile(intentPath(dir), 'utf8');

    const loaded = await loadIntent(dir);

    assert.deepEqual(loaded.captures, [
      { ...capture(1), intent: 'running', withdrawn_reason: null, capture_mode: 'watch-only', last_failure: null },
      { ...capture(2), intent: 'withdrawn', withdrawn_reason: 'detached', capture_mode: 'watch-only', last_failure: null },
    ]);
    assert.equal(await readFile(intentPath(dir), 'utf8'), before);
  });

  it('refuses a group-readable record', async () => {
    const dir = await store();
    await saveIntent(dir, emptyIntent());
    await chmod(intentPath(dir), 0o644);
    await assert.rejects(loadIntent(dir), (err: Error) => /group\/other-accessible/.test((err.cause as Error).message));
  });
});

describe('withdrawal while no daemon runs', () => {
  it('withdraws every entry at a root and revokes its binding', async () => {
    const dir = await store();
    const record = emptyIntent();
    for (let i = 0; i < 5; i++) admitCapture(record, capture(i));
    linkBinding(record, { session_id: 's3', harness: 'codex', harness_session_id: 'c3', canonical_worktree: '/w/3',
      verified_transcript_path: '/t/3.jsonl' });
    await saveIntent(dir, record);

    const result = await withdrawOffline(dir, { root: '/w/3' }, 'archived');

    assert.deepEqual(result, { withdrawn: ['s3'] });
    const after = await loadIntent(dir);
    assert.deepEqual(after.captures.find((c) => c.session_id === 's3'),
      { ...capture(3), intent: 'withdrawn', withdrawn_reason: 'archived', capture_mode: 'watch-only', last_failure: null });
    assert.equal(after.captures.filter((c) => c.intent === 'running').length, 4);
    assert.equal(after.bindings[0]?.intent, 'revoked');
  });

  it('is idempotent for an already-withdrawn target', async () => {
    const dir = await store();
    const record = emptyIntent();
    admitCapture(record, capture(1));
    await saveIntent(dir, record);
    await withdrawOffline(dir, { sessionId: 's1' }, 'detached');
    assert.deepEqual(await withdrawOffline(dir, { sessionId: 's1' }, 'archived'), { withdrawn: [] });
    assert.equal((await loadIntent(dir)).captures[0]?.withdrawn_reason, 'detached');
  });

  it('refuses a target with no recorded capture', async () => {
    await assert.rejects(withdrawOffline(await store(), { root: '/nowhere' }, 'archived'), /no capture is recorded for \/nowhere/);
  });

  it('refuses while a live process holds the store lock', async () => {
    const dir = await store();
    const record = emptyIntent();
    admitCapture(record, capture(1));
    await saveIntent(dir, record);
    const held = await acquireSessionLock(dir);
    try {
      await assert.rejects(withdrawOffline(dir, { sessionId: 's1' }, 'archived'), SessionOwnedError);
      assert.equal((await loadIntent(dir)).captures[0]?.intent, 'running');
    } finally {
      await held.release();
    }
  });

  it('revokes a binding while no daemon runs and reports when none is linked', async () => {
    const dir = await store();
    const record = emptyIntent();
    admitCapture(record, capture(1));
    linkBinding(record, { session_id: 's1', harness: 'codex', harness_session_id: 'c1', canonical_worktree: '/w/1',
      verified_transcript_path: '/t/1.jsonl' });
    await saveIntent(dir, record);
    assert.equal(await unlinkOffline(dir, 's1'), true);
    assert.equal((await loadIntent(dir)).bindings[0]?.intent, 'revoked');
    assert.equal(await unlinkOffline(dir, 's1'), false);
  });
});
