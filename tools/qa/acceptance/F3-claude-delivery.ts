/** Real CLI/socket acceptance for explicitly selected Claude Code delivery. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sendControlRequest } from '../../../src/control-client.ts';
import { awaitObservedChange, createReaderClient, mkdtempRoot, rmMkdtempRoot } from '../../qa-support.ts';
import { startQaDaemon } from '../harness-proc.ts';
import type { AcceptanceModule } from './types.ts';

async function cli(args: string[], input?: unknown): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
    child.once('error', reject);
    child.once('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function field(output: string, key: string): string {
  return output.split('\n').find(line => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? '';
}

export const f3ClaudeDelivery: AcceptanceModule = {
  id: 'F3-claude-delivery', needsDaemon: false,
  async run(ctx) {
    const root = await mkdtempRoot('slipstream-qa-f3-');
    let handle: Awaited<ReturnType<typeof startQaDaemon>> | null = null;
    try {
      handle = await startQaDaemon({ root });
      const { store, worktree, url, token } = handle.env;
      const reader = createReaderClient(url, token);
      await cli(['detach', '--store', store]);
      const harnessSessionId = randomUUID();
      const transcript = join(store, `claude-root-${randomUUID()}.jsonl`);
      const otherTranscript = join(store, `other-root-${randomUUID()}.jsonl`);
      const metadata = (id: string) => JSON.stringify({ type: 'attachment', sessionId: id, cwd: worktree,
        version: '2.1.280', entrypoint: 'sdk-ts', userType: 'external', isSidechain: false }) + '\n';
      await writeFile(transcript, JSON.stringify({ type: 'queue-operation', sessionId: harnessSessionId }) + '\n'
        + JSON.stringify({ type: 'queue-operation', sessionId: harnessSessionId }) + '\n'
        + metadata(harnessSessionId), { mode: 0o600 });
      await writeFile(otherTranscript, metadata(randomUUID()), { mode: 0o600 });
      try {
        const attached = await cli(['attach', worktree, '--store', store, '--harness', 'claude-code',
          '--harness-session-id', harnessSessionId, '--root-transcript', transcript]);
        if (attached.code !== 0) throw new Error(`Claude attach failed: ${attached.stderr}`);
        const sessionId = field(attached.stdout, 'session_id');
        if (!sessionId) throw new Error('Claude attach omitted capture session id');
        const path = `F3-${randomUUID()}.ts`;
        const bytes = Buffer.from(`const nonce = "${randomUUID()}";\n`);
        const sourcePath = join(worktree, path);
        try {
          const before = (await reader.finite(sessionId, 0n, ctx.signal)).durableSeq;
          await writeFile(sourcePath, bytes);
          const change = await awaitObservedChange(reader, sessionId, { relPath: path,
            before: { kind: 'absent' }, after: { kind: 'content', bytes } }, before, { signal: ctx.signal });
          if (change.after.kind !== 'content') throw new Error('source change has no content snapshot');
          const inputPath = join(store, `F3-${randomUUID()}.json`);
          const question = `Explain nonce ${randomUUID()} in this change.`;
          await writeFile(inputPath, JSON.stringify({ text: question, context: {
            change_seq: change.seq.toString(), path, snapshot_sha256: change.after.sha256,
            line_start: 1, line_end: 1,
          } }), { mode: 0o600 });
          try {
            const ask = await cli(['ask', '--store', store, '--session', sessionId,
              '--request-id', randomUUID(), '--input', inputPath]);
            if (ask.code !== 0) throw new Error(`Claude ask failed: ${ask.stderr}`);
            const queued = JSON.parse(ask.stdout) as { question_id: string };
            const callback = { hook_event_name: 'PostToolUse', session_id: harnessSessionId,
              cwd: worktree, transcript_path: transcript, tool_name: 'Bash' };
            const negatives = [
              { ...callback, agent_id: 'child', agent_type: 'general-purpose' },
              { ...callback, agent_id: null }, { ...callback, agent_type: null },
              { ...callback, agent_id: '' }, { ...callback, agent_type: '' },
              { ...callback, session_id: randomUUID() }, { ...callback, transcript_path: otherTranscript },
              { ...callback, cwd: store },
            ];
            for (const bad of negatives) {
              const result = await cli(['hook', 'claude-code', 'post-tool-use', '--store', store], bad);
              if (result.code !== 0 || result.stdout !== '' || result.stderr !== '') {
                throw new Error('negative Claude callback emitted context or logged data');
              }
            }
            const codex = await sendControlRequest({ socketPath: join(store, 'control.sock'), request: {
              v: 1, verb: 'claim_question', harness: 'codex', harness_session_id: harnessSessionId,
              worktree, transcript_path: transcript,
            } });
            if (codex.ok) throw new Error('Codex claimed a Claude binding');
            const beforeRoot = (await reader.finite(sessionId, 0n, ctx.signal)).events;
            if (beforeRoot.some(e => e.type === 'slipstream.question.dispatch_attempted.v1')) {
              throw new Error('a negative callback consumed the pending question');
            }
            const positive = await cli(['hook', 'claude-code', 'post-tool-use', '--store', store], callback);
            if (positive.code !== 0 || positive.stderr !== '') throw new Error('Claude hook failed or logged callback data');
            const output = JSON.parse(positive.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
            if (output.hookSpecificOutput.hookEventName !== 'PostToolUse'
              || !output.hookSpecificOutput.additionalContext.includes(question)
              || !output.hookSpecificOutput.additionalContext.includes(bytes.toString('utf8').trim())) {
              throw new Error('selected root callback did not receive the queued question and exact source');
            }
            const repeated = await cli(['hook', 'claude-code', 'post-tool-use', '--store', store], callback);
            if (repeated.code !== 0 || repeated.stderr !== '' || repeated.stdout !== '') {
              throw new Error('repeated Claude callback emitted context or logged data');
            }
            const pending = await cli(['ask', '--store', store, '--session', sessionId,
              '--request-id', randomUUID(), '--input', inputPath]);
            if (pending.code !== 0) throw new Error('could not queue a stale-hook control');
            const detached = await cli(['detach', '--store', store]);
            if (detached.code !== 0) throw new Error('could not detach Claude acceptance capture');
            const stale = await cli(['hook', 'claude-code', 'post-tool-use', '--store', store], callback);
            if (stale.code !== 0 || stale.stdout !== '') throw new Error('stale Claude hook emitted after detach');
            const events = (await reader.finite(sessionId, 0n, ctx.signal)).events;
            const attempts = events.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1');
            if (attempts.length !== 1 || attempts[0]!.data?.question_id !== queued.question_id) {
              throw new Error('public reader did not expose exactly one matching Claude attempt');
            }
            return { assertions: [{ id: 'F3-wire', claim: 'A selected Claude root claimed an observed source through the real CLI and daemon after one public durable attempt; child, other root, wrong worktree, Codex, repeat and stale callbacks received none',
              evidence: { capture_session_id: sessionId, question_id: queued.question_id,
                attempt_seq: attempts[0]!.seq, negative_callbacks: negatives.length + 2,
                canonical_worktree: await realpath(worktree) } }] };
          } finally { await rm(inputPath, { force: true }); }
        } finally { await rm(sourcePath, { force: true }); }
      } finally { await rm(transcript, { force: true }); await rm(otherTranscript, { force: true }); }
    } finally {
      try { await handle?.stop(); }
      finally { await rmMkdtempRoot(root); }
    }
  },
};
