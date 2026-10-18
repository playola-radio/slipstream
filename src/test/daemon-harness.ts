import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendControlRequest } from '../control-client.ts';
import { sessionLogPath } from '../store-reader.ts';
import type { Platform, WatchOptions } from '../platform.ts';
import type { ResponseEnvelope } from '../control-protocol.ts';

/** Control-socket and log helpers shared by the daemon test suites. */

/** Read a field off a response envelope. Ok responses carry open-ended fields
 * that the typed union does not enumerate; a test reads them positionally. */
export function rec(res: ResponseEnvelope): Record<string, string> {
  return res as unknown as Record<string, string>;
}

/** A control request without the protocol version the harness adds. */
export type CallRequest = { verb: string; [key: string]: unknown };
export type Call = (req: CallRequest) => Promise<ResponseEnvelope>;

/** A control caller that behaves like the CLI: a chat attach that finds its
 * workspace's capture still queued or baselining polls `status` and resubmits
 * the same attach once the capture is recording (contracts.md §5). */
export function controlCall(socketPath: string, responseTimeoutMs = 5000): Call {
  const send: Call = (req) => sendControlRequest({ socketPath, request: { v: 1 as const, ...req }, responseTimeoutMs });
  return async (req) => {
    let res = await send(req);
    const chatAttach = req.verb === 'attach' && req.mode === undefined;
    for (let i = 0; chatAttach && res.ok && rec(res).binding_generation === undefined
      && ['queued', 'baselining'].includes(rec(res).state!) && i < 200; i++) {
      const row = rec(await send({ verb: 'status', target: rec(res).session_id })).capture as unknown as Record<string, string>;
      if (row.state !== 'queued' && row.state !== 'baselining') res = await send(req);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return res;
  };
}

/** One capture's status row. */
export async function captureRow(call: Call, target: string): Promise<Record<string, unknown>> {
  const res = await call({ verb: 'status', target });
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res as unknown as { capture: Record<string, unknown> }).capture;
}

/** Poll one capture until `done` holds for its status row. */
export async function waitForRow(call: Call, target: string, done: (row: Record<string, unknown>) => boolean,
  what = 'the expected capture state'): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const row = await captureRow(call, target);
    if (done(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`capture ${target} never reached ${what}: ${JSON.stringify(await captureRow(call, target))}`);
}

export type LogRecord = { seq: string; type: string; data: Record<string, unknown> };
export async function readLog(store: string, id: string): Promise<LogRecord[]> {
  return (await readFile(sessionLogPath(store, id), 'utf8')).trim().split('\n').map(s => JSON.parse(s) as LogRecord);
}

export function createRootsPlatform() {
  const subs = new Map<string, { o: WatchOptions; closed: boolean }>();
  const platform: Platform = {
    watch: async (o) => {
      const s = { o, closed: false };
      subs.set(o.root, s);
      return { close: async () => { s.closed = true; } };
    },
  };
  const live = (root: string): WatchOptions => {
    const s = subs.get(root);
    assert.ok(s && !s.closed, `no live watch on ${root}`);
    return s.o;
  };
  return {
    platform,
    observe: (root: string, path: string) => live(root).onObservation(join(root, path), Date.now()),
    failWith: (root: string, err: Error) => live(root).onError(err),
  };
}

/** Attach Claude chat `chat` to `worktree` through a verified root transcript. */
export async function linkChat(call: Call, store: string, worktree: string, chat: string): Promise<ResponseEnvelope> {
  const transcript = join(store, `${chat}.jsonl`);
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: chat, cwd: worktree,
    version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
  return call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: chat, root_transcript: transcript });
}

export function chatOf(chat: string, worktree: string) {
  return { harness: 'claude-code', harness_session_id: chat, worktree };
}

export function claimOf(store: string, chat: string, worktree: string): CallRequest {
  return { verb: 'claim_question', ...chatOf(chat, worktree), transcript_path: join(store, `${chat}.jsonl`) };
}

export async function waitForLog(store: string, id: string, done: (log: LogRecord[]) => boolean): Promise<LogRecord[]> {
  for (let i = 0; i < 300; i++) {
    const log = await readLog(store, id);
    if (done(log)) return log;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`session ${id} never logged the expected records`);
}
