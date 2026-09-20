import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageRunner } from './runner.ts';
import type { DiscoveryIO, ListResult } from './discovery.ts';
import type { EvidenceSink, TranscriptFileIO, TranscriptReadResult } from './file-reader.ts';
import type { HarnessName, EnrichmentCoverageData } from '../event.ts';
import type { IngestOutcome, NormalizedEvidence } from '../evidence-ingest.ts';

const ROOT = '/work/proj';
const HOMES: Record<HarnessName, string> = { 'claude-code': '/home/.claude', codex: '/home/.codex' };

class FakeSink implements EvidenceSink {
  appended: NormalizedEvidence[] = [];
  async ingest(evidence: NormalizedEvidence): Promise<IngestOutcome> {
    this.appended.push(evidence);
    return { status: 'appended', seq: BigInt(this.appended.length) };
  }
}

const emptyFileIO: TranscriptFileIO = {
  async readFrom(_path: string, _start: number, _maxBytes: number): Promise<TranscriptReadResult> {
    return { ok: false, reason: 'missing' };
  },
};

function discoveryIO(overrides: Partial<DiscoveryIO>): DiscoveryIO {
  return {
    listDir: async (): Promise<ListResult> => ({ ok: false, reason: 'missing' }),
    listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: false }),
    readFirstLine: async () => ({ ok: false, reason: 'empty' }),
    readHeadLines: async () => ({ ok: true, lines: [], truncated: false, skipped: false, id: { dev: 1n, ino: 1n } }),
    realpath: async (p) => p,
    probe: async () => ({ kind: 'absent' }),
    ...overrides,
  };
}

describe('coverage runner', () => {
  it('ticks every configured harness and publishes a coverage event per harness', async () => {
    const published: EnrichmentCoverageData['harness'][] = [];
    const runner = createCoverageRunner({
      harnesses: ['claude-code', 'codex'],
      homes: HOMES,
      codexScanLimit: 1000,
      root: ROOT,
      sink: new FakeSink(),
      publish: async (d) => {
        published.push(d.harness);
      },
      discoveryIO: discoveryIO({ listTreeJsonl: async () => ({ paths: [], truncated: false, incomplete: false }) }),
      fileIO: emptyFileIO,
      intervalMs: 1000,
    });
    await runner.tick();
    assert.deepEqual(published.sort(), ['claude-code', 'codex']);
  });

  it('keeps ticking other harnesses when one throws, routing the error aside', async () => {
    const published: HarnessName[] = [];
    const errors: unknown[] = [];
    const runner = createCoverageRunner({
      harnesses: ['claude-code', 'codex'],
      homes: HOMES,
      codexScanLimit: 1000,
      root: ROOT,
      sink: new FakeSink(),
      publish: async (d) => {
        published.push(d.harness);
      },
      discoveryIO: discoveryIO({
        listDir: async () => {
          throw new Error('claude discovery blew up');
        },
      }),
      fileIO: emptyFileIO,
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    await runner.tick();
    assert.equal(errors.length, 1);
    assert.deepEqual(published, ['codex']);
  });

  it('start() fires an immediate tick and stop() prevents any reschedule', async () => {
    let scheduled: (() => void) | undefined;
    const published: HarnessName[] = [];
    const runner = createCoverageRunner({
      harnesses: ['claude-code'],
      homes: HOMES,
      codexScanLimit: 1000,
      root: ROOT,
      sink: new FakeSink(),
      publish: async (d) => {
        published.push(d.harness);
      },
      discoveryIO: discoveryIO({}),
      fileIO: emptyFileIO,
      intervalMs: 1000,
      setTimer: (_ms, fn) => {
        scheduled = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        scheduled = undefined;
      },
    });
    runner.start();
    await runner.stop(); // awaits the in-flight immediate tick
    assert.equal(published.length, 1, 'the immediate tick ran once');
    assert.equal(scheduled, undefined, 'no further tick is scheduled after stop');
  });
});
