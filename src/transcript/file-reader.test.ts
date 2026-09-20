import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptFileReader, type EvidenceSink, type TranscriptFileIO } from './file-reader.ts';
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
  dev = 1n;
  ino = 100n;
  append(text: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(text, 'utf8')]);
  }
  replace(text: string, ino: bigint): void {
    this.buf = Buffer.from(text, 'utf8');
    this.ino = ino;
  }
}

function fakeIO(files: Map<string, FakeFile>): TranscriptFileIO {
  return {
    async readFrom(path, start, maxBytes) {
      const f = files.get(path);
      if (!f) return { ok: false, reason: 'missing' };
      // The id, size, and bytes all come from the one snapshot, like a single open
      // handle: a caller cannot observe one generation's size against another's bytes.
      return {
        ok: true,
        id: { dev: f.dev, ino: f.ino },
        size: f.buf.length,
        bytes: f.buf.subarray(start, Math.min(f.buf.length, start + maxBytes)),
      };
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
const WRITE_C = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-19T12:00:02.000Z',
  message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Write', input: { file_path: '/work/proj/c.ts' } }] },
});
// A parseable record the adapter ignores, but whose payload holds multibyte UTF-8
// (accents + an emoji): its byte length exceeds its decoded-character length, so a
// character-indexed cursor would drift and skip the record that follows it.
const MULTIBYTE_NOOP = JSON.stringify({ type: 'summary', summary: 'café 🚀 déjà vu' });

describe('transcript file reader', () => {
  let files: Map<string, FakeFile>;
  let file: FakeFile;
  let sink: FakeSink;

  const makeReader = (generation = { dev: file.dev, ino: file.ino }) =>
    createTranscriptFileReader({ path: '/t.jsonl', io: fakeIO(files), sink, stepper: claudeStepper(CTX), generation });

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

  it('drains bounded chunks and an over-chunk record in one poll', { timeout: 1000 }, async () => {
    const records = ['a', 'b', 'a record longer than the chunk', 'c'];
    file.append(records.map((record) => JSON.stringify(record) + '\n').join(''));
    const calls: Array<{ start: number; maxBytes: number }> = [];
    const adapter = claudeStepper(CTX);
    const reader = createTranscriptFileReader({
      path: '/t.jsonl',
      io: {
        async readFrom(_path, start, maxBytes) {
          calls.push({ start, maxBytes });
          return {
            ok: true,
            id: { dev: file.dev, ino: file.ino },
            size: file.buf.length,
            bytes: file.buf.subarray(start, Math.min(file.buf.length, start + maxBytes)),
          };
        },
      },
      sink,
      stepper: {
        reset: () => adapter.reset(),
        step(record) {
          const native = JSON.parse(WRITE_A);
          native.message.content[0].id = record;
          return adapter.step(native);
        },
      },
      generation: { dev: file.dev, ino: file.ino },
      readChunkBytes: 16,
    });
    const result = await reader.poll();
    assert.deepEqual(sink.appended.map((e) => e.evidence_key.record_id), records);
    assert.equal(result.state, 'readable');
    assert.ok(calls.some((call) => call.maxBytes === 16));
    assert.ok(calls.length > 1);
    assert.ok(calls.some((call) => call.maxBytes > 16), 'an over-chunk line grows the read window');
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

  it('refuses a replaced generation (new inode) instead of ingesting it under the stale binding', async () => {
    // A same-path atomic replace yields a new inode. Because a Codex ctx (and a
    // slug-colliding Claude ctx) is derived from the file's own content, ingesting
    // the replacement under this reader's pinned binding would credit its records to
    // the prior generation's session and scope. The reader refuses it (`unconfirmed`)
    // and defers to the next discovery tick, which re-derives the binding for the new
    // inode and, only if it too is a confirmed in-root member, recreates the reader.
    file.append(WRITE_A + '\n');
    const reader = makeReader();
    await reader.poll();
    assert.equal(sink.appended.length, 1);
    file.replace(WRITE_A + '\n' + WRITE_B + '\n', 200n); // atomic replace: new inode
    const r = await reader.poll();
    assert.equal(r.state, 'unconfirmed', 'a new inode is a replacement discovery has not re-confirmed');
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a'],
      'the replacement is not ingested under the prior binding',
    );
  });

  it('distinguishes two 64-bit inodes that collapse to the same Number', async () => {
    // 9007199254740992 (2^53) and 2^53+1 are distinct inodes that round to the SAME
    // JavaScript Number. Held as Number, the replacement would falsely pass the
    // generation check and be ingested under the prior binding. Held as bigint, the
    // reader sees a different generation and refuses it.
    const genA = 9_007_199_254_740_992n;
    const genB = 9_007_199_254_740_993n;
    assert.equal(Number(genA), Number(genB), 'precondition: the two inodes collapse under Number');
    file.ino = genA;
    file.append(WRITE_A + '\n');
    const reader = makeReader({ dev: file.dev, ino: genA });
    await reader.poll();
    assert.equal(sink.appended.length, 1);
    file.replace(WRITE_B + '\n', genB); // a distinct inode that Number()s to genA
    const r = await reader.poll();
    assert.equal(r.state, 'unconfirmed', 'a bigint comparison catches the replacement Number would miss');
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a'],
      'the replacement is not ingested under the prior binding',
    );
  });

  it('reads a replaced generation once a fresh reader is pinned to the new inode', async () => {
    // The watcher recreates the reader against the re-confirmed new generation on the
    // next tick. That fresh reader reads the replacement from zero; nothing is lost.
    file.append(WRITE_A + '\n');
    const stale = makeReader();
    await stale.poll();
    file.replace(WRITE_B + '\n', 200n); // atomic replace: new inode, new content
    assert.equal((await stale.poll()).state, 'unconfirmed', 'the stale reader refuses it');
    const fresh = makeReader({ dev: file.dev, ino: file.ino });
    assert.equal((await fresh.poll()).state, 'readable');
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b'],
      'the fresh reader pinned to the new generation reads the replacement',
    );
  });

  it('rereads from zero when the file shrinks below the offset', async () => {
    file.append(WRITE_A + '\n' + WRITE_B + '\n');
    const reader = makeReader();
    await reader.poll();
    assert.equal(sink.appended.length, 2);
    // Truncate-and-regrow to a shorter file whose only record is brand new: it sits
    // below the old offset, so it can be read ONLY if the shrink reset the cursor to
    // zero. (A dedup-covered record here would pass whether or not the reset fired.)
    file.replace(WRITE_C + '\n', file.ino);
    await reader.poll();
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b', 'toolu_c'],
      'the shrink reset the cursor, so the new shorter content is read from zero',
    );
  });

  it('rereads from zero when the file shrinks to exactly the offset, dropping a partial tail', async () => {
    // A complete line, then an unterminated partial tail: the offset stops at the
    // line boundary while the file grows past it.
    file.append(WRITE_A + '\n' + 'x'.repeat(50));
    const reader = makeReader();
    await reader.poll();
    assert.equal(sink.appended.length, 1, 'toolu_a read; the partial tail is held');
    // Rewrite the same inode to one brand-new record whose byte length equals the
    // old line-boundary offset (WRITE_C is the same length as WRITE_A). The FILE
    // shrank (the partial tail is gone), but the new size equals the offset, so a
    // size<offset check misses it. Only tracking the last observed size catches the
    // shrink and rereads the replacement from zero.
    assert.equal((WRITE_C + '\n').length, (WRITE_A + '\n').length, 'fixture precondition');
    file.replace(WRITE_C + '\n', file.ino);
    await reader.poll();
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_c'],
      'the shrink to exactly the offset still reset the cursor',
    );
  });

  it('discloses invalid UTF-8 as malformed instead of fabricating a replacement-char path', async () => {
    // A complete JSON line whose file_path holds a raw 0xFF byte (invalid UTF-8).
    // Lossy decoding would coin a "�"-bearing path and emit it as real scope; honest
    // behavior reports the line malformed and emits no fabricated evidence.
    const head = Buffer.from(
      '{"type":"assistant","timestamp":"2026-09-19T12:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_a","name":"Write","input":{"file_path":"/work/proj/',
      'utf8',
    );
    const tail = Buffer.from('.ts"}}]}}\n', 'utf8');
    file.buf = Buffer.concat([head, Buffer.from([0xff]), tail]);
    const reader = makeReader();
    const r = await reader.poll();
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues[0]!.kind, 'malformed');
    assert.equal(sink.appended.length, 0, 'no fabricated replacement-char scope is ingested');
    // The offset still advanced past the bad line, so a following good line lands.
    file.append(WRITE_B + '\n');
    await reader.poll();
    assert.deepEqual(sink.appended.map((e) => e.evidence_key.record_id), ['toolu_b']);
  });

  it('advances the cursor by bytes, not characters, across multibyte lines', async () => {
    file.append(MULTIBYTE_NOOP + '\n' + WRITE_A + '\n');
    const reader = makeReader();
    const r = await reader.poll();
    assert.equal(r.state, 'readable', 'the ignored multibyte line is not malformed');
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a'],
      'the record after a multibyte line is read, not skipped by a drifted cursor',
    );
    // The cursor landed exactly on the byte boundary: a re-poll reads nothing, and a
    // freshly appended record is still framed correctly.
    file.append(WRITE_B + '\n');
    await reader.poll();
    assert.deepEqual(
      sink.appended.map((e) => e.evidence_key.record_id),
      ['toolu_a', 'toolu_b'],
    );
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

  it('reports a malformed assistant envelope as degraded, not a clean read', async () => {
    // A complete, parseable line whose assistant content is a string, not a block
    // array. It yields no evidence, but it is malformed — coverage must show
    // degraded so it is distinguishable from a clean read with no match.
    const badEnvelope = JSON.stringify({ type: 'assistant', message: { content: 'invalid' } });
    file.append(badEnvelope + '\n');
    const reader = makeReader();
    const r = await reader.poll();
    assert.equal(r.state, 'degraded');
    assert.equal(r.issues[0]!.kind, 'malformed');
    assert.equal(sink.appended.length, 0);
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
