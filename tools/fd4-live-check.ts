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
  const tsPath = 'fd4-live.ts';
  // Several distinct cold Swift files keep the default-budget page pending long
  // enough to observe a separate durable capture event through the public feed.
  // This is a functional overlap check, not a latency measurement.
  const swiftPaths = Array.from({ length: 8 }, (_, i) => `zFD4Live${i}.swift`);
  const tsBefore = 'export function sample(x: number): number { return x; }\n';
  const tsAfter = 'export function sample(x: string): string { return x; }\n';
  const swiftBefore = (i: number) => `func sample${i}(x: Int) -> Int { x }\n`;
  const swiftAfter = (i: number) => `func sample${i}(x: String) -> String { x }\n`;
  await writeFile(join(env.worktree, tsPath), tsBefore);
  const tsStart = await waitFor(tsPath, tsBefore);
  let beforeSeq = tsStart;
  for (const [i, path] of swiftPaths.entries()) {
    await writeFile(join(env.worktree, path), swiftBefore(i));
    beforeSeq = await waitFor(path, swiftBefore(i));
  }
  await writeFile(join(env.worktree, tsPath), tsAfter);
  const tsEnd = await waitFor(tsPath, tsAfter);
  let afterSeq = tsEnd;
  for (const [i, path] of swiftPaths.entries()) {
    await writeFile(join(env.worktree, path), swiftAfter(i));
    afterSeq = await waitFor(path, swiftAfter(i));
  }
  assert.ok(tsStart < beforeSeq && beforeSeq < tsEnd && tsEnd < afterSeq);

  const endpoint = `${env.url}/v1/sessions/${env.session_id}/interfaces?before_seq=${beforeSeq}&after_seq=${afterSeq}&limit=16`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { authorization: `Bearer ${env.token}` };
  const schema = await fetch(`${env.url}/v1/schemas/projections/interface.v2`, { headers });
  assert.equal(schema.status, 200);
  assert.equal((await schema.json() as { title: string }).title, 'interface.v2');
  let requestDone = false;
  const pending = fetch(endpoint, { headers }).then(response => { requestDone = true; return response; });
  await delay(25);
  assert.equal(requestDone, false, 'analysis ended before the capture probe began');
  const probePath = 'capture-during-analysis.ts';
  const probeSource = 'export const captureContinues = true;\n';
  await writeFile(join(env.worktree, probePath), probeSource);
  const probeSeq = await waitFor(probePath, probeSource);
  const captureDuringAnalysis = !requestDone && probeSeq > afterSeq;
  const response = await pending;
  assert.equal(response.status, 200);
  const page = await response.json() as { status: string; inventory: unknown; gaps: unknown;
    files: { path: string; status: string; fallback_reason?: string; changes: Array<{
      kind: string; parameters?: Array<{ before?: { type?: { text?: string } } | null;
        after?: { type?: { text?: string } } | null }> }> }[] };
  assert.ok(page.inventory);
  assert.ok(Array.isArray(page.gaps));
  const expectedTypes = (path: string): [string, string] => path === tsPath
    ? ['number', 'string'] : ['Int', 'String'];
  const comparisons = [tsPath, ...swiftPaths].map(path => {
    const file = page.files.find(item => item.path === path);
    const row = file?.changes[0];
    const parameter = row?.parameters?.[0];
    const [beforeType, afterType] = expectedTypes(path);
    return { path, status: file?.status ?? 'missing', kind: row?.kind ?? null,
      beforeType: parameter?.before?.type?.text ?? null,
      afterType: parameter?.after?.type?.text ?? null,
      correct: file?.status === 'ready' && row?.kind === 'signatureChanged'
        && parameter?.before?.type?.text === beforeType && parameter?.after?.type?.text === afterType };
  });
  const passed = page.status === 'ready' && comparisons.every(item => item.correct) && captureDuringAnalysis;
  console.log(JSON.stringify({ gate: passed ? 'passed' : 'failed', before_seq: beforeSeq.toString(),
    after_seq: afterSeq.toString(), page_status: page.status,
    comparisons, probe_seq: probeSeq.toString(), capture_during_analysis: captureDuringAnalysis,
    assertion: 'standalone authenticated HTTP consumer, default budget, disposable daemon, no UI' }));
  if (!passed) process.exitCode = 1;
} finally {
  await qa.stop();
}
