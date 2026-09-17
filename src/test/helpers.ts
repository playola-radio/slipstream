/**
 * Shared test fixtures and harnesses. Mirrors the Playola `server/src/lib`
 * convention: real dependencies wherever the boundary is the thing under test
 * (a real filesystem here, the way Playola uses a real Postgres), with a single
 * injected seam — the engine's `Reader` — for deterministic unit tests. See
 * TESTING.md for the full policy on where we do and do not mock.
 */
import { mkdtemp, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCas, type Cas } from '../cas.ts';
import { createReader, type Reader } from '../reader.ts';
import { createLog, type Log } from '../log.ts';
import type { AnyEvent, CloudEvent } from '../event.ts';
import { createEngine, type Engine } from '../engine.ts';
import { startCapture, type CaptureSession } from '../session.ts';
import { createFakePlatform } from './fake-platform.ts';
import type { Snapshot } from '../snapshot.ts';

/** Every record on disk is a full CloudEvents envelope. */
export type LoggedRecord = AnyEvent;
export type FileChangedEvent = CloudEvent<'slipstream.file.changed.v1'>;

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000000';

/** Build a content snapshot for a given hash (size is incidental to these tests). */
export const content = (sha256: string): Snapshot => ({ kind: 'content', sha256, size: 1 });

/** Create a fresh temp directory that is removed when `fn` settles. */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A content-addressed store rooted in a throwaway temp directory. */
export async function withCas(fn: (cas: Cas) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => fn(await createCas(dir)));
}

/** A reader over a throwaway worktree with its own throwaway blob store. */
export async function withReader(
  fn: (ctx: { root: string; cas: Cas; read: Reader['read'] }) => Promise<void>,
  opts: { maxBytes?: number; openFile?: (path: string, flags: number) => Promise<FileHandle> } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-root-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-store-'));
  try {
    const cas = await createCas(store);
    const reader = createReader({ root, cas, maxBytes: opts.maxBytes, openFile: opts.openFile });
    await fn({ root, cas, read: (p) => reader.read(p) });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

/** A JSONL log in a throwaway temp directory, with a reader for its records. */
export async function withLog(
  fn: (ctx: { log: Log; read: () => Promise<LoggedRecord[]> }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, 'events.jsonl');
    const log = await createLog({ filePath: path, sessionId: TEST_SESSION_ID });
    try {
      await fn({ log, read: () => readRecords(path) });
    } finally {
      await log.close();
    }
  });
}

/** An engine backed by a real log and a caller-supplied (usually fake) reader. */
export async function withEngine(
  reader: Reader,
  fn: (ctx: { engine: Engine; read: () => Promise<LoggedRecord[]> }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const path = join(dir, 'events.jsonl');
    const log = await createLog({ filePath: path, sessionId: TEST_SESSION_ID });
    try {
      await fn({ engine: createEngine({ reader, log }), read: () => readRecords(path) });
    } finally {
      await log.close();
    }
  });
}

/**
 * A full capture session over a fresh worktree and store. `setup` seeds the
 * worktree *before* capture attaches (used to prove baseline behavior).
 */
export async function withSession(
  setup: (root: string) => Promise<void>,
  fn: (ctx: {
    root: string;
    session: CaptureSession;
    waitFor: (predicate: (recs: LoggedRecord[]) => boolean) => Promise<LoggedRecord[]>;
  }) => Promise<void>,
  opts: { maxBytes?: number } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
  let session: CaptureSession | undefined;
  try {
    await setup(root);
    session = await startCapture({ root, storeDir: store, maxBytes: opts.maxBytes });
    const s = session;
    await fn({
      root,
      session: s,
      waitFor: (predicate) => waitForRecords(s.logPath, predicate),
    });
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

/** The `enumerate` seam's signature, for tests that inject a scripted baseline.
 * Derived from `startCapture` so it tracks the production dependency exactly. */
type EnumerateFn = NonNullable<NonNullable<Parameters<typeof startCapture>[1]>['enumerate']>;

/**
 * A capture session driven by the centralized {@link createFakePlatform} instead
 * of real FSEvents. `setup` seeds the worktree before capture attaches (real
 * enumerate baselines it); the test then mutates real files and calls `observe`
 * to deliver the notification explicitly — deterministic, CI-safe, and never
 * dependent on watcher timing. Pass `enumerate` to script the baseline scan
 * (e.g. to simulate an unreadable directory without a real chmod).
 */
export async function withFakeSession(
  setup: (root: string) => Promise<void>,
  fn: (ctx: {
    root: string;
    session: CaptureSession;
    observe: (path: string) => void;
    waitFor: (predicate: (recs: LoggedRecord[]) => boolean) => Promise<LoggedRecord[]>;
  }) => Promise<void>,
  opts: { maxBytes?: number; enumerate?: EnumerateFn } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-fwt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-fst-'));
  const platform = createFakePlatform();
  let session: CaptureSession | undefined;
  try {
    await setup(root);
    session = await startCapture(
      { root, storeDir: store, maxBytes: opts.maxBytes },
      opts.enumerate ? { platform, enumerate: opts.enumerate } : { platform },
    );
    const s = session;
    await fn({
      root,
      session: s,
      observe: (p) => platform.observe(p),
      waitFor: (predicate) => waitForRecords(s.logPath, predicate),
    });
  } finally {
    await session?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

/** Returns each queued snapshot in order, one per `read()` call. */
export function scriptedReader(snapshots: Snapshot[]): Reader {
  const queue = [...snapshots];
  return { read: async () => queue.shift() ?? { kind: 'absent' } };
}

/**
 * Parse a JSONL event log into records (empty if the file does not exist).
 * Tolerant on purpose — it drops an unterminated trailing line so a test can
 * poll a log mid-append. NEVER use this for recovery; startup validation
 * (recovery.ts) must treat a torn or malformed record strictly, not swallow it.
 */
export async function readRecords(logPath: string): Promise<LoggedRecord[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  return complete
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedRecord);
}

/**
 * Poll the log until `predicate` holds, then return the matching records. If the
 * timeout elapses first this THROWS with the records last seen — a predicate that
 * never holds is a real failure, and returning stale records at the deadline
 * would let it masquerade as a pass.
 */
const WAIT_TIMEOUT_MS = 8000;

export async function waitForRecords(
  logPath: string,
  predicate: (recs: LoggedRecord[]) => boolean,
): Promise<LoggedRecord[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const recs = await readRecords(logPath);
    if (predicate(recs)) return recs;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForRecords timed out after ${WAIT_TIMEOUT_MS}ms; last saw ${recs.length} record(s): ${JSON.stringify(recs)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** All `file.changed` records for a single path, in commit order. */
export function changesFor(recs: LoggedRecord[], path: string): FileChangedEvent[] {
  return recs.filter(
    (r): r is FileChangedEvent => r.type === 'slipstream.file.changed.v1' && r.data.path === path,
  );
}
