/** Real forwarder/CLI/socket acceptance for answer return, including restart replay. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sendControlRequest } from '../../../src/control-client.ts';
import { awaitObservedChange, createReaderClient, mkdtempRoot, rmMkdtempRoot, type ReaderClient } from '../../qa-support.ts';
import { startQaDaemon } from '../harness-proc.ts';
import type { AcceptanceModule } from './types.ts';

async function run(args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
    child.once('error', reject);
    child.once('close', code => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}
const cli = (args: string[], input?: unknown) => run(['src/cli.ts', ...args], input === undefined ? undefined : JSON.stringify(input));

function field(output: string, key: string): string {
  return output.split('\n').find(line => line.startsWith(`${key}: `))?.slice(key.length + 2) ?? '';
}

interface ToolOutcome { isError: boolean; structured: Record<string, unknown> }

/** One real MCP forwarder process speaking to the daemon as a Claude Code session. */
async function answerViaForwarder(store: string, env: Record<string, string>, question_id: string, text: string): Promise<ToolOutcome> {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'qa' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slipstream_answer_question', arguments: { question_id, text } } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n';
  const out = await run(['src/mcp-forwarder.ts', '--store', store], lines, { PATH: process.env.PATH ?? '', ...env });
  const reply = out.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l) as { id?: number; result?: { isError?: boolean; structuredContent?: Record<string, unknown> } })
    .find(m => m.id === 2);
  if (!reply?.result?.structuredContent) throw new Error(`forwarder gave no tool result (exit ${out.code})`);
  return { isError: reply.result.isError === true, structured: reply.result.structuredContent };
}

async function sseAnswers(reader: ReaderClient, sessionId: string, through: bigint, outer: AbortSignal): Promise<number> {
  const ctl = new AbortController();
  const onOuter = (): void => ctl.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => ctl.abort(), 8_000);
  let answered = 0;
  try {
    await reader.follow(sessionId, 0n, ctl.signal, frame => {
      const record = JSON.parse(frame.data) as { type: string; seq: string };
      if (record.type === 'slipstream.question.answered.v1') answered += 1;
      if (BigInt(record.seq) >= through) ctl.abort();
    });
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
  return answered;
}

