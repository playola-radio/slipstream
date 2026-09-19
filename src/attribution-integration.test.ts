/**
 * End-to-end attribution over a real capture session, driven with FAKE evidence
 * (no real transcript adapters yet — that is A2). These are the honesty
 * acceptance tests: temporal overlap is disclosed as inference, never as
 * authorship; late evidence revises without mutating; a reread adds nothing; a
 * conflict is disclosed, never silently resolved; and a restart reconstructs
 * outstanding work without double-attributing.
 *
 * A short grace keeps the wall-clock small; the semantics are the real ones.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import {
  changesFor,
  readRecords,
  waitForRecords,
  withFakeSession,
  type LoggedRecord,
} from './test/helpers.ts';
import type { ChangeAttributionData, EnrichmentPolicy } from './event.ts';
import type { NormalizedEvidence } from './evidence-ingest.ts';

const FAST_POLICY: EnrichmentPolicy = {
  window_ms: 2000,
  grace_ms: 40,
  sources: { 'claude-code': 'unconfigured', codex: 'unconfigured' },
};

function ev(path: string, atMs: number, recordId: string, toolName = 'Write'): NormalizedEvidence {
  return {
    evidence_key: { harness: 'claude-code', harness_session_id: 'h1', record_id: recordId },
    adapter_version: 'test/1',
    tool_name: toolName,
    timestamp: { at_ms: atMs, basis: 'record-time' },
    file_scope: { kind: 'paths', paths: [path] },
  };
}

/** The observation interval's start for a change's first record (its window anchor). */
function changeStart(recs: LoggedRecord[], path: string): number {
  const iv = changesFor(recs, path)[0]!.data.observed_interval_ms;
  return iv && 'start_ms' in iv ? iv.start_ms : 0;
}

function attributionsFor(recs: LoggedRecord[], changeSeq: string): ChangeAttributionData[] {
  return recs
    .filter((r) => r.type === 'slipstream.change.attribution.v1' && r.data.change_seq === changeSeq)
    .map((r) => r.data as ChangeAttributionData);
}

const evidenceCount = (recs: LoggedRecord[]): number =>
  recs.filter((r) => r.type === 'slipstream.harness.evidence.v1').length;

