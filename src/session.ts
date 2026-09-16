import { mkdir, readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { createCas } from './cas.ts';
import { createReader } from './reader.ts';
import { createLog } from './log.ts';
import { createEngine } from './engine.ts';
import { createWatcher, type Watcher } from './watcher.ts';

export interface CaptureOptions {
  root: string;
  storeDir: string;
  maxBytes?: number;
  /** Extra absolute paths to exclude from capture (beyond .git and the store). */
  exclude?: string[];
}

export interface CaptureSession {
  sessionId: string;
  logPath: string;
  blobsDir: string;
  stop(): Promise<void>;
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureSession> {
  // The native watcher reports realpaths; resolve symlinks in the root (e.g.
  // macOS /var -> /private/var) so relative-path math against events matches.
  const root = await realpath(opts.root);
  const sessionId = randomUUID();
  await mkdir(opts.storeDir, { recursive: true });
  const storeDir = await realpath(opts.storeDir);
  const blobsDir = join(storeDir, 'blobs');
  const sessionDir = join(storeDir, 'sessions', sessionId);
  await mkdir(blobsDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'events.jsonl');

  const cas = await createCas(blobsDir);
  const reader = createReader({ root, cas, maxBytes: opts.maxBytes });
  const log = await createLog(logPath);
  const engine = createEngine({ reader, log });

  // Never capture the store or version-control metadata. If the store lives
  // inside the watched root, excluding it is what stops the watcher from
  // observing its own output.
  const excluded = [storeDir, join(root, '.git'), ...(opts.exclude ?? [])];
  const isExcluded = (abs: string): boolean => excluded.some((e) => isUnder(abs, e));

  let live = false;
  const buffer: Array<[string, number]> = [];
  const onEvent = (abs: string, observedAtMs: number): void => {
    if (isExcluded(abs)) return;
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..')) return;
    if (live) engine.notify(rel, observedAtMs);
    else buffer.push([rel, observedAtMs]);
  };

  // Install the watcher BEFORE enumerating so nothing that happens during the
  // scan is missed; buffered events reconcile against the baseline afterward.
  const watcher: Watcher = await createWatcher({ root, ignore: excluded, onEvent });

  await enumerate(root, root, isExcluded, async (rel) => {
    engine.setBaseline(rel, await reader.read(rel));
  });

  // Go live and reconcile: replay everything observed during the scan. This
  // block runs synchronously (notify is synchronous), so no watcher event can
  // interleave and be lost or double-counted.
  live = true;
  for (const [rel, ts] of buffer) engine.notify(rel, ts);
  buffer.length = 0;

  return {
    sessionId,
    logPath,
    blobsDir,
    stop: async () => {
      await watcher.close();
      await engine.drain();
      await log.close();
    },
  };
}

async function enumerate(
  root: string,
  dir: string,
  isExcluded: (abs: string) => boolean,
  onFile: (rel: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (isExcluded(abs)) continue;
    if (entry.isSymbolicLink()) continue; // excluded, never followed
    if (entry.isDirectory()) {
      await enumerate(root, abs, isExcluded, onFile);
    } else if (entry.isFile()) {
      await onFile(relative(root, abs));
    }
  }
}
