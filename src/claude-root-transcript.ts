import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { HEAD_LINE_CAP, HEAD_SCAN_BYTES, HEAD_SCAN_LINES } from './transcript/fs-io.ts';

export type ClaudeRootResult = { ok: true } | { ok: false; reason: 'unavailable' | 'not-yet' | 'gap' | 'mismatch' | 'unsupported-version' };

const RUNTIMES = new Map([
  ['2.1.280', 'sdk-ts'], // Conductor's observed Claude Code launch
  ['2.1.283', 'sdk-cli'], // Terminal's observed Claude Code launch
]);
const FATAL_UTF8 = new TextDecoder('utf8', { fatal: true });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Verify the explicit root transcript from complete, bounded startup records.
 * Claude can write cwd-less preamble lines before the first user/attachment
 * record, and may still be writing the last line while attach reads. Every
 * complete bounded line is parsed; the first identity record fixes the root
 * cwd and identity, while later records must not conflict with the binding.
 */
export async function verifyClaudeRootTranscript(path: string, sessionId: string, worktree: string): Promise<ClaudeRootResult> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return { ok: false, reason: 'unavailable' };
    // The extra byte distinguishes an exact bound from a head with more records.
    const bytes = Buffer.alloc(HEAD_SCAN_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    let start = 0;
    let lines = 0;
    let version: string | undefined;
    let entrypoint: string | undefined;
    let rootCwd: string | undefined;
    for (let i = 0; i < total && lines < HEAD_SCAN_LINES; i += 1) {
      if (bytes[i] !== 0x0a) continue;
      if (i - start > HEAD_LINE_CAP || i >= HEAD_SCAN_BYTES) return { ok: false, reason: 'gap' };
      let parsed: Record<string, unknown> | null;
      try { parsed = record(JSON.parse(FATAL_UTF8.decode(bytes.subarray(start, i)))); }
      catch { return { ok: false, reason: 'gap' }; }
      if (!parsed) return { ok: false, reason: 'gap' };
      lines += 1;
      start = i + 1;
      if (Object.hasOwn(parsed, 'sessionId') && parsed.sessionId !== sessionId) return { ok: false, reason: 'mismatch' };
      const hasIdentityField = Object.hasOwn(parsed, 'cwd') || Object.hasOwn(parsed, 'version')
        || Object.hasOwn(parsed, 'entrypoint') || Object.hasOwn(parsed, 'isSidechain');
      if (!hasIdentityField) continue;
      if (version === undefined) {
        if (parsed.sessionId !== sessionId || typeof parsed.cwd !== 'string' || parsed.cwd.length === 0
          || typeof parsed.version !== 'string' || parsed.version.length === 0
          || typeof parsed.entrypoint !== 'string' || parsed.userType !== 'external'
          || parsed.isSidechain !== false || (parsed.type !== 'user' && parsed.type !== 'attachment')) {
          return { ok: false, reason: 'mismatch' };
        }
        const allowedEntrypoint = RUNTIMES.get(parsed.version);
        if (allowedEntrypoint === undefined) return { ok: false, reason: 'unsupported-version' };
        if (parsed.entrypoint !== allowedEntrypoint) return { ok: false, reason: 'mismatch' };
        try { if (await realpath(parsed.cwd) !== worktree) return { ok: false, reason: 'mismatch' }; }
        catch { return { ok: false, reason: 'mismatch' }; }
        version = parsed.version;
        entrypoint = parsed.entrypoint;
        rootCwd = parsed.cwd as string;
      } else if ((Object.hasOwn(parsed, 'version') && parsed.version !== version)
        || (Object.hasOwn(parsed, 'entrypoint') && parsed.entrypoint !== entrypoint)
        || (Object.hasOwn(parsed, 'cwd') && parsed.cwd !== rootCwd)
        || (Object.hasOwn(parsed, 'userType') && parsed.userType !== 'external')
        || (Object.hasOwn(parsed, 'isSidechain') && parsed.isSidechain !== false)) {
        return { ok: false, reason: 'mismatch' };
      }
    }
    if (lines < HEAD_SCAN_LINES && total > HEAD_SCAN_BYTES) return { ok: false, reason: 'gap' };
    if (lines < HEAD_SCAN_LINES && total - start > HEAD_LINE_CAP) return { ok: false, reason: 'gap' };
    // A torn record inside the bounded head may still be written; attach is retryable.
    if (lines < HEAD_SCAN_LINES && start < total) return { ok: false, reason: 'not-yet' };
    if (version === undefined) return { ok: false, reason: lines === HEAD_SCAN_LINES ? 'gap' : 'not-yet' };
    return { ok: true };
  } catch { return { ok: false, reason: 'unavailable' }; }
  finally { await handle?.close(); }
}
