/** Live Codex hook wire acceptance against a disposable real daemon and watcher. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sendControlRequest } from '../../../src/control-client.ts';
import { awaitObservedChange, createReaderClient, mkdtempRoot, rmMkdtempRoot } from '../../qa-support.ts';
import { startQaDaemon } from '../harness-proc.ts';
import { completeSetupCheck } from './setup-check.ts';
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

export const f2Delivery: AcceptanceModule = {
  id: 'F2-delivery', needsDaemon: false,
  async run(ctx) {
    const root = await mkdtempRoot('slipstream-qa-f2-');
    let handle: Awaited<ReturnType<typeof startQaDaemon>> | null = null;
    try {
      handle = await startQaDaemon({ root });
      const { store, worktree, url, token } = handle.env;
      const reader = createReaderClient(url, token);
      await cli(['detach', '--store', store]);
      const harnessSessionId = randomUUID();
      const transcript = join(store, `root-${randomUUID()}.jsonl`);
      const worktreeAlias = join(store, `alias-${randomUUID()}`);
      await symlink(worktree, worktreeAlias);
      await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: {
        session_id: harnessSessionId, cwd: worktree, originator: 'codex_sdk_ts',
        source: 'exec', cli_version: '0.154.0',
      } }) + '\n', { mode: 0o600 });
      const attached = await cli(['attach', worktree, '--store', store, '--harness', 'codex',
        '--harness-session-id', harnessSessionId, '--root-transcript', transcript]);
      if (attached.code !== 0) throw new Error(`Codex attach failed: ${attached.stderr}`);
      const sessionId = field(attached.stdout, 'session_id');
      if (!sessionId) throw new Error('Codex attach omitted capture session id');
      await completeSetupCheck({ store, harness: 'codex', callback: { hook_event_name: 'PostToolUse',
        session_id: harnessSessionId, cwd: worktree, transcript_path: transcript, tool_name: 'Bash' } });
      const path = `F2-${randomUUID()}.ts`;
      const bytes = Buffer.from('const nonce = "' + randomUUID() + '";\n');
      const sourcePath = join(worktree, path);
      try {
        const before = (await reader.finite(sessionId, 0n, ctx.signal)).durableSeq;
        await writeFile(sourcePath, bytes);
        const change = await awaitObservedChange(reader, sessionId, { relPath: path,
          before: { kind: 'absent' }, after: { kind: 'content', bytes } }, before, { signal: ctx.signal });
        if (change.after.kind !== 'content') throw new Error('source change has no content snapshot');
        const requestId = randomUUID();
        const inputPath = join(store, `F2-${randomUUID()}.json`);
        const question = `Explain nonce ${randomUUID()} in this change.`;
        await writeFile(inputPath, JSON.stringify({ text: question, context: {
          change_seq: change.seq.toString(), path, snapshot_sha256: change.after.sha256,
          line_start: 1, line_end: 1,
        } }), { mode: 0o600 });
        try {
          const ask = await cli(['ask', '--store', store, '--session', sessionId,
            '--request-id', requestId, '--input', inputPath]);
          if (ask.code !== 0) throw new Error(`ask failed: ${ask.stderr}`);
          const queued = JSON.parse(ask.stdout) as { question_id: string };
          const callback = { hook_event_name: 'PostToolUse', session_id: harnessSessionId,
            cwd: worktreeAlias, transcript_path: transcript, tool_name: 'Bash' };
          const negativeCallbacks = [{ ...callback, agent_id: null },
            { ...callback, agent_id: 'child', agent_type: 'explore', transcript_path: inputPath },
            { ...callback, session_id: randomUUID() }, { ...callback, transcript_path: inputPath },
            { ...callback, cwd: store }];
          for (const negative of negativeCallbacks) {
            const result = await cli(['hook', 'codex', 'post-tool-use', '--store', store], negative);
            if (result.code !== 0 || result.stdout !== '') throw new Error('negative Codex callback emitted context');
          }
          const claude = await sendControlRequest({ socketPath: join(store, 'control.sock'), request: {
            v: 1, verb: 'claim_question', harness: 'claude-code', harness_session_id: harnessSessionId,
            worktree, transcript_path: transcript,
          } });
          if (claude.ok) throw new Error('Claude claimed a Codex binding');
          const positive = await cli(['hook', 'codex', 'post-tool-use', '--store', store], callback);
          if (positive.code !== 0 || positive.stderr !== '') throw new Error('Codex hook failed or logged callback data');
          const output = JSON.parse(positive.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
          if (output.hookSpecificOutput.hookEventName !== 'PostToolUse'
            || !output.hookSpecificOutput.additionalContext.includes(question)
            || !output.hookSpecificOutput.additionalContext.includes(bytes.toString('utf8').trim())) {
            throw new Error('root callback did not receive the exact queued question and source');
          }
          const repeated = await cli(['hook', 'codex', 'post-tool-use', '--store', store], callback);
          if (repeated.stdout !== '') throw new Error('question was emitted twice');
          const pendingAtDetach = await cli(['ask', '--store', store, '--session', sessionId,
            '--request-id', randomUUID(), '--input', inputPath]);
          if (pendingAtDetach.code !== 0) throw new Error('could not queue stale-hook control');
          const detached = await cli(['detach', '--store', store]);
          if (detached.code !== 0) throw new Error('could not detach stale-hook control');
          const stale = await cli(['hook', 'codex', 'post-tool-use', '--store', store], callback);
          if (stale.code !== 0 || stale.stdout !== '') throw new Error('stale hook emitted after detach');
          const events = (await reader.finite(sessionId, 0n, ctx.signal)).events;
          const attempts = events.filter(e => e.type === 'slipstream.question.dispatch_attempted.v1');
          if (attempts.length !== 1 || attempts[0]!.data?.question_id !== queued.question_id) {
            throw new Error('public reader did not expose exactly one matching durable attempt');
          }
          return { assertions: [{ id: 'F2-wire',
            claim: 'A simulated root Codex callback through the real CLI and daemon claimed a real observed change after a public durable attempt; simulated child, other chat, other transcript, wrong worktree, Claude and stale hooks received none',
            evidence: { capture_session_id: sessionId, question_id: queued.question_id,
              attempt_seq: attempts[0]!.seq, negative_callbacks: negativeCallbacks.length + 2, repeated_emissions: 0,
              canonical_worktree: await realpath(worktree) },
          }] };
        } finally { await rm(inputPath, { force: true }); }
      } finally { await rm(sourcePath, { force: true }); await rm(transcript, { force: true }); await rm(worktreeAlias, { force: true }); }
    } finally {
      try { await handle?.stop(); }
      finally { await rmMkdtempRoot(root); }
    }
  },
};
