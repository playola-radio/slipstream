import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessContext, isResolved, type IdentityResult } from './harness-context.ts';
import { claudeIdentity } from './harness-context/claude.ts';
import { codexIdentity } from './harness-context/codex.ts';

function unresolvedReason(r: IdentityResult): string {
  assert.equal(isResolved(r), false);
  return (r as { unresolved: string }).unresolved;
}

// ---- Claude adapter ---------------------------------------------------------

test('claude adapter resolves the env triple, canonicalizing the worktree', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'slip-claude-')));
  try {
    const r = claudeIdentity({ CLAUDE_CODE_SESSION_ID: 'sid-1', CLAUDE_PROJECT_DIR: dir });
    assert.deepEqual(r, { harness: 'claude-code', harness_session_id: 'sid-1', worktree: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claude adapter resolves a symlinked project dir to its real path', async () => {
  const real = await realpath(await mkdtemp(join(tmpdir(), 'slip-claude-real-')));
  const link = join(await realpath(await mkdtemp(join(tmpdir(), 'slip-claude-link-'))), 'wt');
  await symlink(real, link);
  try {
    const r = claudeIdentity({ CLAUDE_CODE_SESSION_ID: 'sid-2', CLAUDE_PROJECT_DIR: link });
    assert.equal(isResolved(r) && r.worktree, real);
  } finally {
    await rm(real, { recursive: true, force: true });
    await rm(link, { force: true });
  }
});

test('claude adapter fails closed when the session id is absent', () => {
  const r = claudeIdentity({ CLAUDE_PROJECT_DIR: '/tmp' });
  assert.match(unresolvedReason(r), /CLAUDE_CODE_SESSION_ID/);
});

test('claude adapter fails closed when the project dir is absent', () => {
  const r = claudeIdentity({ CLAUDE_CODE_SESSION_ID: 'sid' });
  assert.match(unresolvedReason(r), /CLAUDE_PROJECT_DIR/);
});

test('claude adapter fails closed on an empty-string session id', () => {
  const r = claudeIdentity({ CLAUDE_CODE_SESSION_ID: '', CLAUDE_PROJECT_DIR: '/tmp' });
  assert.match(unresolvedReason(r), /CLAUDE_CODE_SESSION_ID/);
});

test('claude adapter fails closed on a relative project dir (cwd is never a binding input)', () => {
  const r = claudeIdentity({ CLAUDE_CODE_SESSION_ID: 'sid', CLAUDE_PROJECT_DIR: 'relative/project' });
  assert.match(unresolvedReason(r), /absolute/);
});

// ---- Codex adapter ----------------------------------------------------------

function codexParams(over: { threadId?: unknown; workspaces?: unknown } = {}): unknown {
  return {
    name: 'slipstream_begin_task',
    arguments: { title: 'x' },
    _meta: {
      threadId: 'threadId' in over ? over.threadId : '01a0b5ad-thread',
      'x-codex-turn-metadata': {
        thread_id: 'threadId' in over ? over.threadId : '01a0b5ad-thread',
        workspaces:
          'workspaces' in over
            ? over.workspaces
            : { '/Users/x/porto-v3': { origin: 'slipstream.git', commit: '7fe3f38' } },
      },
    },
  };
}

test('codex adapter binds threadId + the single workspaces key', () => {
  const r = codexIdentity(codexParams());
  assert.deepEqual(r, { harness: 'codex', harness_session_id: '01a0b5ad-thread', worktree: '/Users/x/porto-v3' });
});

test('codex adapter fails closed when _meta is absent', () => {
  const r = codexIdentity({ name: 'slipstream_begin_task', arguments: {} });
  assert.match(unresolvedReason(r), /_meta/);
});

test('codex adapter fails closed when threadId is absent', () => {
  const r = codexIdentity(codexParams({ threadId: undefined }));
  assert.match(unresolvedReason(r), /threadId/);
});

test('codex adapter fails closed on an empty workspaces map (root ambiguous)', () => {
  const r = codexIdentity(codexParams({ workspaces: {} }));
  assert.match(unresolvedReason(r), /workspaces/);
});

test('codex adapter fails closed on more than one workspaces key (ambiguous root)', () => {
  const r = codexIdentity(codexParams({ workspaces: { '/a': {}, '/b': {} } }));
  assert.match(unresolvedReason(r), /2 roots|ambiguous/);
});

test('codex adapter fails closed on an array workspaces value (a numeric index is not a root)', () => {
  const r = codexIdentity(codexParams({ workspaces: [{}] }));
  assert.equal(isResolved(r), false);
});

test('codex adapter fails closed on a relative workspace key (cwd is never a binding input)', () => {
  const r = codexIdentity(codexParams({ workspaces: { '.': {} } }));
  assert.match(unresolvedReason(r), /absolute/);
});

// ---- Dispatch by clientInfo -------------------------------------------------

test('context dispatches to the claude adapter at initialize, ignoring per-call params', () => {
  const ctx = createHarnessContext();
  ctx.initialize({ name: 'claude-code', version: '2.1.272' }, { CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PROJECT_DIR: '/tmp' });
  const r = ctx.identityForCall({ _meta: { threadId: 'ignored' } });
  assert.equal(isResolved(r) && r.harness, 'claude-code');
});

test('context dispatches to the codex adapter, deriving identity per call', () => {
  const ctx = createHarnessContext();
  ctx.initialize({ name: 'codex-mcp-client', version: '0.154.0' }, {});
  const r = ctx.identityForCall(codexParams());
  assert.equal(isResolved(r) && r.harness, 'codex');
});

test('context fails closed for an unrecognized client', () => {
  const ctx = createHarnessContext();
  ctx.initialize({ name: 'some-other-client' }, {});
  assert.match(unresolvedReason(ctx.identityForCall({})), /unrecognized harness/);
});

test('context fails closed before initialize', () => {
  const ctx = createHarnessContext();
  assert.match(unresolvedReason(ctx.identityForCall({})), /not initialized/);
});
