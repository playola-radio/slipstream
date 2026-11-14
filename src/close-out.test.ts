import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCas } from './cas.ts';
import { closeOutSession } from './close-out.ts';
import { createLog } from './log.ts';
import type { PublicEventInput as EventInput } from './public-events.ts';
import { withTempDir } from './test/helpers.ts';

const SESSION = '00000000-0000-4000-8000-000000000000';
const started: EventInput = { type: 'slipstream.session.started.v1', occurred_at_ms: 1, data: { root: '/work', max_bytes: 1024 } };
const stopped: EventInput = { type: 'slipstream.capture.stopped.v1', occurred_at_ms: 2, data: { reason: 'archived' } };

async function closeOut(inputs: EventInput[]): Promise<{ seq: bigint; types: string[] }> {
  let result!: { seq: bigint; types: string[] };
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'events.jsonl');
    const log = await createLog({ filePath: logPath, sessionId: SESSION });
    for (const input of inputs) await log.append(input);
    await log.close();
    const seq = await closeOutSession({ logPath, sessionId: SESSION, cas: await createCas(join(dir, 'blobs')),
      reason: 'detached', assertOwnership: () => {} });
    const types = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
    result = { seq, types };
  });
  return result;
}

describe('closeOutSession', () => {
  it('keeps a stop already in the log instead of writing a second one', async () => {
    assert.deepEqual(await closeOut([started, stopped]), { seq: 2n, types: [
      'slipstream.session.started.v1', 'slipstream.capture.stopped.v1',
    ] });
  });
});
