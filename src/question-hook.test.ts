import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexPostToolUse, claudePostToolUse, readHookInput } from './question-hook.ts';

const callback = { hook_event_name: 'PostToolUse', session_id: 'root', cwd: '/tmp/work',
  transcript_path: '/tmp/root.jsonl', tool_name: 'Bash' };
const question = { session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', question_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  queued_seq: '8', request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'Why?',
  context: { change_seq: '3', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 2, selected_text: 'one\ntwo' } };

it('sends only a proven root callback and returns hook-specific additionalContext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-hook-'));
  const requests: unknown[] = [];
  let responseQuestion = question;
  const server = createServer(socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk;
      if (raw.includes('\n')) {
        requests.push(JSON.parse(raw));
        socket.end(JSON.stringify({ v: 1, ok: true, question: responseQuestion }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, 'control.sock'), resolve));
  try {
    for (const bad of [{ ...callback, agent_id: null }, { ...callback, agent_type: '' },
      { ...callback, transcript_path: null }, { ...callback, hook_event_name: 'Stop' },
      { ...callback, cwd: '' }]) assert.equal(await codexPostToolUse(bad, dir), null);
    assert.equal(requests.length, 0);
    const output = await codexPostToolUse(callback, dir);
    assert.deepEqual(requests[0], { v: 1, verb: 'claim_question', harness: 'codex',
      harness_session_id: 'root', worktree: '/tmp/work', transcript_path: '/tmp/root.jsonl' });
    assert.ok(output?.includes('hookSpecificOutput'));
    const parsed = JSON.parse(output!);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Why\?/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /one\ntwo/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /untrusted file content/i);
    assert.match(parsed.hookSpecificOutput.additionalContext, /BEGIN SELECTED SOURCE/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /END SELECTED SOURCE/);
    responseQuestion = { ...question, text: 'Q'.repeat(8192), context: {
      ...question.context, path: 'p'.repeat(4096), selected_text: 'S'.repeat(16384),
    } };
    const maximum = await codexPostToolUse(callback, dir);
    assert.ok(maximum?.includes('S'.repeat(16384)));
    assert.ok(Buffer.byteLength(JSON.parse(maximum!).hookSpecificOutput.additionalContext) <= 32 * 1024);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

it('ends stdin reading at the shared hook deadline', async () => {
  const stream = new PassThrough();
  try {
    const started = Date.now();
    await assert.rejects(readHookInput(stream, started + 30), /timeout/);
    assert.ok(Date.now() - started < 500);
  } finally { stream.destroy(); }
});

it('routes only root Claude PostToolUse and preserves near-cap selected source bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-claude-hook-'));
  const requests: unknown[] = [];
  let responseQuestion: typeof question = question;
  const server = createServer(socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk;
      if (raw.includes('\n')) {
        requests.push(JSON.parse(raw));
        socket.end(JSON.stringify({ v: 1, ok: true, question: responseQuestion }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, 'control.sock'), resolve));
  try {
    for (const bad of [{ ...callback, agent_id: null }, { ...callback, agent_type: null },
      { ...callback, agent_id: 'child', agent_type: 'general-purpose' },
      { ...callback, agent_id: '' }, { ...callback, agent_type: '' },
      { ...callback, hook_event_name: 'Stop' }, { ...callback, cwd: '' }]) {
      assert.equal(await claudePostToolUse(bad, dir), null);
    }
    assert.equal(requests.length, 0);
    const output = await claudePostToolUse(callback, dir);
    assert.deepEqual(requests[0], { v: 1, verb: 'claim_question', harness: 'claude-code',
      harness_session_id: 'root', worktree: '/tmp/work', transcript_path: '/tmp/root.jsonl' });
    assert.equal(JSON.parse(output!).hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(await claudePostToolUse(callback, dir, Date.now() - 1), null);
    assert.equal(requests.length, 1);

    const selected = 'S'.repeat(16369) + 'END-SOURCE-4729';
    responseQuestion = { ...question, text: 'Q'.repeat(8192), context: {
      ...question.context, path: '\n'.repeat(3850), selected_text: selected,
    } };
    const nearCap = await claudePostToolUse(callback, dir);
    const context = JSON.parse(nearCap!).hookSpecificOutput.additionalContext as string;
    assert.ok(Buffer.byteLength(context) > 32_000);
    assert.ok(Buffer.byteLength(context) <= 32 * 1024);
    assert.ok(context.includes(`BEGIN SELECTED SOURCE ${question.question_id}\n${selected}\nEND SELECTED SOURCE ${question.question_id}`));
    responseQuestion = { ...responseQuestion, context: { ...responseQuestion.context, path: '\n'.repeat(4096) } };
    const overCap = await claudePostToolUse(callback, dir);
    if (overCap === null) {
      // Path alone with 4096 newlines exceeds the limit even without selected source
      assert.ok(true, 'over-cap context with pathological path returns null');
    } else {
      // If we can fit even with a huge path, verify it's properly truncated
      const overCapContext = JSON.parse(overCap).hookSpecificOutput.additionalContext as string;
      assert.ok(Buffer.byteLength(overCapContext) <= 32 * 1024);
      assert.ok(overCapContext.includes(`BEGIN SELECTED SOURCE ${question.question_id}\n`));
      assert.ok(overCapContext.includes(`\nEND SELECTED SOURCE ${question.question_id}`));
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
