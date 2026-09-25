/** Live D1 acceptance: queue one question from an actual captured snapshot. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { awaitObservedChange, type AnyRecord, type Assertion } from '../../qa-support.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

const exec = promisify(execFile);
const QUESTION_TYPE = 'slipstream.question.queued.v1';
const QUESTION_TTL_MS = 1_800_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type QuestionContext = {
  change_seq: string;
  path: string;
  snapshot_sha256: string;
  line_start: number;
  line_end: number;
  selected_text: string;
};

type Target = { harness: 'codex'; harness_session_id: string; worktree: string };

export interface QueuedQuestionExpectation {
  sessionId: string;
  requestId: string;
  questionId?: string;
  text: string;
  context: QuestionContext;
  target: Target;
  seq?: string;
  queuedAtMs?: number;
  expiresAtMs?: number;
}

function fail(message: string): never { throw new Error(message); }

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${name} is not an object`);
  return value as Record<string, unknown>;
}

/** Check the public reader's complete durable question identity and context. */
export function assertQueuedQuestion(events: readonly AnyRecord[], expected: QueuedQuestionExpectation): AnyRecord {
  const queued = events.filter((event) => event.type === QUESTION_TYPE);
  if (queued.length !== 1) fail(`expected exactly one queued question event, found ${queued.length}`);
  const event = queued[0]!;
  const data = object(event.data, 'queued event data');
  const seq = event.seq;
  if (typeof seq !== 'string' || !/^[1-9][0-9]*$/.test(seq)) fail('queued event has no canonical seq');
  if (event.id !== seq) fail(`queued event id ${String(event.id)} must equal seq ${seq}`);
  if (event.source !== `urn:slipstream:session:${expected.sessionId}`) fail('queued event source does not name the selected session');
  if (data.session_id !== expected.sessionId) fail('queued event session_id does not match the selected session');
  if (data.request_id !== expected.requestId) fail('queued event request_id does not match the CLI request');
  if (typeof data.question_id !== 'string' || !UUID_RE.test(data.question_id)) fail('queued event has no canonical question_id');
  if (expected.questionId !== undefined && data.question_id !== expected.questionId) fail('queued event question_id does not match acknowledgment');
  if (event.subject !== `question/${data.question_id}`) fail('queued event subject does not match question_id');
  if (data.text !== expected.text) fail('queued event text does not match normalized CLI input');
  if (event.seq !== expected.seq && expected.seq !== undefined) fail('queued event seq does not match CLI acknowledgment');
  const target = object(data.target, 'queued event target');
  for (const key of ['harness', 'harness_session_id', 'worktree'] as const) {
    if (target[key] !== expected.target[key]) fail(`queued event target.${key} does not match the attached target`);
  }

  const context = object(data.context, 'queued event context');
  for (const key of ['change_seq', 'path', 'snapshot_sha256', 'line_start', 'line_end', 'selected_text'] as const) {
    if (context[key] !== expected.context[key]) fail(`queued event context.${key} does not match the source snapshot`);
  }
  const queuedAt = data.queued_at_ms;
  const expiresAt = data.expires_at_ms;
  if (typeof queuedAt !== 'number' || typeof expiresAt !== 'number'
    || !Number.isSafeInteger(queuedAt) || !Number.isSafeInteger(expiresAt)) fail('queued event timestamps are not safe integers');
  if (expiresAt !== queuedAt + QUESTION_TTL_MS) fail('queued event expiry is not exactly the queue TTL after queued_at_ms');
  if (expected.queuedAtMs !== undefined && queuedAt !== expected.queuedAtMs) fail('queued event queued_at_ms does not match acknowledgment');
  if (expected.expiresAtMs !== undefined && expiresAt !== expected.expiresAtMs) fail('queued event expires_at_ms does not match acknowledgment');
  return event;
}

function fields(stdout: string): Record<string, unknown> {
  try { return object(JSON.parse(stdout), 'CLI acknowledgment'); }
  catch {
    const out: Record<string, unknown> = {};
    for (const line of stdout.trim().split('\n')) {
      const match = /^([a-z_]+): (.*)$/.exec(line);
      if (match) out[match[1]!] = match[2]!;
    }
    return out;
  }
}

async function cli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await exec(process.execPath, ['src/cli.ts', ...args], { timeout: 15_000 });
  return fields(stdout);
}

async function ask(store: string, sessionId: string, requestId: string, input: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec(process.execPath, ['src/cli.ts', 'ask', '--store', store, '--session', sessionId, '--request-id', requestId, '--input', input], { timeout: 15_000 });
  try { return object(JSON.parse(stdout), 'CLI ask acknowledgment'); }
  catch { fail('CLI ask acknowledgment is not JSON'); }
}

export interface AskAcknowledgment {
  sessionId: string;
  requestId: string;
  questionId: string;
  seq: string;
  queuedAtMs: number;
  expiresAtMs: number;
  duplicate: boolean;
}

