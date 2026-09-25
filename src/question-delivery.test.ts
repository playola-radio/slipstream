import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startCapture } from './session.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { withTempDir, waitForRecords, readRecords } from './test/helpers.ts';
import { QUESTION_TTL_MS } from './questions.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';

it('claims oldest queued question once and commits attempt before returning content', async () => {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const platform = createFakePlatform(); let now = 1000;
    const session = await startCapture({ root, storeDir: join(base, 'store'), now: () => now }, { platform });
    const target = { harness: 'codex' as const, harness_session_id: 'root-session', worktree: await realpath(root) };
    try {
      await writeFile(join(root, 'a.ts'), 'one\ntwo\n'); platform.observe('a.ts');
      const change = (await waitForRecords(session.logPath, records => records.some(e => e.type === 'slipstream.file.changed.v1')))
        .find(e => e.type === 'slipstream.file.changed.v1')!;
      assert.equal(change.data.after.kind, 'content');
      const request = { session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
        change_seq: change.seq, path: 'a.ts', snapshot_sha256: change.data.after.sha256, line_start: 1, line_end: 2,
      } };
      const first = await session.askQuestion(request, target);
      const second = await session.askQuestion({ ...request, request_id: randomUUID(), text: 'How?' }, target);
      const claims = await Promise.all(Array.from({ length: 8 }, () => session.claimQuestion(target)));
      assert.equal(claims.filter(Boolean).length, 2);
      assert.equal(claims.find(Boolean)?.question_id, first.question_id);
      assert.equal((await session.claimQuestion(target)), null);
      const events = await readRecords(session.logPath);
      const attempts = events.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1');
      assert.deepEqual(attempts.map(e => e.data.question_id), [first.question_id, second.question_id]);
      assert.equal(attempts[0]!.data.queued_seq, first.seq);
      assert.equal(attempts[0]!.data.attempted_at_ms, now);
      assert.equal(claims.find(Boolean)?.context.selected_text, 'one\ntwo');
      now = 1000 + QUESTION_TTL_MS;
      assert.equal(await session.claimQuestion(target), null);
    } finally { await session.stop(); }
  });
});

it('rebuilds committed attempts after an ambiguous append and never offers them twice', async () => {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const platform = createFakePlatform(); let fail = true;
    const session = await startCapture({ root, storeDir: join(base, 'store'), now: () => 1000 }, {
      platform, readQuestionContext: async () => 'selected',
      createLog: async opts => {
        const log = await createLog(opts);
        return { ...log, append: async input => {
          const event = await log.append(input);
          if (input.type === 'slipstream.question.dispatch_attempted.v1' && fail) {
            fail = false; throw new StorageError('append', new Error('reply lost after fsync'));
          }
          return event;
        } };
      },
    });
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    try {
      await session.askQuestion({ session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
        change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
      } }, target);
      await assert.rejects(session.claimQuestion(target), StorageError);
      const deadline = Date.now() + 5000;
      while (session.health.snapshot().state !== 'healthy') {
        assert.ok(Date.now() < deadline, 'recovery must finish');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(await session.claimQuestion(target), null);
      const attempts = (await readRecords(session.logPath)).filter(e => e.type === 'slipstream.question.dispatch_attempted.v1');
      assert.equal(attempts.length, 1);
    } finally { await session.stop(); }
  });
});

it('releases a claim after a precommit storage failure so recovery may offer it', async () => {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    let fail = true;
    const session = await startCapture({ root, storeDir: join(base, 'store'), now: () => 1000 }, {
      platform: createFakePlatform(), readQuestionContext: async () => 'selected',
      createLog: async opts => {
        const log = await createLog(opts);
        return { ...log, append: async input => {
          if (input.type === 'slipstream.question.dispatch_attempted.v1' && fail) {
            fail = false; throw new StorageError('append', new Error('before write'));
          }
          return log.append(input);
        } };
      },
    });
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    try {
      await session.askQuestion({ session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
        change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
      } }, target);
      await assert.rejects(session.claimQuestion(target), StorageError);
      const deadline = Date.now() + 5000;
      while (session.health.snapshot().state !== 'healthy') {
        assert.ok(Date.now() < deadline);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(await session.claimQuestion(target));
      assert.equal((await readRecords(session.logPath)).filter(e => e.type === 'slipstream.question.dispatch_attempted.v1').length, 1);
    } finally { await session.stop(); }
  });
});

it('frees queue capacity after a claim', async () => {
  await withTempDir(async base => {
    const root = join(base, 'work'); await mkdir(root);
    const now = 1000;
    const session = await startCapture({ root, storeDir: join(base, 'store'), now: () => now }, {
      platform: createFakePlatform(), readQuestionContext: async () => 'selected',
    });
    const target = { harness: 'codex' as const, harness_session_id: 'root', worktree: await realpath(root) };
    const input = { session_id: session.sessionId, request_id: randomUUID(), text: 'Why?', context: {
      change_seq: '1', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1,
    } };
    try {
      for (let i = 0; i < 16; i++) await session.askQuestion({ ...input, request_id: randomUUID() }, target);
      await assert.rejects(session.askQuestion(input, target), { code: 'QUESTION_LIMIT' });
      assert.ok(await session.claimQuestion(target));
      await session.askQuestion(input, target);
      assert.equal((await readRecords(session.logPath)).filter(e => e.type === 'slipstream.question.dispatch_attempted.v1').length, 1);
    } finally { await session.stop(); }
  });
});