describe('attribution end-to-end (fake evidence)', () => {
  it('credits a human save inside an agent tool window as heuristic (possibly agent), never silently', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        await writeFile(join(root, 'a.ts'), 'v1');
        observe('a.ts');
        const recs0 = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
        const change = changesFor(recs0, 'a.ts')[0]!;

        await session.ingestEvidence(ev('a.ts', changeStart(recs0, 'a.ts'), 'r1'));
        const recs = await waitFor((r) =>
          attributionsFor(r, change.seq).some((a) => a.status === 'heuristic'),
        );
        const last = attributionsFor(recs, change.seq).at(-1)!;
        assert.equal(last.status, 'heuristic', 'overlap is possible-agent inference');
        assert.equal(last.reason, 'single-candidate');
        assert.deepEqual(last.evidence_seqs.length, 1);
      },
      { enrichmentPolicy: FAST_POLICY },
    );
  });

  it('marks two overlapping parallel invocations ambiguous', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        await writeFile(join(root, 'a.ts'), 'v1');
        observe('a.ts');
        const recs0 = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
        const change = changesFor(recs0, 'a.ts')[0]!;
        const start = changeStart(recs0, 'a.ts');

        await session.ingestEvidence(ev('a.ts', start, 'r1'));
        await session.ingestEvidence(ev('a.ts', start, 'r2'));
        const recs = await waitFor((r) =>
          attributionsFor(r, change.seq).some((a) => a.status === 'ambiguous'),
        );
        const last = attributionsFor(recs, change.seq).at(-1)!;
        assert.equal(last.status, 'ambiguous');
        assert.equal(last.reason, 'multiple-candidates');
      },
      { enrichmentPolicy: FAST_POLICY },
    );
  });

  it('revises an initially-unknown change when late evidence arrives, without mutating the original', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        await writeFile(join(root, 'a.ts'), 'v1');
        observe('a.ts');
        const recs0 = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
        const change = changesFor(recs0, 'a.ts')[0]!;

        // First result lands honest-unknown (no evidence yet), after the grace.
        const unknownRecs = await waitFor((r) =>
          attributionsFor(r, change.seq).some((a) => a.status === 'unknown'),
        );
        const firstAttrEvent = unknownRecs.find(
          (r) => r.type === 'slipstream.change.attribution.v1' && r.data.change_seq === change.seq,
        )!;

        // Late evidence arrives: a revision is appended, the original is immutable.
        await session.ingestEvidence(ev('a.ts', changeStart(recs0, 'a.ts'), 'r1'));
        const recs = await waitFor((r) =>
          attributionsFor(r, change.seq).some((a) => a.status === 'heuristic'),
        );
        const attrs = attributionsFor(recs, change.seq);
        assert.ok(attrs.length >= 2, 'a revision is appended, not an overwrite');
        assert.equal(attrs[0]!.status, 'unknown');
        assert.equal(attrs.at(-1)!.status, 'heuristic');
        const stillFirst = recs.find(
          (r) => r.type === 'slipstream.change.attribution.v1' && r.data.change_seq === change.seq,
        )!;
        assert.equal(stillFirst.seq, firstAttrEvent.seq, 'the original attribution event is immutable');
      },
      { enrichmentPolicy: FAST_POLICY },
    );
  });

  it('re-reading unchanged evidence appends nothing', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        await writeFile(join(root, 'a.ts'), 'v1');
        observe('a.ts');
        const recs0 = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
        const change = changesFor(recs0, 'a.ts')[0]!;

        const first = await session.ingestEvidence(ev('a.ts', changeStart(recs0, 'a.ts'), 'r1'));
        assert.equal(first.status, 'appended');
        await waitFor((r) => attributionsFor(r, change.seq).some((a) => a.status === 'heuristic'));

        const second = await session.ingestEvidence(ev('a.ts', changeStart(recs0, 'a.ts'), 'r1'));
        assert.deepEqual(second, { status: 'duplicate' }, 'an identical reread is a no-op');
        assert.equal(evidenceCount(await readRecords(session.logPath)), 1, 'no duplicate evidence event');
      },
      { enrichmentPolicy: FAST_POLICY },
    );
  });

  it('discloses conflicting evidence under one native key, never a silent overwrite', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        await writeFile(join(root, 'a.ts'), 'v1');
        observe('a.ts');
        const recs0 = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
        const change = changesFor(recs0, 'a.ts')[0]!;
        const start = changeStart(recs0, 'a.ts');

        // Same native key r1, disagreeing normalized content: both retained.
        const a = await session.ingestEvidence(ev('a.ts', start, 'r1', 'Write'));
        const b = await session.ingestEvidence(ev('a.ts', start, 'r1', 'Edit'));
        assert.equal(a.status, 'appended');
        assert.equal(b.status, 'appended');
        assert.equal(evidenceCount(await readRecords(session.logPath)), 2, 'both variants kept');

        const recs = await waitFor((r) =>
          attributionsFor(r, change.seq).some((x) => (x.excluded_conflicts?.length ?? 0) > 0),
        );
        const last = attributionsFor(recs, change.seq).at(-1)!;
        assert.equal(last.status, 'unknown');
        assert.equal(last.reason, 'no-matching-evidence');
        assert.equal(last.excluded_conflicts?.[0]?.record_id, 'r1');
      },
      { enrichmentPolicy: FAST_POLICY },
    );
  });

  it('reconstructs outstanding attribution across a restart without double-attributing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slip-attr-root-'));
    const store = await mkdtemp(join(tmpdir(), 'slip-attr-store-'));
    const platform = createFakePlatform();
    try {
      const s1 = await startCapture(
        { root, storeDir: store, enrichmentPolicy: FAST_POLICY },
        { platform },
      );
      const sessionId = s1.sessionId;
      await writeFile(join(root, 'a.ts'), 'v1');
      platform.observe('a.ts');
      const recs1 = await waitForRecords(s1.logPath, (r) => changesFor(r, 'a.ts').length >= 1);
      const changeSeq = changesFor(recs1, 'a.ts')[0]!.seq;
      await s1.ingestEvidence(ev('a.ts', changeStart(recs1, 'a.ts'), 'r1'));
      const settled = await waitForRecords(s1.logPath, (r) =>
        attributionsFor(r, changeSeq).some((a) => a.status === 'heuristic'),
      );
      const priorCount = attributionsFor(settled, changeSeq).length;
      await s1.stop();

      const s2 = await startCapture(
        { root, storeDir: store, resumeSessionId: sessionId, enrichmentPolicy: FAST_POLICY },
        { platform },
      );
      try {
        // Let the replay barrier reconstruct and re-evaluate the outstanding change.
        await waitForRecords(s2.logPath, (r) =>
          r.some((e) => e.type === 'slipstream.session.resumed.v1'),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        const after = attributionsFor(await readRecords(s2.logPath), changeSeq);
        assert.equal(after.length, priorCount, 'the reproduced result is not re-appended');
        assert.equal(after.at(-1)!.status, 'heuristic', 'the prior result survives the restart');
      } finally {
        await s2.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });
});
