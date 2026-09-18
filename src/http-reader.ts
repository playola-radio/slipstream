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
import { createBoundaryRegistry, type BoundaryRegistry } from './boundary-registry.ts';

export interface ActiveSession { id: string; health: Health; logPath: string }
export interface ReaderServerOptions {
  storeDir: string;
  /** Standalone single-session view (`serve`). Ignored when {@link registry} is
   * given; internally it becomes a one-entry registry. */
  active?: ActiveSession;
  /** The daemon's dynamic boundary registry (D3): authoritative per-session
   * boundaries plus the SSE-follower set aborted on a session transition. When
   * absent, boundaries come from `active` (if any) or from disk high-water. */
  registry?: BoundaryRegistry;
}
export interface ReaderServer {
  url: string; port: number; token: string; descriptorPath: string; close(): Promise<void>;
}

const DURABLE_SEQ_HEADER = 'slipstream-durable-seq';

const SSE_HEARTBEAT_MS = 15000;
const DRAIN_DEADLINE_MS = 10000;

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
    const timer = setTimeout(() => { cleanup(); reject(new Error('drain timeout')); }, DRAIN_DEADLINE_MS);
    const onDrain = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { clearTimeout(timer); res.off('drain', onDrain); signal.removeEventListener('abort', onAbort); };
    res.once('drain', onDrain); signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function startReaderServer(opts: ReaderServerOptions): Promise<ReaderServer> {
  const token = generateToken();
  const followers = new Set<AbortController>();
  let closing = false;

  // One resolution path for boundaries. In standalone `serve` mode the caller's
  // `active` session becomes a one-entry registry with a live boundary, so the
  // rest of the server never special-cases it. The daemon passes its own registry.
  const registry = opts.registry ?? createBoundaryRegistry();
  if (opts.active && !opts.registry) {
    registry.installIfAbsent(opts.active.id, liveBoundary(opts.active.health));
  }

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
      // A registry-known session's authoritative durable high-water is its
      // boundary, not the disk-derived value (a written-but-not-yet-committed
      // record would otherwise advertise H+1 while /events still uses H; a
      // reserved-but-not-yet-active session reads 0 until capture commits).
      sendJson(res, 200, sessions.map((s) => {
        const runtime = registry.get(s.id);
        return {
          id: s.id,
          durable_seq: (runtime ? runtime.boundary.current() : s.durableSeq).toString(),
          removed: s.removed,
        };
      }));
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
      let type: string;
      try { type = decodeURIComponent(schemaMatch[1]!); }
      catch { send(res, 400, 'invalid type'); return; }
      if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(type)) {
        send(res, 400, 'invalid type'); return;
      }
      const bytes = await schemaBytes(type);
      if (!bytes) { send(res, 404, 'not found'); return; }
      send(res, 200, bytes, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }

    send(res, 404, 'not found');
  }

  async function boundaryFor(id: string): Promise<BoundarySource> {
    // The registry is authoritative for every session the daemon has touched
    // this run. Disk high-water is the fallback ONLY for daemon-unknown sessions
    // (retained from a prior run, immutable now) — never for one mid-write.
    const runtime = registry.get(id);
    if (runtime) return runtime.boundary;
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
      const ac = new AbortController();
      const onDisconnect = () => ac.abort();
      res.on('close', onDisconnect);
      res.on('error', onDisconnect);
      followers.add(ac);
      let cursor: LogCursor | undefined;
      try {
        if (closing || res.destroyed) return;
        // Validate in bounded batches before headers to preserve a clean 500 on
        // corruption anywhere in (after, H]. Append-only history is then replayed
        // in a second bounded pass; no whole-log array is retained.
        cursor = await openLogCursor(logPath, effectiveAfter);
        for (let seq = effectiveAfter; seq < H;) {
          if (ac.signal.aborted) return;
          const batch = await cursor.readThrough(H);
          if (!batch.length) throw new LogCorruptError('disk short of durable boundary');
          seq = batch[batch.length - 1]!.seq;
        }
        await cursor.close();
        cursor = undefined;
        cursor = await openLogCursor(logPath, effectiveAfter);
        if (ac.signal.aborted) return;
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/x-ndjson; charset=utf-8',
          [DURABLE_SEQ_HEADER]: H.toString(),
        });
        for (let seq = effectiveAfter; seq < H;) {
          if (ac.signal.aborted) return;
          const batch = await cursor.readThrough(H);
          if (!batch.length) throw new LogCorruptError('disk short of durable boundary');
          for (const ev of batch) await writeBackpressured(res, ev.raw + '\n', ac.signal);
          seq = batch[batch.length - 1]!.seq;
        }
        res.end();
      } finally {
        await cursor?.close();
        followers.delete(ac);
        res.off('close', onDisconnect);
        res.off('error', onDisconnect);
        if (ac.signal.aborted && !res.writableEnded) res.destroy();
      }
      return;
    }

    const ac = new AbortController();
    const onDisconnect = () => ac.abort();
    res.on('close', onDisconnect);
    res.on('error', onDisconnect);
    followers.add(ac);
    // Join the registry's per-session abort set and re-resolve the boundary from
    // the SAME entry, synchronously with no await between: a session transition
    // (activate/freeze) has therefore either already happened (so we read its new
    // boundary here) or has not yet (so it will find us in the set and abort us).
    // A follower is never left pinned to a stale boundary while unregistered.
    registry.addFollower(id, ac);
    const followBoundary = registry.get(id)?.boundary ?? boundary;
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();

    // Serialize every write (events and heartbeats) through the bounded path so
    // an idle client that stops reading eventually hits DRAIN_DEADLINE_MS and
    // is aborted, and so heartbeats never interleave with an in-flight event write.
    let tail: Promise<void> = Promise.resolve();
    const write = (chunk: string): Promise<void> => {
      tail = tail.then(() => writeBackpressured(res, chunk, ac.signal));
      return tail;
    };

    let cursor: LogCursor | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      // `closing` guards the connect-during-shutdown race: the add→guard span
      // below has no await, so a `closing` flag set in close() before its abort
      // loop is always visible here, and this request tears down via finally
      // instead of blocking server.close() forever in waitForAdvance.
      if (closing || ac.signal.aborted || res.destroyed) return;
      cursor = await openLogCursor(logPath, effectiveAfter);
      if (ac.signal.aborted || res.destroyed) return;
      heartbeat = setInterval(() => { write(': heartbeat\n\n').catch(() => ac.abort()); }, SSE_HEARTBEAT_MS);
      let cur = effectiveAfter;
      for (;;) {
        const target = followBoundary.current();
        if (target > cur) {
          while (cur < target) {
            if (ac.signal.aborted) return;
            const batch = await cursor.readThrough(target);
            // A nonempty short batch is normal; an empty batch below H is not.
            if (!batch.length) throw new LogCorruptError('disk short of durable boundary');
            for (const ev of batch) {
              await write(`id: ${ev.seq}\nevent: slipstream\ndata: ${ev.raw}\n\n`);
              cur = ev.seq;
            }
          }
        }
        await followBoundary.waitForAdvance(cur, ac.signal); // rejects on abort → exits loop
      }
    } catch (err) {
      // Corruption must not be silent (honesty). An abort/drain-timeout stays silent.
      if (err instanceof LogCorruptError) console.error('slipstream reader: corruption in SSE follow', err);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (cursor) await cursor.close();
      followers.delete(ac);
      registry.removeFollower(id, ac);
      if (!res.writableEnded) res.destroy();
    }
  }

  return {
    url, port, token, descriptorPath,
    close: async () => {
      closing = true;
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
