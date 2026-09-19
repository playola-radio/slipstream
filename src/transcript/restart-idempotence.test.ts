import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture, type TranscriptRuntime } from '../session.ts';
import { createFakePlatform } from '../test/fake-platform.ts';
import { readRecords, waitForRecords, type LoggedRecord } from '../test/helpers.ts';
import { claudeSlug, type DiscoveryIO, type ListResult } from './discovery.ts';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';
import type { HarnessName } from '../event.ts';

const HOME = '/fake-home';

/** A single in-memory transcript whose bytes can grow between "restarts". */
class MemTranscript {
  buf = Buffer.alloc(0);
  append(line: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(line + '\n', 'utf8')]);
  }
}

function assistantWrite(id: string, absPath: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-19T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: absPath } }] },
  });
}

/** Discovery + file IO that serve one Claude transcript from a MemTranscript. */
function transcriptRuntime(root: string, path: string, mem: MemTranscript): TranscriptRuntime {
  const dir = `${HOME}/projects/${claudeSlug(root)}`;
  const discoveryIO: DiscoveryIO = {
    listDir: async (d): Promise<ListResult> =>
      d === dir ? { ok: true, paths: [path] } : { ok: false, reason: 'missing' },
    listTreeJsonl: async () => ({ paths: [], truncated: false }),
    readFirstLine: async () => undefined,
    realpath: async (p) => p,
  };
  const fileIO: TranscriptFileIO = {
    async stat(p): Promise<StatResult> {
      if (p !== path) return { ok: false, reason: 'missing' };
      return { ok: true, size: mem.buf.length, dev: 1, ino: 42 };
    },
    async read(p, start, end): Promise<Buffer> {
      if (p !== path) throw new Error('missing');
      return mem.buf.subarray(start, end);
    },
  };
  const homes: Record<HarnessName, string> = { 'claude-code': HOME, codex: HOME };
  return { harnesses: ['claude-code'], homes, codexScanLimit: 1000, pollIntervalMs: 15, discoveryIO, fileIO };
}

const EVIDENCE = 'slipstream.harness.evidence.v1';
function evidenceIds(recs: LoggedRecord[]): string[] {
  return recs
    .filter((r) => r.type === EVIDENCE)
    .map((r) => (r.data as { evidence_key: { record_id: string } }).evidence_key.record_id);
}

describe('transcript restart idempotence', () => {
  it('re-reads a grown transcript after restart, revising without duplicate evidence', async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), 'slip-tr-'));
    const store = await mkdtemp(join(tmpdir(), 'slip-ts-'));
    // The session canonicalizes root via realpath; discovery slugs the canonical
    // form, so the fake IO and transcript file paths must use it too.
    const root = await realpath(rawRoot);
    try {
      const path = `${HOME}/projects/${claudeSlug(root)}/sess-x.jsonl`;
      const mem = new MemTranscript();
      mem.append(assistantWrite('toolu_a', join(root, 'a.ts')));

      const platform = createFakePlatform();
      const s1 = await startCapture(
        { root, storeDir: store, transcript: transcriptRuntime(root, path, mem) },
        { platform },
      );
      const sessionId = s1.sessionId;
      // The first record's evidence lands via the immediate tick.
      await waitForRecords(s1.logPath, (r) => evidenceIds(r).includes('toolu_a'));
      await s1.stop();

      // A late record is appended to the SAME transcript after the session stopped.
      mem.append(assistantWrite('toolu_b', join(root, 'b.ts')));

      // Resume: a fresh watcher rereads the whole transcript from offset zero. The
      // ingestor's log-derived dedup absorbs the replayed prefix; only the late
      // record is appended.
      const platform2 = createFakePlatform();
      const s2 = await startCapture(
        { root, storeDir: store, resumeSessionId: sessionId, transcript: transcriptRuntime(root, path, mem) },
        { platform: platform2 },
      );
      try {
        await waitForRecords(s2.logPath, (r) => evidenceIds(r).includes('toolu_b'));
        const ids = evidenceIds(await readRecords(s2.logPath));
        assert.equal(ids.filter((x) => x === 'toolu_a').length, 1, 'the replayed record is not duplicated');
        assert.equal(ids.filter((x) => x === 'toolu_b').length, 1, 'the late record is appended once');
      } finally {
        await s2.stop();
      }
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });
});
