import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Observation } from './observe.ts';

/** Append one observation as a JSONL line. Owner-only perms; the log is gitignored (*.jsonl). */
export async function appendObservation(logPath: string, obs: Observation): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await appendFile(logPath, JSON.stringify(obs) + '\n', { mode: 0o600 });
}
