import { mkdir, readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createCas } from './cas.ts';
import { createReader } from './reader.ts';
import { createLog } from './log.ts';
import { createEngine } from './engine.ts';
import { createWatcher, type Watcher } from './watcher.ts';

export interface CaptureOptions {
  root: string;
  storeDir: string;
  maxBytes?: number;
}

export interface CaptureSession {
  sessionId: string;
  logPath: string;
  blobsDir: string;
  stop(): Promise<void>;
}

interface CaptureDependencies {
  createLog: typeof createLog;
  createWatcher: typeof createWatcher;
  enumerate: typeof enumerate;
}

const defaultDependencies: CaptureDependencies = { createLog, createWatcher, enumerate };

/** A relative path escapes its base only via a leading `..` segment (or when it
 * comes back absolute); a filename that merely starts with `..`, like
 * `..notes.ts`, stays inside. */
function escapesBase(rel: string): boolean {
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

function isUnder(child: string, parent: string): boolean {
  return !escapesBase(relative(parent, child));
}

export async function startCapture(
  opts: CaptureOptions,
  dependencies: Partial<CaptureDependencies> = {},
): Promise<CaptureSession> {
  const deps = { ...defaultDependencies, ...dependencies };
  // The native watcher reports realpaths; resolve symlinks in the root (e.g.
  // macOS /var -> /private/var) so relative-path math against events matches.
  const root = await realpath(opts.root);
  const sessionId = randomUUID();
  await mkdir(opts.storeDir, { recursive: true });
  const storeDir = await realpath(opts.storeDir);
  if (isUnder(root, storeDir)) {
    throw new Error('store directory must not equal or contain the watched root');
  }
  const blobsDir = join(storeDir, 'blobs');
  const sessionDir = join(storeDir, 'sessions', sessionId);
  await mkdir(blobsDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'events.jsonl');

  const cas = await createCas(blobsDir);
  const reader = createReader({ root, cas, maxBytes: opts.maxBytes });
  const log = await deps.createLog(logPath);
  const engine = createEngine({ reader, log });

  // Never capture the store or version-control metadata. If the store lives
  // inside the watched root, excluding it is what stops the watcher from
  // observing its own output.
  const excluded = [storeDir, join(root, '.git')];
  const isExcluded = (abs: string): boolean => excluded.some((e) => isUnder(abs, e));

  let live = false;
  const buffer: Array<[string, number]> = [];
  const onEvent = (abs: string, observedAtMs: number): void => {
    if (isExcluded(abs)) return;
    const rel = relative(root, abs);
    if (rel === '' || escapesBase(rel)) return;
    if (live) engine.notify(rel, observedAtMs);
    else buffer.push([rel, observedAtMs]);
  };

  // A native-watcher error means delivery may have lapsed; disclose an honest
  // session-wide coverage gap instead of letting the miss vanish silently.
  const onError = (err: Error): void => {
    console.error(`slipstream: watcher error: ${err.message}`);
    void log.append({ type: 'capture.gap', path: '', reason: 'watcher-error', observed_at_ms: Date.now() }).catch(() => {});
  };

  // Install the watcher BEFORE enumerating so nothing that happens during the
  // scan is missed; buffered events reconcile against the baseline afterward.
  let watcher: Watcher | undefined;
  try {
    watcher = await deps.createWatcher({ root, ignore: excluded, onEvent, onError });

    await deps.enumerate(root, root, isExcluded, {
      onFile: async (rel) => engine.setBaseline(rel, await reader.read(rel)),
      // A directory we could not read means its baseline is unknown; a later
      // change there must not masquerade as a brand-new file (invariant 5), so
      // tell the engine to treat its descendants' prior state as unknown and
      // record the incomplete-baseline gap honestly.
      onDirError: async (relDir) => {
        engine.markBaselineUnknown(relDir);
        await log.append({ type: 'capture.gap', path: relDir, reason: 'baseline-unreadable', observed_at_ms: Date.now() });
      },
    });
  } catch (err) {
    await Promise.allSettled([watcher?.close(), log.close()]);
    throw err;
  }

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

interface EnumerateHandlers {
  onFile: (rel: string) => Promise<void>;
  onDirError: (relDir: string) => Promise<void>;
}

async function enumerate(
  root: string,
  dir: string,
  isExcluded: (abs: string) => boolean,
  handlers: EnumerateHandlers,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    await handlers.onDirError(relative(root, dir));
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (isExcluded(abs)) continue;
    if (entry.isSymbolicLink()) continue; // excluded, never followed
    if (entry.isDirectory()) {
      await enumerate(root, abs, isExcluded, handlers);
    } else if (entry.isFile()) {
      await handlers.onFile(relative(root, abs));
    }
  }
}
