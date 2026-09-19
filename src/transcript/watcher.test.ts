import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCoverage, createTranscriptWatcher, type CoveragePublish } from './watcher.ts';
import type { DiscoveryIO, ListResult } from './discovery.ts';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';
import type { EvidenceSink } from './file-reader.ts';
import { evidenceKeyString, variantSignature } from '../attribution.ts';
import type { IngestOutcome, NormalizedEvidence } from '../evidence-ingest.ts';
import type { EnrichmentCoverageData } from '../event.ts';

const ROOT = '/work/proj';

class FakeFile {
  buf = Buffer.alloc(0);
  dev = 1;
  ino = 100;
  append(text: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(text, 'utf8')]);
  }
}

function fileIO(files: Map<string, FakeFile>): TranscriptFileIO {
  return {
    async stat(path): Promise<StatResult> {
      const f = files.get(path);
      if (!f) return { ok: false, reason: 'missing' };
      return { ok: true, size: f.buf.length, dev: f.dev, ino: f.ino };
    },
    async read(path, start, end): Promise<Buffer> {
      const f = files.get(path);
      if (!f) throw new Error('missing');
      return f.buf.subarray(start, end);
    },
  };
}

class FakeSink implements EvidenceSink {
  appended: NormalizedEvidence[] = [];
  private seen = new Set<string>();
  async ingest(evidence: NormalizedEvidence): Promise<IngestOutcome> {
    const sig = `${evidenceKeyString(evidence.evidence_key)}|${variantSignature(evidence)}`;
    if (this.seen.has(sig)) return { status: 'duplicate' };
    this.seen.add(sig);
    this.appended.push(evidence);
    return { status: 'appended', seq: BigInt(this.appended.length) };
  }
}

function discoveryIO(overrides: Partial<DiscoveryIO>): DiscoveryIO {
  return {
    listDir: async (): Promise<ListResult> => ({ ok: true, paths: [] }),
    listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: false }),
    readFirstLine: async () => ({ ok: false, reason: 'empty' }),
    realpath: async (p) => p,
    probe: async () => ({ kind: 'absent' }),
    ...overrides,
  };
}

const WRITE_A = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-19T12:00:00.000Z',
  message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Write', input: { file_path: '/work/proj/a.ts' } }] },
});

const RELATIVE_WRITE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-19T12:00:00.000Z',
  message: { content: [{ type: 'tool_use', id: 'toolu_rel', name: 'Write', input: { file_path: 'x.ts' } }] },
});

describe('coverage aggregation', () => {
  it('is pending when configured but nothing is discovered yet', () => {
    assert.deepEqual(aggregateCoverage([], []), { state: 'pending', issues: [] });
  });

  it('is readable when every discovered transcript read cleanly', () => {
    const r = aggregateCoverage([], [{ state: 'readable', issues: [] }]);
    assert.equal(r.state, 'readable');
    assert.equal(r.issues.length, 0);
  });

  it('is degraded when a transcript read but a sibling issue exists', () => {
    const r = aggregateCoverage(
      [{ kind: 'discovery-limited', detail: 'cap hit' }],
      [{ state: 'readable', issues: [] }],
    );
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues[0]!.kind, 'discovery-limited');
  });

  it('is degraded when a read transcript had a malformed line', () => {
    const r = aggregateCoverage([], [{ state: 'degraded', issues: [{ kind: 'malformed', detail: 'bad' }] }]);
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues[0]!.kind, 'malformed');
  });

  it('is unavailable when nothing could be read and the failure is hard', () => {
    const r = aggregateCoverage([{ kind: 'inaccessible', detail: 'perm' }], []);
    assert.equal(r.state, 'unavailable');
  });

  it('stays pending when the only signal is a not-yet-written transcript home', () => {
    const r = aggregateCoverage([{ kind: 'missing', detail: 'no dir yet' }], []);
    assert.equal(r.state, 'pending');
    assert.equal(r.issues[0]!.kind, 'missing');
  });

  it('surfaces an unreadable file even when another is fine', () => {
    const r = aggregateCoverage([], [
      { state: 'readable', issues: [] },
      { state: 'inaccessible', issues: [] },
    ]);
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues.some((i) => i.kind === 'inaccessible'), true);
  });

  it('is degraded, not readable, while a file still has backpressured evidence', () => {
    // The file read cleanly (no content issue) but some evidence was held back by
    // ingestion backpressure, so coverage must not claim the scope is fully recorded.
    const r = aggregateCoverage([], [{ state: 'readable', issues: [], backpressured: true }]);
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues.length, 0, 'backpressure degrades without inventing an issue kind');
  });
});

