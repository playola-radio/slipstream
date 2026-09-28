/** FD2 live probe: real watcher capture, CAS blobs, isolated parser and daemon liveness. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon, probeSocket } from './daemon.ts';
import { sendControlRequest } from './control-client.ts';
import { extractSwiftSides, SwiftExtractCancelled } from './swift-interface.ts';
import { awaitEventType, awaitObservedChange, bootstrapReader, createReaderClient,
  BASELINE_COMPLETED_TYPE, sha256Hex } from '../tools/qa-support.ts';

test('real capture feeds the isolated Swift checker through normal, refusal and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fd2-live-'));
  const store = join(root, 'store'), worktree = join(root, 'worktree');
  await mkdir(store, { mode: 0o700 });
  await mkdir(worktree, { mode: 0o700 });
  const daemon = await startDaemon({ storeDir: store });
  try {
    const attach = await sendControlRequest({ socketPath: daemon.socketPath,
      request: { v: 1, verb: 'attach', worktree, harness: 'qa', harness_session_id: `qa:${randomUUID()}` } });
    assert.equal(attach.ok, true);
    if (!attach.ok) return;
    const sessionId = attach.session_id as string;
    const descriptor = await bootstrapReader(store);
    const reader = createReaderClient(descriptor.url, descriptor.token);
    const baseline = await awaitEventType(reader, sessionId, BASELINE_COMPLETED_TYPE, 0n);
    const path = join(worktree, 'F.swift');
    const before = Buffer.from('func f(_ x: Int) {}\n');
    await writeFile(path, before);
    const first = await awaitObservedChange(reader, sessionId,
      { relPath: 'F.swift', before: { kind: 'absent' }, after: { kind: 'content', bytes: before } }, baseline.seq);
    const after = Buffer.from('func f(_ x: String) {}\n');
    await writeFile(path, after);
    const second = await awaitObservedChange(reader, sessionId,
      { relPath: 'F.swift', before: { kind: 'content', bytes: before }, after: { kind: 'content', bytes: after } }, first.seq);
    const checker = fileURLToPath(new URL('../tools/swift-extract-check.ts', import.meta.url));
    const invoke = async (beforeSha: string, afterSha: string): Promise<{ code: number; result: { status: string; changes: unknown[] } }> => {
      const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [checker, '--store', store, '--before', beforeSha, '--after', afterSha],
          (error, stdout, stderr) => {
            const exitCode: unknown = error?.code ?? 0;
            resolve({ code: typeof exitCode === 'number' ? exitCode : 2, stdout, stderr });
          });
      });
      assert.equal(output.stderr, '');
      return { code: output.code, result: JSON.parse(output.stdout) };
    };
    const normal = await invoke(sha256Hex(before), sha256Hex(after));
    assert.equal(normal.code, 0);
    assert.equal(normal.result.status, 'ready');
    assert.equal(normal.result.changes.length, 1);
    assert.equal(await probeSocket(daemon.socketPath, 1000), 'live');
    const preview = Buffer.from('#Preview { Text("a") }\nfunc f(_ x: String) {}\n');
    await writeFile(path, preview);
    await awaitObservedChange(reader, sessionId,
      { relPath: 'F.swift', before: { kind: 'content', bytes: after }, after: { kind: 'content', bytes: preview } }, second.seq);
    const refused = await invoke(sha256Hex(after), sha256Hex(preview));
    assert.equal(refused.code, 1);
    assert.equal(refused.result.status, 'incomplete');
    assert.deepEqual(refused.result.changes, []);
    assert.equal(await probeSocket(daemon.socketPath, 1000), 'live');
    const abort = new AbortController();
    const pending = extractSwiftSides([{ id: 'slow', bytes: Buffer.from('func f() {\n' + '  if x {\n'.repeat(200_000)) }],
      { signal: abort.signal, deadlineMs: 60_000 });
    setTimeout(() => abort.abort(), 150);
    await assert.rejects(pending, SwiftExtractCancelled);
    assert.equal(await probeSocket(daemon.socketPath, 1000), 'live');
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});
