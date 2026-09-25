import { controlSocketPath } from './daemon-location.ts';
import { sendControlRequest } from './control-client.ts';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024;
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown, maxBytes = 4096): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/** An unsupported or partial callback never asks the daemon to consume a question. */
export async function codexPostToolUse(input: unknown, storeDir: string): Promise<string | null> {
  const event = object(input);
  if (!event || event.hook_event_name !== 'PostToolUse' || !nonempty(event.session_id)
    || !nonempty(event.cwd) || !nonempty(event.transcript_path)
    || Object.hasOwn(event, 'agent_id') || Object.hasOwn(event, 'agent_type')) return null;
  try {
    const reply = await sendControlRequest({ socketPath: controlSocketPath(storeDir),
      request: { v: 1, verb: 'claim_question', harness: 'codex', harness_session_id: event.session_id,
        worktree: event.cwd, transcript_path: event.transcript_path },
      connectTimeoutMs: 300, responseTimeoutMs: 700 });
    if (!reply.ok || reply.question === null) return null;
    const q = object(reply.question);
    const context = object(q?.context);
    if (!q || !context || !nonempty(q.question_id) || !nonempty(q.text, 8192)
      || !nonempty(context.path) || typeof context.selected_text !== 'string'
      || !Number.isSafeInteger(context.line_start) || !Number.isSafeInteger(context.line_end)) return null;
    const additionalContext = [
      `Slipstream question ${q.question_id} about the current captured change. Answer the user in your normal conversation, then continue your original work.`,
      `Question: ${q.text}`,
      `Source: ${context.path}, lines ${context.line_start}-${context.line_end} (recorded snapshot).`,
      `Selected source, verbatim without truncation:\n${context.selected_text}`,
    ].join('\n');
    if (Buffer.byteLength(additionalContext, 'utf8') > MAX_CONTEXT_BYTES) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
  } catch { return null; }
}

/** Bounded stdin prevents a malformed hook payload from retaining unbounded bytes. */
export function readHookInput(stream: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onError);
      if (error) reject(error);
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('invalid callback')); }
      }
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) finish(new Error('callback too large'));
      else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error('callback read failed'));
    const timer = setTimeout(() => finish(new Error('callback timeout')), 1000);
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError);
  });
}
