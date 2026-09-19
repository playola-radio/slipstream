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
    probe: async () => ({ kind: 'absent' }),
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
        // Only the filesystem root still resolves; /gone is a plain deleted dir.
        realpath: async (p) => (p === '/' ? '/' : undefined),
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
        // The root remains captured; only the pkg subdir was deleted.
        realpath: async (p) => (p === ROOT ? ROOT : undefined),
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

  it('does not disclose a deleted cwd that escaped the root through an internal symlink', async () => {
    // cwd /work/proj/link/gone is textually inside the root, but `link` is a
    // symlink to /other/project, so the session's real location is outside the
    // root. Its nearest living ancestor canonicalizes out of root, so it is a
    // different worktree's session and must NOT degrade this root's coverage.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-escaped', cwd: '/work/proj/link/gone' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/esc.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/work/proj/link' ? '/other/project' : p === ROOT ? ROOT : undefined),
        probe: async (p) =>
          p === '/work/proj/link' ? { kind: 'symlink', target: '/other/project' } : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('discloses a deleted cwd in the root alias namespace via its living ancestor', async () => {
    // cwd /tmp/proj/deleted no longer resolves, and is not textually inside the
    // canonical root. But /tmp/proj is a symlink to the root, so the deleted tail
    // still places in-root — an in-root candidate we failed to read, disclosed.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-alias-gone', cwd: '/tmp/proj/deleted' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/ag.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
        probe: async (p) => (p === '/tmp/proj' ? { kind: 'symlink', target: ROOT } : { kind: 'absent' }),
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(
      result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/tmp/proj/deleted')),
    );
  });

  it('does not disclose a dangling-symlink cwd whose target is outside the root', async () => {
    // cwd /work/proj/link is a symlink to /other/deleted (now gone), so realpath
    // fails though the symlink still exists. Its literal target is outside the
    // root, so it is a different worktree's session and must not degrade coverage.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-dangle-out', cwd: '/work/proj/link' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/do.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === ROOT ? ROOT : p === '/other' ? '/other' : undefined),
        probe: async (p) =>
          p === '/work/proj/link' ? { kind: 'symlink', target: '/other/deleted' } : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('discloses a dangling-symlink cwd whose target is inside the root', async () => {
    // cwd /links/alias is a symlink to /work/proj/deleted (now gone). realpath
    // fails, but the literal target places it inside the root — an in-root
    // candidate we could not read, disclosed rather than dropped.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-dangle-in', cwd: '/links/alias' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/di.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/links' ? '/links' : p === ROOT ? ROOT : undefined),
        probe: async (p) =>
          p === '/links/alias' ? { kind: 'symlink', target: '/work/proj/deleted' } : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(
      result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/links/alias')),
    );
  });

  it('resolves a `..` symlink target through a surviving symlink to disclose an in-root cwd', async () => {
    // cwd /entry -> /outside/deleted/../bridge/gone, with /outside/bridge -> the
    // root and `deleted`/`gone` deleted. The `..` pops back above the dead
    // `deleted` into living space, where `bridge` must be FOLLOWED before the rest;
    // the true location is <root>/gone (in-root). A lexical collapse would yield
    // /outside/bridge/gone and hide an in-root candidate.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-bridge-in', cwd: '/entry' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/bi.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
        probe: async (p) =>
          p === '/entry'
            ? { kind: 'symlink', target: '/outside/deleted/../bridge/gone' }
            : p === '/outside/bridge'
              ? { kind: 'symlink', target: ROOT }
              : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/entry')));
  });

  it('resolves a `..` symlink target through a surviving symlink to skip an out-of-root cwd', async () => {
    // The mirror image: cwd /entry -> /work/proj/deleted/../bridge/gone, with the
    // root's own `bridge` symlinking OUT to /outside. The true location is
    // /outside/gone, so it must NOT be disclosed despite the textually in-root path.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-bridge-out', cwd: '/entry' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/bo.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
        probe: async (p) =>
          p === '/entry'
            ? { kind: 'symlink', target: '/work/proj/deleted/../bridge/gone' }
            : p === '/work/proj/bridge'
              ? { kind: 'symlink', target: '/outside' }
              : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('discloses a cwd whose component cannot be inspected (permission wall), never dropping it', async () => {
    // /links exists but denies directory search, so inspecting /links/alias fails
    // with EACCES. An unreadable component does not establish non-membership, so
    // the candidate is disclosed rather than silently dropped.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-eacces', cwd: '/links/alias' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/ea.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async () => undefined,
        probe: async (p) =>
          p === '/links'
            ? { kind: 'present' }
            : p === '/links/alias'
              ? { kind: 'error' }
              : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/links/alias')));
  });

  it('follows a long acyclic symlink chain to its true (out-of-root) target', async () => {
    // A 10-link chain /l0 -> /l1 -> ... -> /l9 -> /other/gone must be followed to its
    // end and skipped, proving the final link's target is always evaluated rather
    // than the walk fail-opening at some boundary.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-chain', cwd: '/l0' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/chain.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/' ? '/' : p === '/other' ? '/other' : undefined),
        probe: async (p) => {
          const m = /^\/l(\d+)$/.exec(p);
          if (!m) return { kind: 'absent' };
          const i = Number(m[1]);
          return { kind: 'symlink', target: i < 9 ? `/l${i + 1}` : '/other/gone' };
        },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('discloses (never silently drops) a cwd trapped in a symlink cycle', async () => {
    // /a -> /b -> /a never resolves. Exhausting the hop cap must fail toward
    // disclosure, not assert the unestablished claim that the cwd is out of root.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-cycle', cwd: '/a' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/cyc.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => (p === '/' ? '/' : undefined),
        probe: async (p) =>
          p === '/a'
            ? { kind: 'symlink', target: '/b' }
            : p === '/b'
              ? { kind: 'symlink', target: '/a' }
              : { kind: 'absent' },
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/a')));
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
