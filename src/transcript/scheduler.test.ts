import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptScheduler, type TranscriptSchedulerOptions } from './scheduler.ts';
import { claudeSlug, type DiscoveryIO, type ListResult } from './discovery.ts';
import type { EvidenceSink, TranscriptFileIO } from './file-reader.ts';
import type { EnrichmentCoverageData, HarnessName } from '../event.ts';
import type { IngestOutcome, NormalizedEvidence } from '../evidence-ingest.ts';

const HOMES: Record<HarnessName, string> = { 'claude-code': '/home/.claude', codex: '/home/.codex' };
const GEN = { dev: 1n, ino: 7n };
type Coverage = Omit<EnrichmentCoverageData, 'session_id'>;

class FakeSink implements EvidenceSink {
  appended: NormalizedEvidence[] = [];
  async ingest(evidence: NormalizedEvidence): Promise<IngestOutcome> {
    this.appended.push(evidence);
    return { status: 'appended', seq: BigInt(this.appended.length) };
  }
}

/** One registered capture: its sink and every coverage event it published. */
function capture(root: string): { root: string; sink: FakeSink; published: Coverage[]; publish: (d: Coverage) => Promise<void> } {
  const published: Coverage[] = [];
  return { root, sink: new FakeSink(), published, publish: async (d) => { published.push(d); } };
}

function claudeWrite(id: string, path: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-17T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path } }] },
  });
}

function codexMeta(id: string, cwd: string): string {
  return JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
}

/** A fake transcript filesystem: Claude dirs and Codex rollouts with fixed bytes,
 * counting every enumeration and header read discovery makes. */
function fakeHomes(files: { claude?: Record<string, string>; codex?: Record<string, string>; truncated?: boolean }) {
  const counts = { listDir: new Map<string, number>(), listTree: 0, firstLine: new Map<string, number>() };
  const claude = files.claude ?? {};
  const codex = files.codex ?? {};
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
  const all: Record<string, string> = { ...claude, ...codex };
  const io: DiscoveryIO = {
    listDir: async (dir): Promise<ListResult> => {
      bump(counts.listDir, dir);
      const paths = Object.keys(claude).filter((p) => p.startsWith(`${dir}/`));
      return paths.length > 0 ? { ok: true, paths } : { ok: false, reason: 'missing' };
    },
    listTreeJsonl: async () => {
      counts.listTree += 1;
      return { paths: Object.keys(codex), truncated: files.truncated ?? false, incomplete: false };
    },
    readFirstLine: async (path) => {
      bump(counts.firstLine, path);
      const text = all[path];
      if (text === undefined) return { ok: false, reason: 'inaccessible' };
      return { ok: true, line: text.split('\n')[0]!, id: GEN };
    },
    readHeadLines: async (path) => {
      const text = all[path];
      if (text === undefined) return { ok: false, reason: 'inaccessible' };
      return { ok: true, lines: text.split('\n').filter((l) => l !== ''), truncated: false, skipped: false, id: GEN };
    },
    realpath: async (p) => p,
    probe: async () => ({ kind: 'absent' }),
  };
  const fileIO: TranscriptFileIO = {
    async readFrom(path, start, maxBytes) {
      const text = all[path];
      if (text === undefined) return { ok: false, reason: 'missing' };
      const buf = Buffer.from(text, 'utf8');
      return { ok: true, id: GEN, size: buf.length, bytes: buf.subarray(start, Math.min(buf.length, start + maxBytes)) };
    },
  };
  return { io, fileIO, counts };
}

function options(io: DiscoveryIO, fileIO: TranscriptFileIO, overrides: Partial<TranscriptSchedulerOptions> = {}): TranscriptSchedulerOptions {
  return {
    harnesses: ['claude-code', 'codex'],
    homes: HOMES,
    codexScanLimit: 1000,
    discoveryIO: io,
    fileIO,
    // Tests drive cycles with tick(); a timer that never fires keeps them deterministic.
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
    ...overrides,
  };
}

const claudeDir = (root: string): string => `${HOMES['claude-code']}/projects/${claudeSlug(root)}`;

