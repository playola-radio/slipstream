import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeSlug,
  discoverClaude,
  discoverCodex,
  isWithinRoot,
  type DiscoveryIO,
  type ListResult,
} from './discovery.ts';

const ROOT = '/work/proj';

function io(overrides: Partial<DiscoveryIO>): DiscoveryIO {
  return {
    listDir: async (): Promise<ListResult> => ({ ok: true, paths: [] }),
    listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: false }),
    readFirstLine: async () => ({ ok: false, reason: 'empty' }),
    realpath: async (p) => p,
    ...overrides,
  };
}

describe('transcript discovery', () => {
  it('derives the Claude slug from the worktree path', () => {
    assert.equal(claudeSlug('/work/proj'), '-work-proj');
    assert.equal(claudeSlug('/Users/x/repo'), '-Users-x-repo');
  });

  it('recognizes paths within the root', () => {
    assert.equal(isWithinRoot(ROOT, ROOT), true);
    assert.equal(isWithinRoot(ROOT, '/work/proj/pkg'), true);
    assert.equal(isWithinRoot(ROOT, '/work/other'), false);
    assert.equal(isWithinRoot(ROOT, '/work'), false);
  });

  it('binds each Claude session file in the slug dir to its session id', async () => {
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const result = await discoverClaude(
      io({
        listDir: async (d): Promise<ListResult> =>
          d === dir
            ? { ok: true, paths: [`${dir}/sess-a.jsonl`, `${dir}/sess-b.jsonl`] }
            : { ok: false, reason: 'missing' },
      }),
      '/home',
      ROOT,
    );
    assert.deepEqual(
      result.bindings.map((b) => b.ctx.harnessSessionId),
      ['sess-a', 'sess-b'],
    );
    assert.equal(result.bindings[0]!.ctx.cwd, ROOT);
    assert.equal(result.issues.length, 0);
  });

  it('reports a missing Claude project dir as an issue, not an empty success', async () => {
    const result = await discoverClaude(
      io({ listDir: async (): Promise<ListResult> => ({ ok: false, reason: 'missing' }) }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues[0]!.kind, 'missing');
  });

  it('filters Codex sessions by canonical cwd within the root', async () => {
    const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
    const heads = new Map<string, string>([
      ['/c/a.jsonl', meta('thread-a', '/work/proj')],
      ['/c/b.jsonl', meta('thread-b', '/work/proj/pkg')],
      ['/c/c.jsonl', meta('thread-c', '/work/other')],
      ['/c/d.jsonl', 'not json'],
    ]);
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: [...heads.keys()], truncated: false, incomplete: false }),
        readFirstLine: async (p) => {
          const line = heads.get(p);
          return line !== undefined ? { ok: true as const, line } : { ok: false as const, reason: 'empty' as const };
        },
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
      1000,
    );
    assert.deepEqual(
      result.bindings.map((b) => b.ctx.harnessSessionId).sort(),
      ['thread-a', 'thread-b'],
    );
    const b = result.bindings.find((x) => x.ctx.harnessSessionId === 'thread-b')!;
    assert.equal(b.ctx.cwd, '/work/proj/pkg');
    // The unparseable head ('/c/d.jsonl') is disclosed, never silently skipped.
    assert.ok(result.issues.some((i) => i.kind === 'malformed' && i.detail.includes('/c/d.jsonl')));
  });

  it('discloses discovery-limited when the Codex scan is truncated', async () => {
    const result = await discoverCodex(
      io({ listTreeJsonl: async () => ({ paths: [], truncated: true, incomplete: false }) }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.issues[0]!.kind, 'discovery-limited');
  });

  it('discloses an unreadable Codex subdirectory as inaccessible', async () => {
    const result = await discoverCodex(
      io({ listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: true }) }),
      '/home',
      ROOT,
      10,
    );
    assert.ok(result.issues.some((i) => i.kind === 'inaccessible'));
  });

  it('discloses an unreadable or empty Codex head instead of skipping it', async () => {
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/x.jsonl', '/c/y.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async (p) =>
          p === '/c/x.jsonl'
            ? { ok: false as const, reason: 'inaccessible' as const }
            : { ok: false as const, reason: 'empty' as const },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/c/x.jsonl')));
    assert.ok(result.issues.some((i) => i.kind === 'malformed' && i.detail.includes('/c/y.jsonl')));
  });

  it('records a non-canonical Codex cwd as a root alias for path relativization', async () => {
    // The recorded cwd resolves (realpath) to a path inside the canonical root,
    // but is itself a different string — a symlinked-ancestor alias.
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-z', cwd: '/alias/proj' } });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/z.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/alias/proj' ? ROOT : p),
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0]!.ctx.cwd, ROOT);
    assert.deepEqual(result.bindings[0]!.ctx.rootAliases, ['/alias/proj']);
  });

  it('skips a Codex session whose cwd no longer resolves, without an issue', async () => {
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-dead', cwd: '/gone' } });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/dead.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('discloses an in-root Codex cwd that no longer resolves, instead of hiding it', async () => {
    // The recorded cwd is textually inside the root but can no longer be
    // canonicalized (e.g. the subdir was deleted). It could still hold evidence
    // for absolute paths elsewhere in the root, so a readable sibling must not be
    // able to report clean coverage over it — it is disclosed as inaccessible.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-vanished', cwd: '/work/proj/pkg' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/v.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(
      result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/work/proj/pkg')),
    );
  });

  it('does not invent an over-broad alias from a leaf-symlink cwd', async () => {
    // cwd /links/alias is a LEAF symlink to root/pkg. Walking `..` from it yields
    // /links, which is NOT an alias of the root (realpath('/links') !== root), so
    // trusting it would mis-scope root/pkg writes and pull in unrelated
    // /links/other files. No alias must be recorded.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-leaf', cwd: '/links/alias' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/leaf.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/links/alias' ? '/work/proj/pkg' : p),
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0]!.ctx.cwd, '/work/proj/pkg');
    assert.equal(result.bindings[0]!.ctx.rootAliases, undefined);
  });
});
