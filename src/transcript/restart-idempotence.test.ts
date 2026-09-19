import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture, type TranscriptRuntime } from '../session.ts';
import { createFakePlatform } from '../test/fake-platform.ts';
import { changesFor, readRecords, waitForRecords, type LoggedRecord } from '../test/helpers.ts';
import { claudeSlug, type DiscoveryIO, type ListResult } from './discovery.ts';
import type { StatResult, TranscriptFileIO } from './file-reader.ts';
import type { ChangeAttributionData, EnrichmentPolicy, HarnessName } from '../event.ts';

const HOME = '/fake-home';

const FAST_POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 40,
  sources: { 'claude-code': 'configured', codex: 'unconfigured' },
};

/** A single in-memory transcript whose bytes can grow between "restarts". */
class MemTranscript {
  buf = Buffer.alloc(0);
  append(line: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(line + '\n', 'utf8')]);
  }
}

/** A Claude tool_use whose timestamp lands inside its change's observation window,
 * so its evidence attributes (possibly-agent) the matching filesystem change. */
function assistantWrite(id: string, absPath: string, atMs: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: absPath } }] },
  });
}

function changeStart(recs: LoggedRecord[], path: string): number {
  const iv = changesFor(recs, path)[0]!.data.observed_interval_ms;
  return iv && 'start_ms' in iv ? iv.start_ms : 0;
}

function attributionsFor(recs: LoggedRecord[], changeSeq: string): ChangeAttributionData[] {
  return recs
    .filter((r) => r.type === 'slipstream.change.attribution.v1' && r.data.change_seq === changeSeq)
    .map((r) => r.data as ChangeAttributionData);
}

/** Discovery + file IO that serve one Claude transcript from a MemTranscript. */
function transcriptRuntime(root: string, path: string, mem: MemTranscript): TranscriptRuntime {
  const dir = `${HOME}/projects/${claudeSlug(root)}`;
  // Membership is confirmed by a recorded cwd; the session's cwd is the worktree
  // root. (Real transcripts carry it on an early user record, not the tool_use
  // write, so discovery reports it independently of the evidence bytes.)
  const cwdRecord = JSON.stringify({ type: 'user', cwd: root, message: { content: 'hi' } });
  const discoveryIO: DiscoveryIO = {
    listDir: async (d): Promise<ListResult> =>
      d === dir ? { ok: true, paths: [path] } : { ok: false, reason: 'missing' },
    listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: false }),
    readFirstLine: async () =>
      mem.buf.length > 0 ? { ok: true, line: cwdRecord } : { ok: false, reason: 'empty' },
    readHeadLines: async () => ({
      ok: true,
      lines: mem.buf.length > 0 ? [cwdRecord] : [],
      truncated: false,
    }),
    realpath: async (p) => p,
    probe: async () => ({ kind: 'absent' }),
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
  it('lets a late transcript after restart revise attribution without duplicate evidence', async () => {
    const rawRoot = await mkdtemp(join(tmpdir(), 'slip-tr-'));
    const store = await mkdtemp(join(tmpdir(), 'slip-ts-'));
    // The session canonicalizes root via realpath; discovery slugs the canonical
    // form, so the fake IO and transcript file paths must use it too.
    const root = await realpath(rawRoot);
    try {
      const path = `${HOME}/projects/${claudeSlug(root)}/sess-x.jsonl`;
      const mem = new MemTranscript();

      const platform = createFakePlatform();
      const s1 = await startCapture(
        { root, storeDir: store, enrichmentPolicy: FAST_POLICY, transcript: transcriptRuntime(root, path, mem) },
        { platform },
      );
      const sessionId = s1.sessionId;

      // Two real filesystem changes are captured; the transcript that would
      // attribute the second one has not been written yet.
      await writeFile(join(root, 'a.ts'), 'v1');
      platform.observe('a.ts');
      await writeFile(join(root, 'b.ts'), 'v1');
      platform.observe('b.ts');
      const changed = await waitForRecords(
        s1.logPath,
        (r) => changesFor(r, 'a.ts').length >= 1 && changesFor(r, 'b.ts').length >= 1,
      );
      const changeA = changesFor(changed, 'a.ts')[0]!.seq;
      const changeB = changesFor(changed, 'b.ts')[0]!.seq;

      // The transcript so far only covers a.ts. Its evidence attributes a.ts
      // (possibly-agent); b.ts has no candidate and settles honest-unknown.
      mem.append(assistantWrite('toolu_a', join(root, 'a.ts'), changeStart(changed, 'a.ts')));
      await waitForRecords(s1.logPath, (r) =>
        attributionsFor(r, changeA).some((a) => a.status === 'heuristic'),
      );
      const beforeRestart = await waitForRecords(s1.logPath, (r) =>
        attributionsFor(r, changeB).some((a) => a.status === 'unknown'),
      );
      assert.equal(
        attributionsFor(beforeRestart, changeB).at(-1)!.status,
        'unknown',
        'b.ts is honest-unknown while its transcript is missing',
      );
      await s1.stop();

      // The late transcript for b.ts is appended to the SAME file after the stop.
      mem.append(assistantWrite('toolu_b', join(root, 'b.ts'), changeStart(changed, 'b.ts')));

      // Resume: a fresh watcher rereads the whole transcript from offset zero. The
      // ingestor's log-derived dedup absorbs the replayed a.ts prefix; only the
      // late b.ts evidence is appended, and it REVISES b.ts from unknown to
      // possibly-agent.
      const platform2 = createFakePlatform();
      const s2 = await startCapture(
        {
          root,
          storeDir: store,
          resumeSessionId: sessionId,
          enrichmentPolicy: FAST_POLICY,
          transcript: transcriptRuntime(root, path, mem),
        },
        { platform: platform2 },
      );
      try {
        const after = await waitForRecords(s2.logPath, (r) =>
          attributionsFor(r, changeB).some((a) => a.status === 'heuristic'),
        );

        const ids = evidenceIds(after);
        assert.equal(ids.filter((x) => x === 'toolu_a').length, 1, 'the replayed record is not duplicated');
        assert.equal(ids.filter((x) => x === 'toolu_b').length, 1, 'the late record is appended once');

        const bAttrs = attributionsFor(after, changeB);
        assert.ok(bAttrs.length >= 2, 'a revision is appended, not an overwrite');
        assert.equal(bAttrs[0]!.status, 'unknown', 'the pre-restart result stands');
        assert.equal(bAttrs.at(-1)!.status, 'heuristic', 'the late transcript revises b.ts to possibly-agent');
      } finally {
        await s2.stop();
      }
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });
});