export const f4Answer: AcceptanceModule = {
  id: 'F4-answer', needsDaemon: false,
  async run(ctx) {
    const root = await mkdtempRoot('slipstream-qa-f4-');
    let handle: Awaited<ReturnType<typeof startQaDaemon>> | null = null;
    try {
      handle = await startQaDaemon({ root, keep: true });
      const { store, worktree } = handle.env;
      let reader = createReaderClient(handle.env.url, handle.env.token);
      await cli(['detach', '--store', store]);
      const harnessSessionId = randomUUID();
      const transcript = join(store, `claude-root-${randomUUID()}.jsonl`);
      await writeFile(transcript, JSON.stringify({ type: 'attachment', sessionId: harnessSessionId, cwd: worktree,
        version: '2.1.280', entrypoint: 'sdk-ts', userType: 'external', isSidechain: false }) + '\n', { mode: 0o600 });
      const rows: Record<string, unknown> = {};
      const expectCode = (id: string, got: ToolOutcome | { ok: boolean; code?: unknown }, code: string) => {
        const actual = 'structured' in got ? (got.isError ? got.structured.code : undefined) : (got.ok ? undefined : got.code);
        if (actual !== code) throw new Error(`${id}: expected ${code}, got ${String(actual)}`);
        rows[id] = code;
      };
      const expectAck = (id: string, got: ToolOutcome, question_id: string, duplicate: boolean) => {
        const s = got.structured;
        if (got.isError || s.question_id !== question_id || s.duplicate !== duplicate || s.event_id !== s.seq) {
          throw new Error(`${id}: expected a recorded answer ack, got ${JSON.stringify(s.code ?? s.duplicate)}`);
        }
        rows[id] = { seq: s.seq, duplicate };
        return s;
      };
      try {
        const attached = await cli(['attach', worktree, '--store', store, '--harness', 'claude-code',
          '--harness-session-id', harnessSessionId, '--root-transcript', transcript]);
        if (attached.code !== 0) throw new Error(`Claude attach failed: ${attached.stderr}`);
        const sessionId = field(attached.stdout, 'session_id');
        if (!sessionId) throw new Error('Claude attach omitted capture session id');
        const path = `F4-${randomUUID()}.ts`;
        const bytes = Buffer.from(`const greeting = \`hello \${name}\`;\n`);
        const sourcePath = join(worktree, path);
        const inputPath = join(store, `F4-${randomUUID()}.json`);
        try {
          const before = (await reader.finite(sessionId, 0n, ctx.signal)).durableSeq;
          await writeFile(sourcePath, bytes);
          const change = await awaitObservedChange(reader, sessionId, { relPath: path,
            before: { kind: 'absent' }, after: { kind: 'content', bytes } }, before, { signal: ctx.signal });
          if (change.after.kind !== 'content') throw new Error('source change has no content snapshot');
          await writeFile(inputPath, JSON.stringify({ text: 'Why a template literal?', context: {
            change_seq: change.seq.toString(), path, snapshot_sha256: change.after.sha256, line_start: 1, line_end: 1,
          } }), { mode: 0o600 });
          const ask = async () => {
            const res = await cli(['ask', '--store', store, '--session', sessionId, '--request-id', randomUUID(), '--input', inputPath]);
            if (res.code !== 0) throw new Error(`ask failed: ${res.stderr}`);
            return (JSON.parse(res.stdout) as { question_id: string }).question_id;
          };
          const q1 = await ask(); const q2 = await ask();
          const claude = { CLAUDE_CODE_SESSION_ID: harnessSessionId, CLAUDE_PROJECT_DIR: worktree };
          const answer = (question_id: string, text: string, env: Record<string, string> = claude) => answerViaForwarder(store, env, question_id, text);
          const claim = async () => {
            const res = await cli(['hook', 'claude-code', 'post-tool-use', '--store', store], { hook_event_name: 'PostToolUse',
              session_id: harnessSessionId, cwd: worktree, transcript_path: transcript, tool_name: 'Bash' });
            if (res.code !== 0 || !res.stdout.includes('slipstream_answer_question')) throw new Error('root hook did not deliver the answer instruction');
          };
          const text = 'It interpolates name into the greeting; a template literal is the idiomatic way.';

          expectCode('answer-before-dispatch', await answer(q1, 'early'), 'QUESTION_NOT_FOUND');
          await claim();
          const first = expectAck('answer-recorded', await answer(q1, text), q1, false);
          const replay = expectAck('same-text-replays-original', await answer(q1, text), q1, true);
          if (replay.seq !== first.seq || replay.answered_at_ms !== first.answered_at_ms) throw new Error('replay changed the original ack');
          expectCode('different-text-conflicts', await answer(q1, 'something else'), 'ANSWER_CONFLICT');
          expectCode('other-root-same-worktree', await answer(q1, text, { ...claude, CLAUDE_CODE_SESSION_ID: randomUUID() }), 'SESSION_NOT_SELECTED');
          expectCode('forwarder-without-identity', await answer(q1, text, { CLAUDE_PROJECT_DIR: worktree }), 'IDENTITY_UNRESOLVED');
          const socketPath = join(store, 'control.sock');
          expectCode('codex-triple-on-claude-binding', await sendControlRequest({ socketPath, request: { v: 1, verb: 'answer_question',
            question_id: q1, text, harness: 'codex', harness_session_id: harnessSessionId, worktree } }), 'SESSION_NOT_SELECTED');
          expectCode('blank-text', await answer(q1, ' \n\t'), 'INVALID_ANSWER');
          expectCode('oversize-text', await answer(q1, 'a'.repeat(16385)), 'INVALID_ANSWER');
          expectCode('unknown-question', await answer(randomUUID(), text), 'QUESTION_NOT_FOUND');
          expectCode('queued-not-dispatched', await answer(q2, text), 'QUESTION_NOT_FOUND');
          await claim();
          const max = 'é'.repeat(8192);
          expectAck('max-size-answer', await answer(q2, max), q2, false);

          const { events, durableSeq } = await reader.finite(sessionId, 0n, ctx.signal);
          const order = events.filter(e => e.type?.startsWith('slipstream.question.'))
            .map(e => `${e.type!.split('.')[2]}:${e.data?.question_id === q1 ? 1 : 2}`);
          const want = ['queued:1', 'queued:2', 'dispatch_attempted:1', 'answered:1', 'dispatch_attempted:2', 'answered:2'];
          if (JSON.stringify(order) !== JSON.stringify(want)) throw new Error(`reader order was ${order.join(',')}`);
          const stored = events.filter(e => e.type === 'slipstream.question.answered.v1').map(e => e.data?.text);
          if (stored[0] !== text || stored[1] !== max) throw new Error('reader did not return the verbatim answers');
          rows['reader-order'] = order;
          const sse = await sseAnswers(reader, sessionId, durableSeq, ctx.signal);
          if (sse !== 2) throw new Error(`SSE replay carried ${sse} answers`);
          rows['sse-replay-has-answers'] = sse;

          const detached = await cli(['detach', '--store', store]);
          if (detached.code !== 0) throw new Error('could not detach answer capture');
          expectCode('answer-after-detach', await answer(q1, text), 'SESSION_NOT_SELECTED');

          await handle.stop(); handle = null;
          handle = await startQaDaemon({ root, reuse: true });
          reader = createReaderClient(handle.env.url, handle.env.token);
          const replayed = (await reader.finite(sessionId, 0n, ctx.signal)).events.filter(e => e.type === 'slipstream.question.answered.v1');
          if (replayed.length !== 2) throw new Error(`restart replay kept ${replayed.length} answers`);
          rows['restart-replay-keeps-answers'] = replayed.length;
          expectCode('answer-after-restart', await answer(q1, text), 'SESSION_NOT_SELECTED');
          return { assertions: [{ id: 'F4-wire', claim: 'A selected Claude root answered dispatched questions through the real MCP forwarder and daemon; every contract fixture row held, the reader and SSE carried the answers in order, and they survived detach and daemon restart without accepting late answers',
            evidence: { capture_session_id: sessionId, rows } }] };
        } finally { await rm(sourcePath, { force: true }); await rm(inputPath, { force: true }); }
      } finally { await rm(transcript, { force: true }); }
    } finally {
      try { await handle?.stop(); }
      finally { await rmMkdtempRoot(root); }
    }
  },
};
