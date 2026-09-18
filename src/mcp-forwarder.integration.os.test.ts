import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type Daemon } from './daemon.ts';
import { sendControlRequest } from './control-client.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import type { ResponseEnvelope } from './control-protocol.ts';

const FORWARDER = fileURLToPath(new URL('./mcp-forwarder.ts', import.meta.url));
const HARNESS_SESSION_ID = 'session-abc';

/** A JSON-RPC client over a spawned forwarder's stdio. The forwarder answers one
 * response per request in order, so each call awaits the next stdout line. */
class ForwarderProcess {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private rl: Interface;
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  constructor(store: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [FORWARDER, '--store', store], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      if (line.trim().length === 0) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async rpc(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.child.stdin.write(JSON.stringify(request) + '\n');
    return JSON.parse(await this.nextLine());
  }

  async initialize(): Promise<void> {
    await this.rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '1' } },
    });
  }

  async beginTask(title: string): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    const res = await this.rpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'slipstream_begin_task', arguments: { title } },
    });
    const result = res.result as { content: Array<{ text: string }>; isError: boolean; structuredContent?: unknown };
    return { text: result.content[0]!.text, isError: result.isError, structured: result.structuredContent };
  }

  async close(): Promise<void> {
    this.rl.close();
    this.child.stdin.end();
    this.child.kill();
    await new Promise<void>((resolve) => this.child.once('close', () => resolve()));
  }
}

async function withAttachedDaemon(
  fn: (ctx: { store: string; worktree: string; otherWorktree: string; daemon: Daemon }) => Promise<void>,
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-fwd-int-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-fwd-int-wt-'));
  const otherWorktree = await mkdtemp(join(tmpdir(), 'slip-fwd-int-other-'));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storeDir: store,
      captureDependencies: { platform: createFakePlatform(), enumerate: async () => {} },
    });
    const attach: ResponseEnvelope = await sendControlRequest({
      socketPath: daemon.socketPath,
      request: { v: 1, verb: 'attach', worktree, harness: 'claude-code', harness_session_id: HARNESS_SESSION_ID },
      responseTimeoutMs: 5000,
    });
    assert.equal(attach.ok, true);
    await fn({ store, worktree, otherWorktree, daemon });
  } finally {
    await daemon?.stop();
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    await rm(otherWorktree, { recursive: true, force: true });
  }
}

describe('forwarder subprocess against a real daemon', () => {
  it('the selected worktree commits a task through the whole chain', async () => {
    await withAttachedDaemon(async ({ store, worktree }) => {
      const fwd = new ForwarderProcess(store, {
        CLAUDE_CODE_SESSION_ID: HARNESS_SESSION_ID,
        CLAUDE_PROJECT_DIR: worktree,
      });
      try {
        await fwd.initialize();
        const res = await fwd.beginTask('Wire the forwarder');
        assert.equal(res.isError, false, res.text);
        const s = res.structured as Record<string, unknown>;
        assert.ok(s && typeof s.task_id === 'string');
        assert.ok(typeof s.session_id === 'string');
      } finally {
        await fwd.close();
      }
    });
  });

  it('a forwarder in a non-selected worktree gets SESSION_NOT_SELECTED and cannot steal ownership', async () => {
    await withAttachedDaemon(async ({ store, otherWorktree, daemon }) => {
      const fwd = new ForwarderProcess(store, {
        CLAUDE_CODE_SESSION_ID: HARNESS_SESSION_ID,
        CLAUDE_PROJECT_DIR: otherWorktree,
      });
      try {
        await fwd.initialize();
        const res = await fwd.beginTask('Task from the wrong worktree');
        assert.equal(res.isError, true);
        assert.match(res.text, /SESSION_NOT_SELECTED/);
      } finally {
        await fwd.close();
      }
      // The selected session is untouched: the non-selected forwarder stole nothing.
      const status = await sendControlRequest({
        socketPath: daemon.socketPath,
        request: { v: 1, verb: 'status' },
        responseTimeoutMs: 5000,
      });
      assert.equal((status as unknown as Record<string, string>).state, 'active');
    });
  });
});
