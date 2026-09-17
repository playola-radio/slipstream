import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Health } from './health.ts';
import { listSessions, readTombstone, isValidSessionId, sessionLogPath, onDiskHighWater } from './store-reader.ts';
import { checkAuth, checkHostOrigin, generateToken, publishDescriptor } from './http-security.ts';
import { parseCursor, openLogCursor } from './log-reader.ts';
import { liveBoundary, staticBoundary, type BoundarySource } from './reader-runtime.ts';

export interface ActiveSession { id: string; health: Health; logPath: string }
export interface ReaderServerOptions { storeDir: string; active?: ActiveSession; host?: string; port?: number }
export interface ReaderServer {
  url: string; port: number; token: string; descriptorPath: string; close(): Promise<void>;
}

export const DURABLE_SEQ_HEADER = 'slipstream-durable-seq';

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string,string> = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
}

export async function startReaderServer(opts: ReaderServerOptions): Promise<ReaderServer> {
  const host = opts.host ?? '127.0.0.1';
  const token = generateToken();

  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }); });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  const hostPort = `${host}:${port}`;
  const url = `http://${hostPort}`;
  const descriptorPath = await publishDescriptor(opts.storeDir, { url, token });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') { send(res, 405, 'method not allowed', { allow: 'GET' }); return; }
    if (!checkHostOrigin(req.headers as Record<string,string|string[]|undefined>, hostPort)) {
      send(res, 403, 'forbidden'); return;
    }
    if (!checkAuth(req.headers.authorization, token)) { send(res, 401, 'unauthorized'); return; }

    const { pathname, searchParams } = new URL(req.url ?? '/', url);

    if (pathname === '/v1/sessions') {
      const sessions = await listSessions(opts.storeDir);
      sendJson(res, 200, sessions.map((s) => ({ id: s.id, durable_seq: s.durableSeq.toString(), removed: s.removed })));
      return;
    }
    const eventsMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      await handleEvents(req, res, decodeURIComponent(eventsMatch[1]!), searchParams);
      return;
    }
    // blobs / schemas routes added in later tasks
    send(res, 404, 'not found');
  }

  async function boundaryFor(id: string): Promise<BoundarySource> {
    if (opts.active?.id === id) return liveBoundary(opts.active.health);
    return staticBoundary(await onDiskHighWater(sessionLogPath(opts.storeDir, id)));
  }

  async function handleEvents(
    req: IncomingMessage, res: ServerResponse, id: string, params: URLSearchParams,
  ): Promise<void> {
    if (!isValidSessionId(id)) { send(res, 404, 'not found'); return; }
    if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
    const logPath = sessionLogPath(opts.storeDir, id);
    try { await access(logPath); } catch { send(res, 404, 'not found'); return; }

    const after = parseCursor(params.get('after') ?? undefined);
    if (after === null) { send(res, 400, 'invalid cursor'); return; }

    const boundary = await boundaryFor(id);
    const H = boundary.current();
    if (after > H) {
      send(res, 409, 'cursor beyond durable high-water', { [DURABLE_SEQ_HEADER]: H.toString() });
      return;
    }

    // follow handled in Task 9; this task is finite only
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
      [DURABLE_SEQ_HEADER]: H.toString(),
    });
    const cursor = await openLogCursor(logPath, after);
    try {
      const events = await cursor.readThrough(H);
      for (const ev of events) res.write(ev.raw + '\n');
    } finally { await cursor.close(); }
    res.end();
  }

  return {
    url, port, token, descriptorPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
