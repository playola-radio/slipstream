import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { withTempDir, waitForRecords, readRecords } from './test/helpers.ts';
import { QUESTION_TTL_MS, readQuestionContext } from './questions.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';

async function fixture(run: (s: Awaited<ReturnType<typeof startCapture>>, input: import('./questions.ts').QuestionRequest, setTime: (n: number) => void) => Promise<void>, deps: Parameters<typeof startCapture>[1] = {}) {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const platform = createFakePlatform(); let now = 1000;
    const s = await startCapture({ root, storeDir: join(base, 'store'), now: () => now }, { platform, ...deps });
    try {
      await writeFile(join(root, 'a.ts'), 'one\r\n\ttwo\n'); platform.observe('a.ts');
      const ev = (await waitForRecords(s.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1'))).find(e => e.type === 'slipstream.file.changed.v1')!;
      if (BigInt(s.health.snapshot().durable_seq) < BigInt(ev.seq)) {
        await new Promise<void>(resolve => { const off = s.health.subscribe(() => {
          if (BigInt(s.health.snapshot().durable_seq) >= BigInt(ev.seq)) { off(); resolve(); }
        }); });
      }
      assert.equal(ev.type, 'slipstream.file.changed.v1'); assert.equal(ev.data.after.kind, 'content');
      await run(s, { session_id: s.sessionId, request_id: randomUUID(), text: ' Why? ', context: { change_seq: ev.seq, path: 'a.ts', snapshot_sha256: ev.data.after.sha256, line_start: 1, line_end: 2 } }, n => { now = n; });
    } finally { await s.stop(); }
  });
}
const target = { harness: 'codex' as const, harness_session_id: 'main', worktree: '/tmp/example' };
it('coalesces duplicate calls, conflicts on body reuse, and never refreshes expiry', async () => {
  await fixture(async (s, input, setTime) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => s.askQuestion(input, target)));
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.ok(results.every(r => r.seq === results[0]!.seq));
    assert.equal(results[0]!.queued_at_ms, 1000);
    setTime(1000 + QUESTION_TTL_MS);
    const again = await s.askQuestion(input, target);
    assert.deepEqual(again, { ...results[0], duplicate: true });
    await assert.rejects(s.askQuestion({ ...input, text: 'different' }, target), { code: 'REQUEST_CONFLICT' });
    const events = await readRecords(s.logPath);
    assert.equal(events.filter(e => e.type === 'slipstream.question.queued.v1').length, 1);
    assert.equal(events.filter(e => e.type === 'slipstream.file.changed.v1').length, 1);
    assert.equal(events.filter(e => e.type === 'slipstream.question.queued.v1')[0]!.data.context.selected_text, 'one\r\n\ttwo');
  });
});
it('bounds 17 concurrent distinct submissions to 16 and expiry frees capacity', async () => {
  await fixture(async (s, input, setTime) => {
    const results = await Promise.allSettled(Array.from({ length: 17 }, () => s.askQuestion({ ...input, request_id: randomUUID() }, target)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 16);
    const fail = results.find(r => r.status === 'rejected');
    assert.ok(fail && fail.status === 'rejected'); assert.equal(fail.reason.code, 'QUESTION_LIMIT');
    setTime(1000 + QUESTION_TTL_MS);
    assert.equal((await s.askQuestion({ ...input, request_id: randomUUID() }, target)).duplicate, false);
  });
});
it('releases failed source reservations and rejects unhealthy or stopped capture', async () => {
  await fixture(async (s, input) => {
    for (let i = 0; i < 18; i++) await assert.rejects(s.askQuestion({ ...input, context: { ...input.context, path: 'wrong' } }, target), { code: 'INVALID_CONTEXT' });
    assert.equal((await s.askQuestion(input, target)).duplicate, false);
    s.health.markFailing({ operation: 'test', code: 'EIO', detected_at_ms: 0 });
    await assert.rejects(s.askQuestion(input, target), { code: 'STORAGE_UNAVAILABLE' });
    await s.stop();
    await assert.rejects(s.askQuestion(input, target), { code: 'CAPTURE_NOT_READY' });
  });
});
it('rebuilds question dedup from a commit followed by ambiguous append failure', async () => {
  let fail = true;
  await fixture(async (s, input) => {
    await assert.rejects(s.askQuestion(input, target), StorageError);
    const deadline = Date.now() + 5000;
    while (s.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline, 'recovery completed');
      await new Promise(r => setTimeout(r, 10));
    }
    const duplicate = await s.askQuestion(input, target);
    assert.equal(duplicate.duplicate, true);
    const events = (await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.queued.v1');
    assert.equal(events.length, 1); assert.equal(duplicate.seq, events[0]!.seq);
    assert.equal(duplicate.queued_at_ms, 1000);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      const event = await log.append(input);
      if (input.type === 'slipstream.question.queued.v1' && fail) { fail = false; throw new StorageError('append', new Error('ambiguous after fsync')); }
      return event;
    } };
  } });
});
it('drains admitted source reads on stop and does not append after readiness loss', async () => {
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  await fixture(async (s, input) => {
    const pending = s.askQuestion(input, target); await started;
    s.health.markFailing({ operation: 'test', code: 'EIO', detected_at_ms: 0 });
    release(); await assert.rejects(pending, { code: 'STORAGE_UNAVAILABLE' });
    assert.equal((await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.queued.v1').length, 0);
  }, { readQuestionContext: async input => { entered(); await gate; return readQuestionContext(input); } });
});

it('never appends when ownership changes during source validation', async () => {
  let owned = true;
  await fixture(async (s, input) => {
    await assert.rejects(s.askQuestion(input, target, () => {
      if (!owned) throw new StorageError('lock', new Error('lost'));
    }), StorageError);
    assert.equal((await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.queued.v1').length, 0);
  }, { readQuestionContext: async input => { const selected = await readQuestionContext(input); owned = false; return selected; } });
});

it('does not recover a torn uncommitted question as a duplicate', async () => {
  let fail = true;
  const { appendFile } = await import('node:fs/promises');
  await fixture(async (s, input) => {
    await assert.rejects(s.askQuestion(input, target), StorageError);
    const deadline = Date.now() + 5000;
    while (s.health.snapshot().state !== 'healthy') {
      assert.ok(Date.now() < deadline);
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await s.askQuestion(input, target)).duplicate, false);
    assert.equal((await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.queued.v1').length, 1);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      if (input.type === 'slipstream.question.queued.v1' && fail) {
        fail = false; await appendFile(opts.filePath, '{"type":"slipstream.question.queued.v1","data":');
        throw new StorageError('append', new Error('torn write'));
      }
      return log.append(input);
    } };
  } });
});

it('does not acknowledge a question when ownership is lost during append', async () => {
  let owned = true;
  await fixture(async (s, input) => {
    await assert.rejects(s.askQuestion(input, target, () => {
      if (!owned) throw new StorageError('lock', new Error('lost after commit'));
    }), StorageError);
    assert.equal((await readRecords(s.logPath)).filter(e => e.type === 'slipstream.question.queued.v1').length, 1);
  }, { createLog: async opts => {
    const log = await createLog(opts);
    return { ...log, append: async input => {
      const result = await log.append(input);
      if (input.type === 'slipstream.question.queued.v1') owned = false;
      return result;
    } };
  } });
});
