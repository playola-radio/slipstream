import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Health } from './health.ts';
import { listSessions } from './store-reader.ts';
import { checkAuth, checkHostOrigin, generateToken, publishDescriptor } from './http-security.ts';

export interface ActiveSession { id: string; health: Health; logPath: string }
export interface ReaderServerOptions { storeDir: string; active?: ActiveSession; host?: string; port?: number }
export interface ReaderServer {
  url: string; port: number; token: string; descriptorPath: string; close(): Promise<void>;
}

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

    const { pathname } = new URL(req.url ?? '/', url);

    if (pathname === '/v1/sessions') {
      const sessions = await listSessions(opts.storeDir);
      sendJson(res, 200, sessions.map((s) => ({ id: s.id, durable_seq: s.durableSeq.toString(), removed: s.removed })));
      return;
    }
    // events / blobs / schemas routes added in later tasks
    send(res, 404, 'not found');
  }

  return {
    url, port, token, descriptorPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
