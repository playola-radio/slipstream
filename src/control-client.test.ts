import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendControlRequest, OutcomeUnknownError } from './control-client.ts';
import { encodeMessage, createLineDecoder, type RequestEnvelope } from './control-protocol.ts';

const REQ: RequestEnvelope = { v: 1, id: 'r1', verb: 'status' };

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
      void readOneRequest(sock).then((req) => {
        sock.write(encodeMessage({ v: 1, id: (req as RequestEnvelope).id, ok: true, state: 'detached' }));
      });
    }, async (socketPath) => {
      const res = await sendControlRequest({ socketPath, request: REQ });
      assert.deepEqual(res, { v: 1, id: 'r1', ok: true, state: 'detached' });
    });
  });

  it('echoes the correlation id back to the caller', async () => {
    await withServer((sock) => {
      void readOneRequest(sock).then((req) => {
        const id = (req as RequestEnvelope).id;
        sock.write(encodeMessage({ v: 1, id, ok: false, code: 'CAPTURE_NOT_READY', message: 'no' }));
      });
    }, async (socketPath) => {
      const res = await sendControlRequest({ socketPath, request: REQ });
      assert.equal(res.id, 'r1');
      assert.equal(res.ok, false);
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

  it('reports DAEMON_UNAVAILABLE, not unknown, on a pre-connect failure', async () => {
    // Nothing is listening on this path — a connect refusal is proof nothing ran.
    const dir = await mkdtemp(join(tmpdir(), 'slip-cc-'));
    try {
      const res = await sendControlRequest({
        socketPath: join(dir, 'nobody.sock'), request: REQ, connectTimeoutMs: 200,
      });
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
});
