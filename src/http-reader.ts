import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { access, open, unlink, type FileHandle } from 'node:fs/promises';
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
export interface ReaderServerOptions { storeDir: string; active?: ActiveSession }
export interface ReaderServer {
  url: string; port: number; token: string; descriptorPath: string; close(): Promise<void>;
}

const DURABLE_SEQ_HEADER = 'slipstream-durable-seq';

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
  const token = generateToken();
  const followers = new Set<AbortController>();

  const server = createServer((req, res) => { void handle(req, res).catch((err) => {
    console.error('slipstream reader: request failed', err);
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }); });

  // Bind loopback only; a non-loopback bind must be impossible, not configurable.
  // Reject the returned promise on a listen error (e.g. EADDRINUSE) rather than
  // letting it crash the process with no handler.
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const hostPort = `127.0.0.1:${port}`;
  const url = `http://${hostPort}`;
  let descriptorPath: string;
  try {
    descriptorPath = await publishDescriptor(opts.storeDir, { url, token });
  } catch (err) {
    // Do not leak the listener if we cannot publish the descriptor.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') { send(res, 405, 'method not allowed', { allow: 'GET' }); return; }
    if (!checkHostOrigin(
      req.headers as Record<string,string|string[]|undefined>, hostPort,
      req.headersDistinct.host?.length ?? 0,
    )) {
      send(res, 403, 'forbidden'); return;
    }
    if (!checkAuth(req.headers.authorization, token)) { send(res, 401, 'unauthorized'); return; }

    const { pathname, searchParams } = new URL(req.url ?? '/', url);

    if (pathname === '/v1/sessions') {
      const sessions = await listSessions(opts.storeDir);
      const activeId = opts.active?.id;
      // The active session's authoritative durable high-water is its health
      // boundary, not the disk-derived value (a written-but-not-yet-committed
      // record would otherwise advertise H+1 while /events still uses H).
      const activeH = opts.active ? liveBoundary(opts.active.health).current() : 0n;
      sendJson(res, 200, sessions.map((s) => ({
        id: s.id,
        durable_seq: (s.id === activeId ? activeH : s.durableSeq).toString(),
        removed: s.removed,
      })));
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
      // O_NOFOLLOW: a symlink planted at a valid CAS path must not serve its
      // (out-of-store) target. Size and bytes both come from the one opened fd,
      // closing the stat/open TOCTOU. ELOOP (symlink) maps to 404, like ENOENT.
      let handle: FileHandle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') { send(res, 404, 'not found'); return; }
        throw err;
      }
      let size: number;
      try { size = (await handle.stat()).size; }
      catch (err) { await handle.close(); throw err; }
      if (res.destroyed) { await handle.close(); return; }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      });
      const stream = handle.createReadStream(); // autoClose closes the fd
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

    // Select the effective RAW cursor first — for follow, Last-Event-ID overrides
    // the `after` param — THEN parse once, so a malformed `after` that a valid
    // Last-Event-ID overrides does not spuriously 400.
    const follow = isFollow(params);
    let rawCursor = params.get('after') ?? undefined;
    if (follow) {
      const leiRaw = req.headers['last-event-id'];
      if (typeof leiRaw === 'string') rawCursor = leiRaw;
    }
    const effectiveAfter = parseCursor(rawCursor);
    if (effectiveAfter === null) { send(res, 400, 'invalid cursor'); return; }

    const boundary = await boundaryFor(id);
    const H = boundary.current();
    if (effectiveAfter > H) {
      send(res, 409, 'cursor beyond durable high-water', { [DURABLE_SEQ_HEADER]: H.toString() });
      return;
    }

    if (!follow) {
      // Read (and detect corruption) BEFORE the 200 so a LogCorruptError becomes
      // a clean 500 via the top-level handler, never a 200 with a truncated body.
      const cursor = await openLogCursor(logPath, effectiveAfter);
      let events: Awaited<ReturnType<typeof cursor.readThrough>>;
      try { events = await cursor.readThrough(H); }
      finally { await cursor.close(); }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        [DURABLE_SEQ_HEADER]: H.toString(),
      });
      for (const ev of events) res.write(ev.raw + '\n');
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
      // Remove the descriptor this server published; a dead reader must not leave
      // a stale pointer behind. ENOENT (already gone) is fine.
      await unlink(descriptorPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
    },
  };
}
