import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitCapture, emptyIntent, linkBinding } from './capture-intent.ts';
import { loadIntent, saveIntent } from './intent-store.ts';
import { acquireSessionLock } from './lock.ts';
import type { ResponseEnvelope } from './control-protocol.ts';
import { runUnlink, runWithdraw, type WithdrawDeps } from './withdraw-workflow.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const DOWN: ResponseEnvelope = { v: 1, ok: false, code: 'DAEMON_UNAVAILABLE', message: 'no daemon' };

async function seeded(): Promise<{ store: string; root: string }> {
  const store = await mkdtemp(join(tmpdir(), 'slip-withdraw-'));
  await chmod(store, 0o700);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slip-withdraw-wt-')));
  const record = emptyIntent();
  admitCapture(record, { session_id: ID, root, root_identity: null });
  linkBinding(record, { session_id: ID, harness: 'codex', harness_session_id: 'c1', canonical_worktree: root,
    verified_transcript_path: '/t/c1.jsonl' });
  await saveIntent(store, record);
  return { store, root };
}

function deps(store: string, control: WithdrawDeps['control']): WithdrawDeps & { printed: string[]; warned: string[] } {
  const printed: string[] = [];
  const warned: string[] = [];
  let clock = 0;
  return { store, control, printed, warned, now: () => clock, sleep: async (ms) => { clock += ms; },
    out: (line) => printed.push(line), err: (line) => warned.push(line) };
}

describe('withdrawing a capture', () => {
  it('reports the daemon\'s answer when it is running', async () => {
    const { store } = await seeded();
    const d = deps(store, async () => ({ v: 1, ok: true, session_id: ID, state: 'stopped', reason: 'detached' }));
    assert.equal(await runWithdraw({ target: ID, reason: 'detached' }, d), 0);
    assert.deepEqual(d.printed, ['session_id: ' + ID, 'state: stopped', 'reason: detached']);
    assert.equal((await loadIntent(store)).captures[0]?.intent, 'running');
  });

  it('records the withdrawal itself while no daemon runs, and says the stop is unconfirmed', async () => {
    const { store, root } = await seeded();
    const d = deps(store, async () => DOWN);
    assert.equal(await runWithdraw({ target: root, reason: 'archived' }, d), 0);
    const after = await loadIntent(store);
    assert.equal(after.captures[0]?.intent, 'withdrawn');
    assert.equal(after.captures[0]?.withdrawn_reason, 'archived');
    assert.equal(after.bindings[0]?.intent, 'revoked');
    assert.deepEqual(d.printed.slice(0, 3), ['session_id: ' + ID, 'state: not_recording', 'reason: stop-unconfirmed']);
    assert.match(d.printed.join('\n'), /no daemon is running; the withdrawal is recorded and will not be resumed/);
  });

  it('resolves a symlinked workspace path to its recorded root offline', async () => {
    const { store, root } = await seeded();
    const link = join(await mkdtemp(join(tmpdir(), 'slip-withdraw-ln-')), 'ws');
    await symlink(root, link);
    assert.equal(await runWithdraw({ target: link, reason: 'detached' }, deps(store, async () => DOWN)), 0);
    assert.equal((await loadIntent(store)).captures[0]?.intent, 'withdrawn');
  });

  it('refuses a target nothing is recorded for', async () => {
    const { store } = await seeded();
    const d = deps(store, async () => DOWN);
    assert.equal(await runWithdraw({ target: '/nowhere', reason: 'detached' }, d), 1);
    assert.match(d.warned.join('\n'), /no capture is recorded for \/nowhere/);
  });

  it('retries over the socket when a daemon holds the store lock while it starts', async () => {
    const { store } = await seeded();
    const lock = await acquireSessionLock(store);
    let calls = 0;
    const d = deps(store, async () => {
      calls++;
      if (calls < 3) return DOWN;
      await lock.release();
      return { v: 1, ok: true, session_id: ID, state: 'stopped', reason: 'detached' };
    });
    assert.equal(await runWithdraw({ target: ID, reason: 'detached' }, d), 0);
    assert.equal(calls, 3);
    assert.equal((await loadIntent(store)).captures[0]?.intent, 'running');
  });

  it('gives up readably when the store stays locked and no daemon answers', async () => {
    const { store } = await seeded();
    const lock = await acquireSessionLock(store);
    try {
      const d = deps(store, async () => DOWN);
      assert.equal(await runWithdraw({ target: ID, reason: 'detached' }, d), 1);
      assert.match(d.warned.join('\n'), /is locked by another process, but no daemon answers/);
    } finally {
      await lock.release();
    }
  });
});

describe('unlinking a chat', () => {
  it('revokes the binding itself while no daemon runs', async () => {
    const { store } = await seeded();
    const d = deps(store, async () => DOWN);
    assert.equal(await runUnlink({ sessionId: ID }, d), 0);
    assert.equal((await loadIntent(store)).bindings[0]?.intent, 'revoked');
    assert.match(d.printed.join('\n'), /no daemon is running; the unlink is recorded/);
    assert.equal(await runUnlink({ sessionId: ID }, d), 0);
    assert.match(d.printed.at(-1)!, /already_unlinked: true/);
  });
});
