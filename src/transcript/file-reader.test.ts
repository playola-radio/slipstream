import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptFileReader, type EvidenceSink, type StatResult, type TranscriptFileIO } from './file-reader.ts';
import { claudeStepper } from './steppers.ts';
import { evidenceKeyString, variantSignature } from '../attribution.ts';
import type { NormalizedEvidence, IngestOutcome } from '../evidence-ingest.ts';
import type { AdapterContext } from './types.ts';

const CTX: AdapterContext = {
  harness: 'claude-code',
  harnessSessionId: 'sess-1',
  root: '/work/proj',
  cwd: '/work/proj',
  adapterVersion: 'claude-code/1',
};

/** A single writable transcript file with a stable/settable identity. */
class FakeFile {
  buf: Buffer = Buffer.alloc(0);
  dev = 1;
  ino = 100;
  append(text: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(text, 'utf8')]);
  }
  replace(text: string, ino: number): void {
    this.buf = Buffer.from(text, 'utf8');
    this.ino = ino;
  }
}

function fakeIO(files: Map<string, FakeFile>): TranscriptFileIO {
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

/** Records every ingest and dedups by variant, like the real ingestor. */
class FakeSink implements EvidenceSink {
  appended: NormalizedEvidence[] = [];
  private seen = new Set<string>();
  private rejectNext = 0;
  rejectOnce(n = 1): void {
    this.rejectNext = n;
  }
  async ingest(evidence: NormalizedEvidence): Promise<IngestOutcome> {
    if (this.rejectNext > 0) {
      this.rejectNext -= 1;
      return { status: 'rejected', reason: 'queue-full', retryable: true };
    }
    const sig = `${evidenceKeyString(evidence.evidence_key)}|${variantSignature(evidence)}`;
    if (this.seen.has(sig)) return { status: 'duplicate' };
    this.seen.add(sig);
    this.appended.push(evidence);
    return { status: 'appended', seq: BigInt(this.appended.length) };
  }
}

const WRITE_A = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-19T12:00:00.000Z',
  message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Write', input: { file_path: '/work/proj/a.ts' } }] },
});
const WRITE_B = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-19T12:00:01.000Z',
  message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Write', input: { file_path: '/work/proj/b.ts' } }] },
});

describe('transcript file reader', () => {
  let files: Map<string, FakeFile>;
  let file: FakeFile;
  let sink: FakeSink;

  const makeReader = () =>
    createTranscriptFileReader({ path: '/t.jsonl', io: fakeIO(files), sink, stepper: claudeStepper(CTX) });

  beforeEach(() => {
    file = new FakeFile();
    files = new Map([['/t.jsonl', file]]);
    sink = new FakeSink();
  });

  it('reads complete lines and ingests their evidence', async () => {
    file.append(WRITE_A + '\n');
    const reader = makeReader();
    const r = await reader.poll();
    assert.equal(r.state, 'readable');
    assert.equal(sink.appended.length, 1);
    assert.equal(sink.appended[0]!.evidence_key.record_id, 'toolu_a');
  });

  it('holds a partial trailing line until its newline arrives', async () => {
    file.append(WRITE_A); // no newline yet
    const reader = makeReader();
    assert.equal((await reader.poll()).state, 'readable');
    assert.equal(sink.appended.length, 0, 'incomplete line not processed');
    file.append('\n' + WRITE_B + '\n');
    await reader.poll();
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b'],
    );
  });

  it('appends nothing when the same content is re-read', async () => {
    file.append(WRITE_A + '\n');
    const reader = makeReader();
    await reader.poll();
    await reader.poll();
    assert.equal(sink.appended.length, 1);
  });

  it('rereads from zero after inode rotation, dedup absorbing the overlap', async () => {
    file.append(WRITE_A + '\n');
    const reader = makeReader();
    await reader.poll();
    file.replace(WRITE_A + '\n' + WRITE_B + '\n', 200); // rotated: new inode, same prefix
    await reader.poll();
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b'],
      'the rotated prefix dedups; only the new record is appended',
    );
  });

  it('rereads from zero when the file shrinks below the offset', async () => {
    file.append(WRITE_A + '\n' + WRITE_B + '\n');
    const reader = makeReader();
    await reader.poll();
    assert.equal(sink.appended.length, 2);
    file.replace(WRITE_B + '\n', file.ino); // truncate-and-regrow, same inode
    await reader.poll();
    assert.equal(sink.appended.length, 2, 'toolu_b dedups; nothing new');
  });

  it('holds the offset under backpressure and advances on retry', async () => {
    file.append(WRITE_A + '\n' + WRITE_B + '\n');
    const reader = makeReader();
    sink.rejectOnce(1); // reject toolu_a's ingest
    const first = await reader.poll();
    assert.equal(first.backpressured, true);
    assert.equal(sink.appended.length, 0);
    const second = await reader.poll();
    assert.equal(second.backpressured, false);
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b'],
    );
  });

  it('advances past a malformed line and reports degraded, never wedging', async () => {
    file.append('{not json\n' + WRITE_A + '\n');
    const reader = makeReader();
    const r = await reader.poll();
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues[0]!.kind, 'malformed');
    assert.equal(sink.appended.length, 1, 'the good line after the bad one still lands');
  });

  it('reports a missing file distinctly from a read with no match', async () => {
    files.delete('/t.jsonl');
    const reader = makeReader();
    assert.equal((await reader.poll()).state, 'missing');
  });
});
