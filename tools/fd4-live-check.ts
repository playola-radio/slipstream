/** Independent authenticated consumer of a disposable daemon; no bundled UI. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startQaDaemon } from './qa/harness-proc.ts';
import { createReaderClient } from './qa-support.ts';

const qa = await startQaDaemon({ root: `/tmp/slip-fd4-${randomUUID().slice(0, 8)}` });
try {
  const { env } = qa;
  const reader = createReaderClient(env.url, env.token);
  const sha = (source: string) => createHash('sha256').update(source).digest('hex');
  const waitFor = async (path: string, source: string): Promise<bigint> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const view = await reader.finite(env.session_id, 0n);
      const match = view.events.find(event => event.type === 'slipstream.file.changed.v1'
        && event.data?.path === path && (event.data.after as { sha256?: string })?.sha256 === sha(source));
      if (match?.seq) return BigInt(match.seq);
      if (Date.now() > deadline) throw new Error(`capture timed out for ${path}`);
      await delay(100);
    }
  };
  const tsPath = 'fd4-live.ts', swiftPath = 'zFD4Live.swift';
  const tsBefore = 'export function sample(x: number): number { return x; }\n';
  const tsAfter = 'export function sample(x: string): string { return x; }\n';
  const swiftBefore = 'func sample(x: Int) -> Int { x }\n';
  const swiftAfter = 'func sample(x: String) -> String { x }\n';
  await writeFile(join(env.worktree, tsPath), tsBefore);
  const tsStart = await waitFor(tsPath, tsBefore);
  await writeFile(join(env.worktree, swiftPath), swiftBefore);
  const beforeSeq = await waitFor(swiftPath, swiftBefore);
  await writeFile(join(env.worktree, tsPath), tsAfter);
  const tsEnd = await waitFor(tsPath, tsAfter);
  await writeFile(join(env.worktree, swiftPath), swiftAfter);
  const afterSeq = await waitFor(swiftPath, swiftAfter);
  assert.ok(tsStart < beforeSeq && beforeSeq < tsEnd && tsEnd < afterSeq);

  const endpoint = `${env.url}/v1/sessions/${env.session_id}/interfaces?before_seq=${beforeSeq}&after_seq=${afterSeq}&limit=16`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { authorization: `Bearer ${env.token}` };
  const schema = await fetch(`${env.url}/v1/schemas/projections/interface.v2`, { headers });
  assert.equal(schema.status, 200);
  assert.equal((await schema.json() as { title: string }).title, 'interface.v2');
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  const page = await response.json() as { status: string; inventory: unknown; gaps: unknown;
    files: { path: string; status: string; fallback_reason?: string; changes: unknown[] }[] };
  assert.ok(page.inventory);
  assert.ok(Array.isArray(page.gaps));
  const ts = page.files.find(file => file.path === tsPath);
  const swift = page.files.find(file => file.path === swiftPath);
  const ready = ts?.status === 'ready' && swift?.status === 'ready';
  console.log(JSON.stringify({ gate: ready ? 'passed' : 'failed', before_seq: beforeSeq.toString(),
    after_seq: afterSeq.toString(), page_status: page.status,
    files: page.files.map(file => ({ path: file.path, status: file.status,
      reason: file.fallback_reason ?? null, changes: file.changes.length })),
    assertion: 'standalone authenticated HTTP consumer, disposable daemon, no UI' }));
  if (!ready) process.exitCode = 1;
} finally {
  await qa.stop();
}
