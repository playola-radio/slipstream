import { mkdir, appendFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Observation } from './observe.ts';

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (err) {
    process.stderr.write(`identity-probe: failed to tighten permissions on ${path}: ${String(err)}\n`);
  }
}

/** Append one observation as a JSONL line. Owner-only perms; the log is gitignored (*.jsonl). */
export async function appendObservation(logPath: string, obs: Observation): Promise<void> {
  const logDir = dirname(logPath);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await chmodBestEffort(logDir, 0o700);
  await appendFile(logPath, JSON.stringify(obs) + '\n', { mode: 0o600 });
  await chmodBestEffort(logPath, 0o600);
}
