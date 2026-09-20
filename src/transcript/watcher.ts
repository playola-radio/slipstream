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
import type { DiscoveryIO, TranscriptBinding } from './discovery.ts';
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
 * merely-not-yet-written home stays `pending`. An unconfirmed replacement degrades
 * a readable aggregate but stays pending when alone.
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
  let withheld = false;
  for (const f of files) {
    if (f.state === 'readable' || f.state === 'degraded') {
      readCount += 1;
      if (f.backpressured) backpressured = true;
      for (const d of f.issues) issues.push({ kind: d.kind, detail: d.detail });
    } else if (f.state === 'unconfirmed') {
      withheld = true;
      // The file at this path was replaced (a new inode) and discovery has not yet
      // re-confirmed the replacement's membership/scope. It is neither read nor a
      // failure: withhold it (pending-compatible, no issue) so a one-tick self-healing
      // replacement race never flaps coverage to unavailable. Next tick's discovery
      // re-derives the binding for the new generation (recreating this reader if it is
      // a confirmed in-root member, or dropping it if it is out-of-root); nothing is
      // dropped, enrichment is delayed one tick.
      continue;
    } else if (f.state === 'missing') {
      issues.push({ kind: 'missing', detail: `transcript ${f.path ?? 'transcript'} disappeared` });
    } else {
      issues.push({ kind: 'inaccessible', detail: `transcript ${f.path ?? 'transcript'} unreadable` });
    }
  }
  let state: CoverageState;
  if (readCount > 0) {
    state = issues.length > 0 || backpressured || withheld ? 'degraded' : 'readable';
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

/** The identity that gates reader reuse: the harness session, the resolved scope
 * (canonical cwd + root aliases), AND the file generation. A change in the ctx means
 * the prior reader was reading under a scope discovery has since corrected — most
 * often a provisional binding, made while the transcript was empty, whose real
 * cwd/aliases discovery only learned once records (or a cwd-bearing record past a
 * leading summary) appeared. A change in the generation means the file at this path
 * was replaced (a new inode) and discovery has re-confirmed the replacement in-root:
 * the old reader is pinned to the prior inode and would refuse the new one, so it is
 * dropped and a fresh reader is created against the confirmed new generation. */
function bindingReaderKey(binding: TranscriptBinding): string {
  const { ctx, generation } = binding;
  return `${ctx.harnessSessionId}\0${ctx.cwd}\0${(ctx.rootAliases ?? []).join(',')}\0${generation.dev}:${generation.ino}`;
}

export function createTranscriptWatcher(opts: TranscriptWatcherOptions): TranscriptWatcher {
  const { harness, home, root, codexScanLimit, discoveryIO, fileIO, sink, publish } = opts;
  const readers = new Map<
    string,
    { reader: ReturnType<typeof createTranscriptFileReader>; ctxKey: string }
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
      // Recreate the reader whenever its bound context or file generation changes: a
      // changed session id is a rotated transcript (the same file name now belongs to
      // a different harness session), a changed cwd/aliases is a provisional binding
      // (made while the transcript was empty, or before a cwd-bearing record appeared
      // past a leading summary) that discovery has since resolved to the real scope,
      // and a changed generation is a replacement (new inode) discovery has re-confirmed
      // in-root. In every case the old reader read under a scope/generation that no
      // longer applies, so drop it and reread from zero; the ingestor's log-derived
      // dedup absorbs the re-read. This never conflicts an invocation: a record already
      // read under the prior binding implies its cwd was known then (aliases are derived
      // from the transcript's own cwd), so its scope does not change on the reread;
      // only records first seen after the resolution get the corrected scope.
      const ctxKey = bindingReaderKey(binding);
      let entry = readers.get(binding.path);
      if (!entry || entry.ctxKey !== ctxKey) {
        entry = {
          reader: createTranscriptFileReader({
            path: binding.path,
            io: fileIO,
            sink,
            stepper: makeStepper(harness, binding.ctx),
            generation: binding.generation,
          }),
          ctxKey,
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
