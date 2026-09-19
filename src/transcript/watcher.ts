/**
 * Per-active-session transcript watcher: on each tick it re-runs discovery,
 * keeps one incremental {@link createTranscriptFileReader} per discovered
 * transcript, polls them, folds their per-file health into one honest
 * per-harness {@link CoverageState}, and publishes a coverage event only when
 * that state (or its issue set) changes.
 *
 * Idempotence is inherited, not added: readers hold only an in-memory offset and
 * the ingestor's log-derived dedup absorbs any re-read, so a late transcript
 * arriving after a restart revises without duplicate evidence. The watcher never
 * creates a `file.changed` — it only refines and discloses coverage.
 */
import type { CoverageIssue, CoverageState, EnrichmentCoverageData, HarnessName } from '../event.ts';
import type { DiscoveryIO } from './discovery.ts';
import { discover } from './discovery.ts';
import {
  createTranscriptFileReader,
  type EvidenceSink,
  type FileReadResult,
  type TranscriptFileIO,
} from './file-reader.ts';
import { claudeStepper, codexStepper } from './steppers.ts';
import type { AdapterContext } from './types.ts';

export type CoveragePublish = (
  data: Omit<EnrichmentCoverageData, 'session_id'>,
) => Promise<void>;

export interface TranscriptWatcherOptions {
  harness: HarnessName;
  home: string;
  root: string;
  codexScanLimit: number;
  discoveryIO: DiscoveryIO;
  fileIO: TranscriptFileIO;
  sink: EvidenceSink;
  publish: CoveragePublish;
}

export interface TranscriptWatcher {
  /** Run one discovery + read pass; ingest evidence and publish coverage on change. */
  tick(): Promise<void>;
}

/**
 * Fold discovery issues and per-file read results into one honest coverage
 * verdict. A file that was actually read (`readable`/`degraded`) counts as
 * coverage; a `missing`/`inaccessible` file did not. Any issue at all — or a file
 * whose evidence is still held back by ingestion backpressure — downgrades a
 * successful read to `degraded`, so one readable transcript never conceals an
 * unreadable sibling and `readable` never claims a scope whose evidence has not
 * yet been recorded. With nothing read, a hard failure is `unavailable` while a
 * merely-not-yet-written home stays `pending`.
 */
export function aggregateCoverage(
  discoveryIssues: readonly CoverageIssue[],
  files: ReadonlyArray<{
    state: FileReadResult['state'];
    issues: FileReadResult['issues'];
    backpressured?: boolean;
    path?: string;
  }>,
): { state: CoverageState; issues: CoverageIssue[] } {
  const issues: CoverageIssue[] = [...discoveryIssues];
  let readCount = 0;
  let backpressured = false;
  for (const f of files) {
    if (f.state === 'readable' || f.state === 'degraded') {
      readCount += 1;
      if (f.backpressured) backpressured = true;
      for (const d of f.issues) issues.push({ kind: d.kind, detail: d.detail });
    } else if (f.state === 'missing') {
      issues.push({ kind: 'missing', detail: `transcript ${f.path ?? 'transcript'} disappeared` });
    } else {
      issues.push({ kind: 'inaccessible', detail: `transcript ${f.path ?? 'transcript'} unreadable` });
    }
  }
  let state: CoverageState;
  if (readCount > 0) {
    state = issues.length > 0 || backpressured ? 'degraded' : 'readable';
  } else {
    const hardFailure = issues.some((i) => i.kind !== 'missing');
    state = hardFailure ? 'unavailable' : 'pending';
  }
  return { state, issues };
}

function coverageKey(data: Omit<EnrichmentCoverageData, 'session_id'>): string {
  const issues = (data.issues ?? [])
    .map((i) => `${i.kind}:${i.detail}`)
    .sort()
    .join('|');
  return `${data.state}#${issues}`;
}

function makeStepper(harness: HarnessName, ctx: AdapterContext) {
  return harness === 'claude-code' ? claudeStepper(ctx) : codexStepper(ctx);
}

export function createTranscriptWatcher(opts: TranscriptWatcherOptions): TranscriptWatcher {
  const { harness, home, root, codexScanLimit, discoveryIO, fileIO, sink, publish } = opts;
  const readers = new Map<
    string,
    { reader: ReturnType<typeof createTranscriptFileReader>; sessionId: string }
  >();
  let lastKey: string | undefined;

  const tick = async (): Promise<void> => {
    const { bindings, issues: discoveryIssues } = await discover(
      harness,
      discoveryIO,
      home,
      root,
      codexScanLimit,
    );

    const perFile: Array<{
      state: FileReadResult['state'];
      issues: FileReadResult['issues'];
      backpressured: boolean;
      path: string;
    }> = [];
    for (const binding of bindings) {
      // Recreate the reader only when the file name now belongs to a different
      // harness session (a rotated transcript): the old reader's offset and join
      // state no longer apply, so drop it and reread from zero; the ingestor's
      // log-derived dedup absorbs the re-read. A provisional binding later
      // resolving its cwd does NOT force a recreate — Claude writes are scoped by
      // their absolute path (relative ones are disclosed unknown), so the emitted
      // scope never depends on which cwd the binding settled on.
      const sessionId = binding.ctx.harnessSessionId;
      let entry = readers.get(binding.path);
      if (!entry || entry.sessionId !== sessionId) {
        entry = {
          reader: createTranscriptFileReader({
            path: binding.path,
            io: fileIO,
            sink,
            stepper: makeStepper(harness, binding.ctx),
          }),
          sessionId,
        };
        readers.set(binding.path, entry);
      }
      const result = await entry.reader.poll();
      perFile.push({
        state: result.state,
        issues: result.issues,
        backpressured: result.backpressured,
        path: binding.path,
      });
    }

    const coverage = aggregateCoverage(discoveryIssues, perFile);
    const data: Omit<EnrichmentCoverageData, 'session_id'> =
      coverage.issues.length > 0
        ? { harness, state: coverage.state, issues: coverage.issues }
        : { harness, state: coverage.state };
    const key = coverageKey(data);
    if (key !== lastKey) {
      await publish(data);
      lastKey = key;
    }
  };

  return { tick };
}
