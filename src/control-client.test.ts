import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { encodeMessage, createLineDecoder, type RequestEnvelope } from './control-protocol.ts';

const REQ: RequestEnvelope = { v: 1, verb: 'status' };

/** A unix-socket server whose per-connection behavior is supplied by `onConn`. */
async function withServer(
  onConn: (sock: Socket) => void,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-cc-'));
  const socketPath = join(dir, 'control.sock');
  const server: Server = createServer(onConn);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await fn(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads one framed request off a server-side socket. */
function readOneRequest(sock: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const dec = createLineDecoder();
    sock.on('data', (chunk: Buffer) => {
      try {
        const msgs = dec.push(chunk);
        if (msgs.length) resolve(msgs[0]);
      } catch (err) { reject(err); }
    });
    sock.on('error', reject);
  });
}

describe('control-client', () => {
  it('sends one request and resolves the framed response', async () => {
    await withServer((sock) => {
      void readOneRequest(sock).then(() => {
        sock.write(encodeMessage({ v: 1, ok: true, state: 'detached' }));
      });
    }, async (socketPath) => {
      const res = await sendControlRequest({ socketPath, request: REQ });
      assert.deepEqual(res, { v: 1, ok: true, state: 'detached' });
    });
  });

  it('synthesizes DAEMON_UNAVAILABLE when the socket path does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slip-cc-'));
    try {
      const res = await sendControlRequest({ socketPath: join(dir, 'nope.sock'), request: REQ });
      assert.equal(res.ok, false);
      assert.equal(res.ok === false && res.code, 'DAEMON_UNAVAILABLE');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('raises OUTCOME UNKNOWN (never DAEMON_UNAVAILABLE) when the daemon accepts but never replies', async () => {
    await withServer((sock) => {
      // Accept the request, then go silent: the write may have committed.
      void readOneRequest(sock).catch(() => {});
    }, async (socketPath) => {
      await assert.rejects(
        sendControlRequest({ socketPath, request: REQ, responseTimeoutMs: 200 }),
        (err) => err instanceof OutcomeUnknownError,
      );
    });
  });

  it('bounds a slow response by an absolute deadline shared with earlier hook work', async () => {
    await withServer((sock) => { void readOneRequest(sock).catch(() => {}); }, async (socketPath) => {
      const started = Date.now();
      await assert.rejects(sendControlRequest({ socketPath, request: REQ,
        connectTimeoutMs: 1000, responseTimeoutMs: 5000, deadlineAtMs: started + 500,
      }), OutcomeUnknownError);
      assert.ok(Date.now() - started < 2000);
    });
  });

  it('raises OUTCOME UNKNOWN when the connection drops after the request was sent', async () => {
    await withServer((sock) => {
      void readOneRequest(sock).then(() => sock.destroy()); // close without responding
    }, async (socketPath) => {
      await assert.rejects(
        sendControlRequest({ socketPath, request: REQ, responseTimeoutMs: 2000 }),
        (err) => err instanceof OutcomeUnknownError,
      );
    });
  });

  it('raises OUTCOME UNKNOWN when the reply is not well-formed framing', async () => {
    await withServer((sock) => {
      void readOneRequest(sock).then(() => sock.write(Buffer.from('{not json}\n')));
    }, async (socketPath) => {
      await assert.rejects(
        sendControlRequest({ socketPath, request: REQ, responseTimeoutMs: 2000 }),
        (err) => err instanceof OutcomeUnknownError,
      );
    });
  });

  for (const [label, reply] of [
    ['a bare null', 'null\n'],
    ['a success object missing the version', '{"ok":true}\n'],
    ['an error object missing its code', '{"v":1,"ok":false,"message":"x"}\n'],
  ] as const) {
    it(`raises OUTCOME UNKNOWN when the reply is valid JSON but not a response envelope (${label})`, async () => {
      await withServer((sock) => {
        void readOneRequest(sock).then(() => sock.write(Buffer.from(reply)));
      }, async (socketPath) => {
        await assert.rejects(
          sendControlRequest({ socketPath, request: REQ, responseTimeoutMs: 2000 }),
          (err) => err instanceof OutcomeUnknownError,
        );
      });
    });
  }
});
