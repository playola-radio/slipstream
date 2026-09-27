import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startQaDaemon } from './qa/harness-proc.ts';
import { createReaderClient } from './qa-support.ts';
import { sessionLogPath } from '../src/store-reader.ts';
import { resolveRecordedRange } from '../src/interface-range-resolver.ts';

// Keep the Unix-domain control socket below macOS's short pathname limit.
const root = `/tmp/slip-fd3-${randomUUID().slice(0, 8)}`;
const qa = await startQaDaemon({ root });
try {
  const env = qa.env;
  const reader = createReaderClient(env.url, env.token);
  const path = 'fd3-range-live.ts';
  const initial = Buffer.from('export function sample(x: number): number { return x; }\n');
  const changed = Buffer.from('export function sample(x: string): string { return x; }\n');
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const awaitChange = async (hash: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const publicView = await reader.finite(env.session_id, 0n);
      const matching = publicView.events.find((record) => record.type === 'slipstream.file.changed.v1'
        && record.data?.path === path && (record.data.after as { sha256?: string })?.sha256 === hash);
      if (matching?.seq) return { seq: BigInt(matching.seq), publicView };
      if (Date.now() >= deadline) throw new Error(`timed out awaiting ${hash.slice(0, 8)}`);
      await delay(100);
    }
  };

  await writeFile(join(env.worktree, path), initial);
  const first = await awaitChange(sha(initial));
  await writeFile(join(env.worktree, path), changed);
  const second = await awaitChange(sha(changed));
  assert.ok(second.seq > first.seq);
  const result = await resolveRecordedRange({
    logPath: sessionLogPath(env.store, env.session_id), sessionId: env.session_id,
    durableSeq: second.publicView.durableSeq, beforeSeq: first.seq, afterSeq: second.seq,
    pathPrefix: path, scanBudget: { records: 100_000, bytes: 16 * 1024 * 1024 },
  });
  assert.equal(result.kind, 'resolved');
  if (result.kind !== 'resolved') throw new Error('resolution failed');
  assert.equal(result.files.length, 1);
  const file = result.files[0]!;
  const publicRecords = second.publicView.events.filter((record) => record.type === 'slipstream.file.changed.v1'
    && record.data?.path === path);
  const at = (seq: bigint) => publicRecords.filter((r) => BigInt(r.seq!) <= seq).at(-1)!;
  const beforeEvent = at(first.seq);
  const afterEvent = at(second.seq);
  assert.deepEqual(file.before, { kind: 'recorded', record_seq: beforeEvent.seq, field: 'after',
    snapshot: beforeEvent.data!.after, observation: beforeEvent.data!.observation });
  assert.deepEqual(file.after, { kind: 'recorded', record_seq: afterEvent.seq, field: 'after',
    snapshot: afterEvent.data!.after, observation: afterEvent.data!.observation });
  assert.equal((file.before.kind === 'recorded' && file.before.snapshot.kind === 'content') ? file.before.snapshot.sha256 : '', sha(initial));
  assert.equal(file.after.snapshot.kind === 'content' ? file.after.snapshot.sha256 : '', sha(changed));
  assert.deepEqual(await reader.blob(sha(initial)), initial);
  assert.deepEqual(await reader.blob(sha(changed)), changed);

  const baseline = BigInt(env.ready_through_seq);
  const firstRange = await resolveRecordedRange({
    logPath: sessionLogPath(env.store, env.session_id), sessionId: env.session_id,
    durableSeq: second.publicView.durableSeq, beforeSeq: baseline, afterSeq: first.seq,
    pathPrefix: path, scanBudget: { records: 100_000, bytes: 16 * 1024 * 1024 },
  });
  assert.equal(firstRange.kind, 'resolved');
  if (firstRange.kind !== 'resolved') throw new Error('first resolution failed');
  assert.deepEqual(firstRange.files[0]?.before, { kind: 'recorded', record_seq: first.seq.toString(),
    field: 'before', snapshot: { kind: 'absent' }, observation: 'watcher' });
  console.log(JSON.stringify({ status: 'passed', initial_seq: first.seq.toString(), changed_seq: second.seq.toString(),
    before_sha256: sha(initial), after_sha256: sha(changed), scan: result.scan,
    assertion: 'FD3 endpoints and blobs match independent public events' }));
} finally {
  await qa.stop();
}
