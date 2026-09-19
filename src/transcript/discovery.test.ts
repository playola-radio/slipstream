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
    listTreeJsonl: async () => ({ paths: [], truncated: false }),
    readFirstLine: async () => undefined,
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
            ? { ok: true, paths: [`${dir}/sess-a.jsonl`, `${dir}/sess-b.jsonl`, `${dir}/notes.txt`] }
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
        listTreeJsonl: async () => ({ paths: [...heads.keys()], truncated: false }),
        readFirstLine: async (p) => heads.get(p),
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
  });

  it('discloses discovery-limited when the Codex scan is truncated', async () => {
    const result = await discoverCodex(
      io({ listTreeJsonl: async () => ({ paths: [], truncated: true }) }),
      '/home',
      ROOT,
      10,
    );
    assert.equal(result.issues[0]!.kind, 'discovery-limited');
  });
});