describe('shared transcript discovery scheduler', () => {
  it('lists a Claude directory shared by colliding roots once and binds only the cwd owner', async () => {
    // /work/a-b and /work/a/b slug onto the same Claude directory.
    const a = capture('/work/a-b');
    const b = capture('/work/a/b');
    assert.equal(claudeDir(a.root), claudeDir(b.root));
    const path = `${claudeDir(a.root)}/s.jsonl`;
    const { io, fileIO, counts } = fakeHomes({
      claude: { [path]: `${JSON.stringify({ type: 'user', cwd: '/work/a/b' })}\n${claudeWrite('toolu_1', '/work/a/b/x.ts')}\n` },
    });
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['claude-code'] }));
    const ua = scheduler.register(a);
    const ub = scheduler.register(b);
    await scheduler.tick();
    counts.listDir.clear();
    await scheduler.tick();
    assert.equal(counts.listDir.get(claudeDir(a.root)), 1);
    assert.equal(a.sink.appended.length, 0, 'the slug-colliding sibling is not credited');
    assert.deepEqual(b.sink.appended.map((e) => e.evidence_key.record_id), ['toolu_1']);
    await ua();
    await ub();
  });

  it('keeps evidence from every eligible chat in the same worktree', async () => {
    const root = '/work/a';
    const cwd = JSON.stringify({ type: 'user', cwd: root });
    const { io, fileIO } = fakeHomes({
      claude: {
        [`${claudeDir(root)}/linked.jsonl`]: `${cwd}\n${claudeWrite('toolu_linked', `${root}/x.ts`)}\n`,
        [`${claudeDir(root)}/other.jsonl`]: `${cwd}\n${claudeWrite('toolu_other', `${root}/y.ts`)}\n`,
      },
    });
    const c = capture(root);
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['claude-code'] }));
    const unregister = scheduler.register(c);
    await scheduler.tick();
    assert.deepEqual(
      c.sink.appended.map((e) => `${e.evidence_key.harness_session_id}:${e.evidence_key.record_id}`).sort(),
      ['linked:toolu_linked', 'other:toolu_other'],
    );
    await unregister();
  });

  it('discloses a truncated Codex scan to every capture, keeping per-root eligibility', async () => {
    const a = capture('/work/a');
    const b = capture('/work/b');
    const { io, fileIO } = fakeHomes({
      codex: { '/home/.codex/sessions/x.jsonl': codexMeta('codex-a', '/work/a') + '\n' },
      truncated: true,
    });
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['codex'], codexScanLimit: 1 }));
    const ua = scheduler.register(a);
    const ub = scheduler.register(b);
    await scheduler.tick();
    for (const c of [a, b]) {
      const last = c.published.at(-1)!;
      assert.ok(last.issues?.some((i) => i.kind === 'discovery-limited'), `${c.root} discloses the scan limit`);
    }
    assert.equal(a.published.at(-1)!.state, 'degraded', 'a read transcript plus a truncated scan is degraded');
    assert.equal(b.published.at(-1)!.state, 'unavailable', 'nothing read under a limited scan is not clean coverage');
    await ua();
    await ub();
  });

  it('keeps reading other captures when one capture fails, routing the error aside', async () => {
    const root = '/work/a';
    const { io, fileIO } = fakeHomes({
      claude: { [`${claudeDir(root)}/s.jsonl`]: `${JSON.stringify({ type: 'user', cwd: root })}\n` },
    });
    const errors: unknown[] = [];
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['claude-code'], onError: (e) => errors.push(e) }));
    const broken = capture(root);
    broken.publish = async () => { throw new Error('log closed'); };
    const healthy = capture(root);
    const ub = scheduler.register(broken);
    const uh = scheduler.register(healthy);
    await scheduler.tick();
    assert.ok(errors.length >= 1);
    assert.ok(healthy.published.length >= 1, 'the healthy capture still publishes coverage');
    await ub();
    await uh();
  });

  it('keeps ticking other harnesses when one discovery throws', async () => {
    const { io, fileIO } = fakeHomes({});
    io.listDir = async () => { throw new Error('claude discovery blew up'); };
    const errors: unknown[] = [];
    const scheduler = createTranscriptScheduler(options(io, fileIO, { onError: (e) => errors.push(e) }));
    const c = capture('/work/a');
    const unregister = scheduler.register(c);
    await scheduler.tick();
    assert.ok(errors.length >= 1);
    assert.ok(c.published.length >= 1);
    assert.ok(c.published.every((d) => d.harness === 'codex'));
    await unregister();
  });

  it('keeps reading other captures when discovery throws for one capture\'s root', async () => {
    const write = claudeWrite('t1', '/work/a/x.ts');
    const { io, fileIO } = fakeHomes({ claude: { [`${claudeDir('/work/a')}/chat.jsonl`]: JSON.stringify({ type: 'user', cwd: '/work/a' }) + '\n' + write + '\n' } });
    const listDir = io.listDir;
    io.listDir = async (dir) => {
      if (dir === claudeDir('/work/b')) throw new Error('b blew up');
      return listDir(dir);
    };
    const errors: unknown[] = [];
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['claude-code'], onError: (e) => errors.push(e) }));
    const a = capture('/work/a');
    const b = capture('/work/b');
    scheduler.register(a);
    scheduler.register(b);
    await scheduler.tick();
    assert.equal(a.sink.appended.length, 1, 'the healthy capture still reads its chat');
    assert.ok(a.published.length >= 1);
    assert.deepEqual(b.published, []);
    assert.ok(errors.some((e) => (e as Error).message === 'b blew up'));
  });

  it('starts a cycle when the first capture registers, reschedules, and idles once none remain', async () => {
    const pending: Array<() => void> = [];
    let cleared = 0;
    const { io, fileIO, counts } = fakeHomes({});
    const scheduler = createTranscriptScheduler(options(io, fileIO, {
      harnesses: ['codex'],
      pollIntervalMs: 2000,
      setTimer: (ms, fn) => {
        assert.equal(ms, 2000, 'the cadence is unchanged');
        pending.push(fn);
        return pending.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { cleared += 1; },
    }));
    const a = capture('/work/a');
    const ua = scheduler.register(a);
    const ub = scheduler.register(capture('/work/b'));
    await ua(); // awaits nothing in flight for a, but must not stop b's cycles
    await new Promise((r) => setImmediate(r));
    assert.equal(counts.listTree, 1, 'one immediate shared cycle');
    assert.equal(pending.length, 1, 'the next cycle is scheduled after the first finishes');
    pending.shift()!();
    await new Promise((r) => setImmediate(r));
    assert.equal(counts.listTree, 2);
    await ub();
    assert.equal(cleared, 1, 'the pending cycle is cancelled once no capture remains');
    const before = a.published.length;
    await scheduler.tick();
    assert.equal(a.published.length, before, 'an unregistered capture is never read again');
  });

  it('waits for an in-flight read before unregistering resolves', async () => {
    const root = '/work/a';
    const { io, fileIO } = fakeHomes({});
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['codex'] }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let publishing = false;
    let finished = false;
    const c = capture(root);
    c.publish = async () => { publishing = true; await gate; finished = true; };
    const unregister = scheduler.register(c);
    while (!publishing) await new Promise((r) => setImmediate(r));
    let unregistered = false;
    const done = unregister().then(() => { unregistered = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(unregistered, false);
    release();
    await done;
    assert.equal(finished, true);
  });

  it('reads nothing for a capture that unregisters while shared discovery is in flight', async () => {
    const root = '/work/a';
    const codex = { '/home/.codex/sessions/2026/10/17/a.jsonl': codexMeta('t', root) + '\n' };
    const { io, fileIO } = fakeHomes({ codex });
    let release!: () => void;
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holding: DiscoveryIO = { ...io, listTreeJsonl: async (dir, limit) => { held(); await gate; return io.listTreeJsonl(dir, limit); } };
    const scheduler = createTranscriptScheduler(options(holding, fileIO, { harnesses: ['codex'] }));
    const c = capture(root);
    const unregister = scheduler.register(c);
    await isHeld;
    await unregister();
    release();
    await scheduler.tick();
    assert.deepEqual([c.published, c.sink.appended], [[], []]);
  });

  it('gives a capture that re-registers the same root fresh coverage, untouched by its old registration', async () => {
    const root = '/work/a';
    const { io, fileIO } = fakeHomes({});
    const scheduler = createTranscriptScheduler(options(io, fileIO, { harnesses: ['codex'] }));
    const first = capture(root);
    await scheduler.register(first)();
    const published = first.published.length;
    const second = capture(root);
    scheduler.register(second);
    await scheduler.tick();
    assert.equal(first.published.length, published, 'the old registration publishes nothing more');
    assert.equal(second.published.length, 1, 'the new registration publishes its own first coverage');
  });
});