export function assertAskAcknowledgment(
  ack: Record<string, unknown>, sessionId: string, requestId: string, duplicate: boolean,
): AskAcknowledgment {
  if (ack.v !== 1 || ack.ok !== true) fail('CLI acknowledgment is not a v1 successful response');
  if (ack.session_id !== sessionId) fail('CLI acknowledgment did not return the selected session_id');
  if (ack.request_id !== requestId) fail('CLI acknowledgment did not return the submitted request_id');
  if (ack.duplicate !== duplicate) fail(`CLI acknowledgment duplicate must be ${duplicate}`);
  const questionId = ack.question_id;
  const seq = ack.seq;
  const queuedAtMs = Number(ack.queued_at_ms);
  const expiresAtMs = Number(ack.expires_at_ms);
  if (typeof questionId !== 'string' || !UUID_RE.test(questionId)) fail('CLI acknowledgment has no canonical question_id');
  if (typeof seq !== 'string' || !/^[1-9][0-9]*$/.test(seq)) fail('CLI acknowledgment has no canonical seq');
  if (!Number.isSafeInteger(queuedAtMs) || !Number.isSafeInteger(expiresAtMs)) fail('CLI acknowledgment has invalid queue timestamps');
  if (expiresAtMs !== queuedAtMs + QUESTION_TTL_MS) fail('CLI acknowledgment expiry is not exactly the queue TTL after queued_at_ms');
  return { sessionId, requestId, questionId, seq, queuedAtMs, expiresAtMs, duplicate };
}

function sameAcknowledgment(first: AskAcknowledgment, retry: AskAcknowledgment): void {
  for (const key of ['sessionId', 'requestId', 'questionId', 'seq', 'queuedAtMs', 'expiresAtMs'] as const) {
    if ((first[key] as unknown) !== (retry[key] as unknown)) fail(`same-id retry changed acknowledgment ${key}`);
  }
}

async function expectInvalidContext(store: string, sessionId: string, requestId: string, input: string): Promise<void> {
  try {
    await ask(store, sessionId, requestId, input);
  } catch (err) {
    const failed = err as { code?: unknown; stderr?: unknown };
    if (failed.code !== 1) fail(`wrong context CLI exited ${String(failed.code)}, expected 1`);
    let reply: Record<string, unknown>;
    try { reply = object(JSON.parse(String(failed.stderr).trim()), 'CLI invalid-context response'); }
    catch { fail('wrong context CLI did not print a JSON response'); }
    if (reply.v !== 1 || reply.ok !== false || reply.code !== 'INVALID_CONTEXT') {
      fail('wrong context CLI did not return v1 INVALID_CONTEXT');
    }
    return;
  }
  fail('wrong source context was accepted by the CLI');
}

export const f1Ask: AcceptanceModule = {
  id: 'F1-ask',
  async run(ctx) {
    // qa-daemon's normal `qa` harness is deliberately not a D1 target. Rebind
    // this disposable capture through public control with a supported identity.
    const store = ctx.store ?? fail('F1-ask requires the runner to provide its disposable store');
    await cli(['detach', '--store', store]);
    const harnessSessionId = `f1-${randomUUID()}`;
    const attached = await cli([
      'attach', ctx.worktree, '--store', store, '--harness', 'codex',
      '--harness-session-id', harnessSessionId,
    ]);
    const sessionId = typeof attached.session_id === 'string' ? attached.session_id : fail('attach did not return a session_id');
    const target: Target = { harness: 'codex', harness_session_id: harnessSessionId, worktree: await realpath(ctx.worktree) };
    const path = `F1-ask-${randomUUID()}.swift`;
    const bytes = Buffer.from('first line\nsecond line\n', 'utf8');
    const before = (await ctx.reader.finite(sessionId, 0n, ctx.signal)).durableSeq;
    await writeFile(join(ctx.worktree, path), bytes);
    const change = await awaitObservedChange(ctx.reader, sessionId, {
      relPath: path,
      before: { kind: 'absent' },
      after: { kind: 'content', bytes },
    }, before, { signal: ctx.signal });
    if (change.after.kind !== 'content') fail('real captured change has no content snapshot');

    const requestId = randomUUID();
    const inputPath = join(store, `F1-ask-${randomUUID()}.json`);
    const text = 'What changed in these lines?';
    const context = {
      change_seq: change.seq.toString(), path, snapshot_sha256: change.after.sha256,
      line_start: 1, line_end: 2,
    };
    await writeFile(inputPath, JSON.stringify({ text, context }), { mode: 0o600 });
    try {
      const first = assertAskAcknowledgment(await ask(store, sessionId, requestId, inputPath), sessionId, requestId, false);
      const retry = assertAskAcknowledgment(await ask(store, sessionId, requestId, inputPath), sessionId, requestId, true);
      sameAcknowledgment(first, retry);
      const { events } = await ctx.reader.finite(sessionId, 0n, ctx.signal);
      const selected = 'first line\nsecond line';
      const event = assertQueuedQuestion(events, {
        sessionId, requestId, text, target, seq: first.seq, questionId: first.questionId,
        queuedAtMs: first.queuedAtMs, expiresAtMs: first.expiresAtMs,
        context: { ...context, selected_text: selected },
      });

      const count = events.filter((candidate) => candidate.type === QUESTION_TYPE).length;
      const badPath = join(store, `F1-ask-invalid-${randomUUID()}.json`);
      await writeFile(badPath, JSON.stringify({ text, context: { ...context, path: `${path}.wrong` } }), { mode: 0o600 });
      try {
        await expectInvalidContext(store, sessionId, randomUUID(), badPath);
      } finally { await rm(badPath, { force: true }); }
      const afterBad = await ctx.reader.finite(sessionId, 0n, ctx.signal);
      if (afterBad.events.filter((candidate) => candidate.type === QUESTION_TYPE).length !== count) {
        fail('invalid source context created a queued question');
      }
      return { assertions: [{
        id: 'F1-ask-live',
        claim: 'LIVE: a real captured change queued exactly one durable, complete question through CLI retry; invalid context queued none',
        evidence: { change_seq: change.seq.toString(), question_seq: event.seq, request_id: requestId, queued_events: count },
      }] };
    } finally { await rm(inputPath, { force: true }); }
  },
};
