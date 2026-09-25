import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexPostToolUse } from './question-hook.ts';

const callback = { hook_event_name: 'PostToolUse', session_id: 'root', cwd: '/tmp/work',
  transcript_path: '/tmp/root.jsonl', tool_name: 'Bash' };
const question = { session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', question_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  queued_seq: '8', request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'Why?',
  context: { change_seq: '3', path: 'a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 2, selected_text: 'one\ntwo' } };

it('sends only a proven root callback and returns hook-specific additionalContext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-hook-'));
  const requests: unknown[] = [];
  const server = createServer(socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk;
      if (raw.includes('\n')) {
        requests.push(JSON.parse(raw));
        socket.end(JSON.stringify({ v: 1, ok: true, question }) + '\n');
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
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
