import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

const SUPPORTED_CODEX_VERSIONS = new Set(['0.154.0', '0.155.1']);
const MAX_CODEX_META_BYTES = 64 * 1024;

/** Verify the selected transcript's own first record. It binds the reported
 * session and worktree without treating either as authorship. Any missing,
 * mismatched, or unobserved runtime metadata is `false`. */
export async function verifyCodexRootTranscript(path: string, sessionId: string, worktree: string): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) return false;
      const buffer = Buffer.alloc(MAX_CODEX_META_BYTES + 1);
      let total = 0; let end = -1;
      while (total < buffer.length && end < 0) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        end = buffer.subarray(total, total + bytesRead).indexOf(0x0a);
        if (end >= 0) end += total;
        total += bytesRead;
      }
      if (end < 0 || end > MAX_CODEX_META_BYTES) return false;
      bytes = buffer.subarray(0, end);
    } finally { await handle.close(); }
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    return record.type === 'session_meta' && !!payload
      && payload.originator === 'codex_sdk_ts'
      && (payload.source === 'exec' || payload.source === 'vscode')
      && SUPPORTED_CODEX_VERSIONS.has(String(payload.cli_version))
      && payload.session_id === sessionId && typeof payload.cwd === 'string'
      && await realpath(payload.cwd) === worktree;
  } catch { return false; }
}
