import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Health } from './health.ts';
import {
  listSessions, readTombstone, isValidSessionId, sessionLogPath, onDiskHighWater,
  blobPath, isValidHex, schemaBytes,
} from './store-reader.ts';
import { checkAuth, checkHostOrigin, generateToken, publishDescriptor } from './http-security.ts';
import { parseCursor, openLogCursor, LogCorruptError, type LogCursor } from './log-reader.ts';
import { liveBoundary, staticBoundary, type BoundarySource } from './reader-runtime.ts';

export interface ActiveSession { id: string; health: Health; logPath: string }
export interface ReaderServerOptions { storeDir: string; active?: ActiveSession; host?: string; port?: number }
export interface ReaderServer {
  url: string; port: number; token: string; descriptorPath: string; close(): Promise<void>;
}

export const DURABLE_SEQ_HEADER = 'slipstream-durable-seq';

const SSE_HEARTBEAT_MS = 15000;
const SSE_DRAIN_DEADLINE_MS = 10000;

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string,string> = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
}

function isFollow(params: URLSearchParams): boolean {
  const v = params.get('follow');
  return v === 'true' || v === '1';
}

async function writeBackpressured(res: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('aborted');
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('drain timeout')); }, SSE_DRAIN_DEADLINE_MS);
    const onDrain = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { clearTimeout(timer); res.off('drain', onDrain); signal.removeEventListener('abort', onAbort); };
    res.once('drain', onDrain); signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function startReaderServer(opts: ReaderServerOptions): Promise<ReaderServer> {
  const host = opts.host ?? '127.0.0.1';
  const token = generateToken();
  const followers = new Set<AbortController>();

  const server = createServer((req, res) => { void handle(req, res).catch((err) => {
    console.error('slipstream reader: request failed', err);
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
    const blobMatch = pathname.match(/^\/v1\/blobs\/sha256\/([^/]+)$/);
    if (blobMatch) {
      const hex = blobMatch[1]!;
      if (!isValidHex(hex)) { send(res, 400, 'invalid hash'); return; }
      const path = blobPath(opts.storeDir, hex);
      let size: number;
      try { size = (await stat(path)).size; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { send(res, 404, 'not found'); return; }
        throw err;
      }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      });
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    const schemaMatch = pathname.match(/^\/v1\/schemas\/([^/]+)$/);
    if (schemaMatch) {
      const bytes = await schemaBytes(decodeURIComponent(schemaMatch[1]!));
      if (!bytes) { send(res, 404, 'not found'); return; }
      send(res, 200, bytes, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }

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

    // Last-Event-ID overrides after (follow only), validated the same way
    let effectiveAfter = after;
    const follow = isFollow(params);
    if (follow) {
      const leiRaw = req.headers['last-event-id'];
      if (typeof leiRaw === 'string') {
        const lei = parseCursor(leiRaw);
        if (lei === null) { send(res, 400, 'invalid cursor'); return; }
        effectiveAfter = lei;
      }
    }

    const boundary = await boundaryFor(id);
    const H = boundary.current();
    if (effectiveAfter > H) {
      send(res, 409, 'cursor beyond durable high-water', { [DURABLE_SEQ_HEADER]: H.toString() });
      return;
    }

    if (!follow) {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        [DURABLE_SEQ_HEADER]: H.toString(),
      });
      const cursor = await openLogCursor(logPath, effectiveAfter);
      try { for (const ev of await cursor.readThrough(H)) res.write(ev.raw + '\n'); }
      finally { await cursor.close(); }
      res.end();
      return;
    }

    // follow=true: SSE, one cursor over disk bounded by the advancing durable boundary.
    // Register cancellation BEFORE acquiring any resource so a disconnect during
    // setup drives teardown; keep the cursor and heartbeat inside one try/finally.
    const ac = new AbortController();
    const onDisconnect = () => ac.abort();
    res.on('close', onDisconnect);
    res.on('error', onDisconnect);
    followers.add(ac);
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8' });

    // Serialize every write (events and heartbeats) through the bounded path so
    // an idle client that stops reading eventually hits SSE_DRAIN_DEADLINE_MS and
    // is aborted, and so heartbeats never interleave with an in-flight event write.
    let tail: Promise<void> = Promise.resolve();
    const write = (chunk: string): Promise<void> => {
      tail = tail.then(() => writeBackpressured(res, chunk, ac.signal));
      return tail;
    };

    let cursor: LogCursor | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (ac.signal.aborted || res.destroyed) return;
      cursor = await openLogCursor(logPath, effectiveAfter);
      if (ac.signal.aborted || res.destroyed) return;
      heartbeat = setInterval(() => { write(': heartbeat\n\n').catch(() => ac.abort()); }, SSE_HEARTBEAT_MS);
      let cur = effectiveAfter;
      for (;;) {
        const target = boundary.current();
        if (target > cur) {
          for (const ev of await cursor.readThrough(target)) {
            await write(`id: ${ev.seq}\nevent: slipstream\ndata: ${ev.raw}\n\n`);
            cur = ev.seq;
          }
          // Durability ordering guarantees records ≤ H are fsync'd before H is
          // published, so falling short of an advertised target is real
          // truncation/corruption — surface it rather than busy-looping.
          if (cur < target) throw new LogCorruptError('disk short of durable boundary');
        }
        await boundary.waitForAdvance(cur, ac.signal); // rejects on abort → exits loop
      }
    } catch (err) {
      // Corruption must not be silent (honesty). An abort/drain-timeout stays silent.
      if (err instanceof LogCorruptError) console.error('slipstream reader: corruption in SSE follow', err);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (cursor) await cursor.close();
      followers.delete(ac);
      if (!res.writableEnded) res.destroy();
    }
  }

  return {
    url, port, token, descriptorPath,
    close: async () => {
      for (const ac of followers) ac.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