describe('transcript watcher', () => {
  let sink: FakeSink;
  let published: EnrichmentCoverageData['state'][];
  let publishedFull: Array<Omit<EnrichmentCoverageData, 'session_id'>>;
  const publish: CoveragePublish = async (data) => {
    published.push(data.state);
    publishedFull.push(data);
  };

  beforeEach(() => {
    sink = new FakeSink();
    published = [];
    publishedFull = [];
  });

  it('discovers a Claude transcript, ingests its evidence, and publishes readable', async () => {
    const dir = '/home/projects/-work-proj';
    const file = new FakeFile();
    file.append(WRITE_A + '\n');
    const files = new Map([[`${dir}/sess-a.jsonl`, file]]);
    const watcher = createTranscriptWatcher({
      harness: 'claude-code',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listDir: async (d): Promise<ListResult> =>
          d === dir ? { ok: true, paths: [`${dir}/sess-a.jsonl`] } : { ok: false, reason: 'missing' },
      }),
      fileIO: fileIO(files),
      sink,
      publish,
    });
    await watcher.tick();
    assert.equal(sink.appended.length, 1);
    assert.equal(sink.appended[0]!.evidence_key.record_id, 'toolu_a');
    assert.deepEqual(published, ['readable']);
  });

  it('publishes coverage only when it changes', async () => {
    const dir = '/home/projects/-work-proj';
    const file = new FakeFile();
    file.append(WRITE_A + '\n');
    const files = new Map([[`${dir}/sess-a.jsonl`, file]]);
    const watcher = createTranscriptWatcher({
      harness: 'claude-code',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listDir: async (): Promise<ListResult> => ({ ok: true, paths: [`${dir}/sess-a.jsonl`] }),
      }),
      fileIO: fileIO(files),
      sink,
      publish,
    });
    await watcher.tick();
    await watcher.tick();
    assert.deepEqual(published, ['readable'], 'unchanged coverage is not republished');
  });

  it('reads incrementally across ticks, keeping each transcript offset', async () => {
    const dir = '/home/projects/-work-proj';
    const path = `${dir}/sess-a.jsonl`;
    const file = new FakeFile();
    const files = new Map<string, FakeFile>();
    let present = false; // the transcript appears only after the agent starts writing
    const watcher = createTranscriptWatcher({
      harness: 'claude-code',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listDir: async (): Promise<ListResult> =>
          present ? { ok: true, paths: [path] } : { ok: false, reason: 'missing' },
      }),
      fileIO: fileIO(files),
      sink,
      publish,
    });
    await watcher.tick(); // nothing written yet: pending
    present = true;
    file.append(WRITE_A + '\n');
    files.set(path, file);
    await watcher.tick(); // transcript appeared with a record
    assert.equal(sink.appended.length, 1);
    await watcher.tick(); // no new bytes, dedup absorbs re-reads
    assert.equal(sink.appended.length, 1);
    assert.deepEqual(published, ['pending', 'readable']);
  });

  it('recreates a reader when a path is rebound to a different harness session', async () => {
    // Same Codex rollout bytes and inode across ticks, but discovery reports a
    // different session_meta id the second time. Nothing in the file-reader itself
    // (offset/inode) would trigger a reread, so only the watcher's session-rotation
    // guard can re-emit the record under the new identity.
    const path = '/home/sessions/2026/09/19/rollout.jsonl';
    const metaLine = (id: string) =>
      JSON.stringify({ type: 'session_meta', timestamp: '2026-09-19T12:00:00.000Z', payload: { id, cwd: ROOT } });
    const call = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-19T12:00:01.000Z',
      payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{}' },
    });
    const file = new FakeFile();
    file.append(metaLine('thread-1') + '\n' + call + '\n');
    const files = new Map([[path, file]]);
    let sessionId = 'thread-1';
    const watcher = createTranscriptWatcher({
      harness: 'codex',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listTreeJsonl: async () => ({ paths: [path], truncated: false, incomplete: false }),
        readFirstLine: async () => ({ ok: true, line: metaLine(sessionId) }),
        realpath: async (p) => p,
      }),
      fileIO: fileIO(files),
      sink,
      publish,
    });
    await watcher.tick();
    sessionId = 'thread-2';
    await watcher.tick();
    assert.deepEqual(
      sink.appended
        .filter((e) => e.evidence_key.record_id === 'call_1' && e.timestamp.basis === 'tool-start')
        .map((e) => e.evidence_key.harness_session_id)
        .sort(),
      ['thread-1', 'thread-2'],
    );
  });

  it('discloses a relative Claude write as unknown scope, never guessing a provisional cwd', async () => {
    // Regression for the provisional-binding conflict: an empty transcript
    // slug-trust binds cwd=root, then a relative write arrives before the real cwd
    // is known. Claude's write tools declare absolute paths, so a relative one
    // cannot be resolved without trusting a cwd that may be provisional or an alias
    // of the root. The adapter discloses it as an unmapped possible writer — the
    // same single unknown-scope record on every tick, so a re-read dedups and the
    // invocation never splits into two conflicting scope variants.
    const dir = '/home/projects/-work-proj';
    const path = `${dir}/sess-a.jsonl`;
    const file = new FakeFile();
    const files = new Map<string, FakeFile>();
    const watcher = createTranscriptWatcher({
      harness: 'claude-code',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listDir: async (): Promise<ListResult> => ({ ok: true, paths: [path] }),
      }),
      fileIO: fileIO(files),
      sink,
      publish,
    });
    await watcher.tick(); // empty transcript: provisional cwd=root, nothing read
    assert.equal(sink.appended.length, 0);
    file.append(RELATIVE_WRITE + '\n');
    files.set(path, file);
    await watcher.tick(); // relative write arrives
    await watcher.tick(); // a re-read must not add a second, differently-scoped variant
    const relStarts = sink.appended.filter(
      (e) => e.evidence_key.record_id === 'toolu_rel' && e.timestamp.basis === 'tool-start',
    );
    assert.equal(relStarts.length, 1, 'one record, no conflicting variant');
    assert.equal(relStarts[0]!.file_scope.kind, 'unknown');
  });

  it('reports unavailable when the transcript home is inaccessible', async () => {
    const watcher = createTranscriptWatcher({
      harness: 'claude-code',
      home: '/home',
      root: ROOT,
      codexScanLimit: 1000,
      discoveryIO: discoveryIO({
        listDir: async (): Promise<ListResult> => ({ ok: false, reason: 'inaccessible' }),
      }),
      fileIO: fileIO(new Map()),
      sink,
      publish,
    });
    await watcher.tick();
    assert.deepEqual(published, ['unavailable']);
    assert.equal(publishedFull[0]!.issues![0]!.kind, 'inaccessible');
  });
});
