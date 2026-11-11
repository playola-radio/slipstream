import { open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { FILE_MODE, StorageError, fsyncDir, writeAll } from './storage.ts';
import { namePath } from './store-reader.ts';

/**
 * `sessions/<id>/name.json`: the agent's and the user's display names for one
 * session. A sidebar file, never a log record. Names are display-only, so a
 * malformed file reads as unnamed (with a reason the caller logs) rather than
 * failing; the next write replaces it. An unreadable file is a StorageError, so
 * a writer never replaces a name it could not read. Names are not re-validated
 * on read: the daemon is the only writer.
 */
export interface Naming { agent_name: string | null; user_name: string | null }

const UNNAMED: Naming = { agent_name: null, user_name: null };

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseNaming(raw: string): Naming | string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 'not valid JSON'; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'not a JSON object';
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1) return 'version is not 1';
  if (!('agent_name' in o) || !('user_name' in o)) return 'a name key is missing';
  if (!nullableString(o.agent_name) || !nullableString(o.user_name)) return 'a name is neither a string nor null';
  return { agent_name: o.agent_name, user_name: o.user_name };
}

export async function readNaming(storeDir: string, id: string): Promise<{ naming: Naming; malformed?: string }> {
  let raw: string;
  try {
    raw = await readFile(namePath(storeDir, id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { naming: { ...UNNAMED } };
    throw new StorageError('read-name', err);
  }
  const naming = parseNaming(raw);
  return typeof naming === 'string' ? { naming: { ...UNNAMED }, malformed: naming } : { naming };
}

/**
 * Publish `name.json` crash-safe, as `publishTombstone` does: unique temp
 * `wx`/0600, full write, fsync, atomic rename, fsync the session dir. Never
 * creates the directory. `assertOwnership` runs after the temp file's fsync and
 * immediately before the rename, with no await between; a throw publishes
 * nothing and propagates unchanged.
 */
export async function writeNaming(
  storeDir: string, id: string, naming: Naming, assertOwnership: () => void,
): Promise<void> {
  const dest = namePath(storeDir, id);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  const body = Buffer.from(JSON.stringify({ version: 1, agent_name: naming.agent_name, user_name: naming.user_name }) + '\n', 'utf8');
  let handle;
  try {
    try {
      handle = await open(tmp, 'wx', FILE_MODE);
      await writeAll(handle, body);
      await handle.sync();
    } catch (err) {
      throw new StorageError('write-name', err);
    } finally {
      await handle?.close();
    }
    assertOwnership();
    try {
      await rename(tmp, dest);
    } catch (err) {
      throw new StorageError('rename-name', err);
    }
    await fsyncDir(dirname(dest));
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
