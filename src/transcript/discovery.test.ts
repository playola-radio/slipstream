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
    readHeadLines: async () => ({ ok: true, lines: [], truncated: false }),
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
    const record = JSON.stringify({ type: 'user', cwd: ROOT, message: { content: 'hi' } });
    const result = await discoverClaude(
      io({
        listDir: async (d): Promise<ListResult> =>
          d === dir
            ? { ok: true, paths: [`${dir}/sess-a.jsonl`, `${dir}/sess-b.jsonl`] }
            : { ok: false, reason: 'missing' },
        readFirstLine: async () => ({ ok: true as const, line: record }),
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

  it('discloses a Codex session_meta with an empty id as malformed, not an empty-namespace binding', async () => {
    // An empty id is not a stable session identity: keying evidence under "" would
    // collapse unrelated sessions onto one namespace. Reject it as malformed rather
    // than bind it.
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: '', cwd: '/work/proj' } });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/a.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
      1000,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'malformed' && i.detail.includes('/c/a.jsonl')));
  });

  it('discloses a Codex rollout whose first line is malformed (e.g. invalid UTF-8)', async () => {
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/a.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: false as const, reason: 'malformed' as const }),
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
      1000,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'malformed' && i.detail.includes('/c/a.jsonl')));
  });

  it('validates the Claude slug by the transcript cwd, skipping a slug-colliding other worktree', async () => {
    // Roots '/work/proj' and '/work-proj' can collide onto one Claude slug dir. A
    // transcript whose recorded cwd resolves OUTSIDE the root belongs to the other
    // worktree: skip it silently (never emit its evidence or report readable).
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const record = (cwd: string) => JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } });
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/in.jsonl`, `${dir}/out.jsonl`] }),
        readFirstLine: async (p) =>
          p.endsWith('in.jsonl')
            ? { ok: true as const, line: record('/work/proj/pkg') }
            : { ok: true as const, line: record('/work/other') },
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
    );
    assert.deepEqual(
      result.bindings.map((b) => b.ctx.harnessSessionId),
      ['in'],
      'only the in-root transcript is bound; the colliding out-of-root one is skipped',
    );
    assert.equal(result.issues.length, 0, 'an out-of-root sibling is not an issue for this root');
  });

  it('derives a Claude root alias when the transcript cwd is a symlinked alias of the root', async () => {
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const record = JSON.stringify({ type: 'user', cwd: '/alias/proj', message: { content: 'hi' } });
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/a.jsonl`] }),
        readFirstLine: async () => ({ ok: true as const, line: record }),
        realpath: async (p) => (p === '/alias/proj' ? '/work/proj' : p),
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 1);
    assert.deepEqual(result.bindings[0]!.ctx.rootAliases, ['/alias/proj']);
  });

  it('finds the cwd (with alias) past a cwd-less preamble by head-scanning', async () => {
    // Real Claude transcripts open with cwd-less records (ai-title, queue-operation,
    // attachments); the first cwd-bearing record appears only a few lines in. If the
    // first line alone were trusted, the alias would never be derived and an aliased
    // absolute write would be dropped. The head-scan must reach the record that
    // carries the (aliased) cwd.
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const preamble = JSON.stringify({ type: 'ai-title', title: 'x' });
    const withCwd = JSON.stringify({ type: 'user', cwd: '/alias/proj', message: { content: 'hi' } });
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/a.jsonl`] }),
        readFirstLine: async () => ({ ok: true as const, line: preamble }),
        readHeadLines: async () => ({ ok: true as const, lines: [preamble, withCwd], truncated: false }),
        realpath: async (p) => (p === '/alias/proj' ? '/work/proj' : p),
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 1);
    assert.deepEqual(result.bindings[0]!.ctx.rootAliases, ['/alias/proj']);
  });

  it('skips a slug-colliding worktree whose cwd only appears past the preamble', async () => {
    // The out-of-root cwd must be found by the head-scan too, or a colliding sibling
    // worktree would be slug-trusted and its evidence wrongly published for this root.
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const preamble = JSON.stringify({ type: 'ai-title', title: 'x' });
    const withCwd = JSON.stringify({ type: 'user', cwd: '/work/other', message: { content: 'hi' } });
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/a.jsonl`] }),
        readFirstLine: async () => ({ ok: true as const, line: preamble }),
        readHeadLines: async () => ({ ok: true as const, lines: [preamble, withCwd], truncated: false }),
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 0, 'the out-of-root sibling is skipped, not slug-trusted');
    assert.equal(result.issues.length, 0);
  });

  it('discloses a malformed Claude first line and withholds the binding', async () => {
    // A first line that exists but is unreadable (malformed/inaccessible) cannot
    // confirm membership, so it is disclosed and NOT slug-trust bound — otherwise a
    // corrupt or slug-colliding transcript would publish clean readable coverage.
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/bad.jsonl`] }),
        readFirstLine: async () => ({ ok: false as const, reason: 'malformed' as const }),
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(result.issues.some((i) => i.kind === 'malformed' && i.detail.includes('bad.jsonl')));
  });

  it('withholds a Claude transcript still in its cwd-less preamble (no binding, no issue)', async () => {
    // A transcript whose head is fully read but carries no cwd yet is not slug-trusted:
    // binding it would risk a slug-colliding sibling worktree. It is withheld with no
    // issue (coverage stays pending) and re-checked next tick once the cwd is written.
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/a.jsonl`] }),
        readFirstLine: async () => ({ ok: true as const, line: JSON.stringify({ type: 'summary' }) }),
        readHeadLines: async () => ({ ok: true as const, lines: [JSON.stringify({ type: 'summary' })], truncated: false }),
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 0, 'no cwd confirmed yet: withheld, not slug-trusted');
    assert.equal(result.issues.length, 0, 'a not-yet-confirmed transcript is pending, not an issue');
  });

  it('discloses (never binds) a Claude transcript whose cwd lies beyond the truncated head', async () => {
    // The head scan hit its budget before finding a cwd: a cwd may exist past the
    // window, so membership cannot be confirmed. Slug-trusting here would admit a
    // colliding sibling worktree and report it readable, so instead disclose the gap
    // and withhold the binding.
    const dir = `/home/projects/${claudeSlug(ROOT)}`;
    const preamble = JSON.stringify({ type: 'ai-title', title: 'x' });
    const result = await discoverClaude(
      io({
        listDir: async () => ({ ok: true, paths: [`${dir}/a.jsonl`] }),
        readFirstLine: async () => ({ ok: true as const, line: preamble }),
        readHeadLines: async () => ({ ok: true as const, lines: [preamble], truncated: true }),
        realpath: async (p) => p,
      }),
      '/home',
      ROOT,
    );
    assert.equal(result.bindings.length, 0, 'unconfirmed membership is never slug-trusted');
    assert.ok(
      result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('membership unconfirmed')),
      'the unconfirmable transcript is disclosed, not silently dropped',
    );
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
        // /links resolves normally; only inspecting /links/alias hits the wall.
        realpath: async (p) => (p === '/links' ? '/links' : undefined),
        probe: async (p) => (p === '/links/alias' ? { kind: 'error' } : { kind: 'absent' }),
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

  it('discloses a deleted in-root cwd recorded with different case on a case-insensitive FS', async () => {
    // macOS's default filesystem is case-insensitive: cwd /WORK/PROJ/gone names the
    // same directory as canonical root /work/proj. The tail is deleted, so realpath
    // of the whole string fails, but the kernel still canonicalizes each living
    // component (folding case), placing it in-root. Reimplementing membership by
    // comparing raw spelling would silently drop this in-root candidate.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-case', cwd: '/WORK/PROJ/gone' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/case.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        // The kernel folds case per living component; `gone` is deleted.
        realpath: async (p) =>
          p === '/WORK' ? '/work' : p === '/work/PROJ' || p === '/WORK/PROJ' ? ROOT : undefined,
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.ok(
      result.issues.some((i) => i.kind === 'inaccessible' && i.detail.includes('/WORK/PROJ/gone')),
    );
  });

  it('skips an out-of-root cwd whose parent component is a file (ENOTDIR), without disclosing it', async () => {
    // Another worktree's former directory /other/project/pkg is now a regular file,
    // so /other/project/pkg/gone can never exist (ENOTDIR). That is confirmed
    // absence, not an inspection failure: the cwd places outside the root and must
    // not degrade this root's coverage.
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-notdir', cwd: '/other/project/pkg/gone' },
    });
    const result = await discoverCodex(
      io({
        listTreeJsonl: async () => ({ paths: ['/c/nd.jsonl'], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true as const, line: meta }),
        // pkg is a file (realpath resolves it); below it, realpath fails with ENOTDIR.
        realpath: async (p) =>
          p === '/other' || p === '/other/project' || p === '/other/project/pkg' ? p : undefined,
        // fs-io maps ENOTDIR to absence, so probe of the dead tail is `absent`.
        probe: async () => ({ kind: 'absent' }),
      }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues.length, 0);
  });
});
