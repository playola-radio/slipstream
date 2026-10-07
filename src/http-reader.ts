import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { access, open, unlink, type FileHandle } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Health } from './health.ts';
import {
  listSessions, readTombstone, isValidSessionId, sessionLogPath, onDiskHighWater,
  blobPath, isValidHex, schemaBytes, projectionSchemaBytes,
} from './store-reader.ts';
import { checkAuth, checkHostOrigin, generateToken, publishDescriptor } from './http-security.ts';
import { parseCursor, openLogCursor, LogCorruptError, type LogCursor } from './log-reader.ts';
import { parseClipSnapshot } from './clip-blob-reader.ts';
import { createClipProjectionService, type ClipServiceOptions } from './clip-projection-service.ts';
import { languageForPath } from './clip-language.ts';
import { liveBoundary, staticBoundary, type BoundarySource } from './reader-runtime.ts';
import { createBoundaryRegistry, type BoundaryRegistry } from './boundary-registry.ts';
import { DISPLAY_FOLD_CONTRACT } from './display-fold.ts';
import { createProjectionAdmission, PROVISIONAL_SHARED_ADMISSION, type AdmissionConfig } from './projection-admission.ts';
import { createInterfaceService, type InterfaceServiceOptions } from './interface-service.ts';
import { emitProjectionPhase, type ProjectionTraceObserver } from './projection-trace.ts';

export interface ActiveSession { id: string; health: Health; logPath: string }
export interface ReaderServerOptions {
  storeDir: string;
  /** Test seam only; the daemon uses the provisional D7 values. */
  projectionAdmissionConfig?: AdmissionConfig;
  /** Test-only, synchronous and nonreentrant observer; unset by the daemon. */
  projectionTrace?: ProjectionTraceObserver;
  /** Test seam for measuring interface deadlines without relaxing clip's D. */
  interfaceDeadlineMs?: number;
  /** Test seam for deterministic contract budget fixtures. */
  interfaceLimits?: Pick<InterfaceServiceOptions, 'fileResultBytes' | 'metadataBytes'>;
  /** Test seam for an isolated Swift host failure. */
  interfaceExtractSwift?: InterfaceServiceOptions['extractSwift'];
  /** Test seam for interruption after a recorded content-retention probe. */
  interfaceOnRetentionCheck?: InterfaceServiceOptions['onRetentionCheck'];
  /** Test-only delay after clip admission; unset in normal daemon operation. */
  clipDispatchBarrier?: ClipServiceOptions['dispatchBarrier'];
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
// The display-rules version every successful /events reply is interpreted under
// (DA-2). Sourced from the single contract constant, never a second literal.
const FOLD_CONTRACT_HEADER = 'slipstream-fold-contract';

const SSE_HEARTBEAT_MS = 15000;
const DRAIN_DEADLINE_MS = 10000;

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string,string> = {},
  onFinish?: () => void) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  if (onFinish) res.end(body, onFinish); else res.end(body);
}
function sendJson(res: ServerResponse, status: number, value: unknown,
  trace?: { observer: ProjectionTraceObserver; routeKey: string; scope: 'clip' | 'interface' }) {
  const startedAtNs = trace ? process.hrtime.bigint() : undefined;
  const body = JSON.stringify(value);
  if (trace) emitProjectionPhase(trace.observer, 'serialization', startedAtNs,
    { scope: trace.scope, routeKey: trace.routeKey });
  const writeStartedAtNs = trace ? process.hrtime.bigint() : undefined;
  send(res, status, body, { 'content-type': 'application/json; charset=utf-8' }, trace
    ? () => emitProjectionPhase(trace.observer, 'http-completion', writeStartedAtNs,
      { scope: trace.scope, routeKey: trace.routeKey }) : undefined);
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

  // The clip projection is computed on demand from the immutable blobs and cached
  // disposably (no log, no persistence). The service owns the worker pool + bounded
  // admission so a burst of cold-cache requests cannot starve capture; the server
  // closes it on shutdown.
  const admission = createProjectionAdmission(opts.projectionAdmissionConfig ?? PROVISIONAL_SHARED_ADMISSION,
    opts.projectionTrace);
  const clipService = createClipProjectionService({ storeDir: opts.storeDir, admission,
    projectionTrace: opts.projectionTrace, dispatchBarrier: opts.clipDispatchBarrier });
  const interfaceService = createInterfaceService({ storeDir: opts.storeDir, admission,
    ...opts.interfaceLimits, extractSwift: opts.interfaceExtractSwift,
    onRetentionCheck: opts.interfaceOnRetentionCheck,
    admissionDeadlineMs: opts.interfaceDeadlineMs, projectionTrace: opts.projectionTrace });

  const server = createServer((req, res) => { void handle(req, res).catch((err) => {
    console.error('slipstream reader: request failed', err);
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }); });

  // Bind loopback only; a non-loopback bind must be impossible, not configurable.
  // Reject the returned promise on a listen error (e.g. EADDRINUSE) rather than
  // letting it crash the process with no handler.
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    // Do not leak the clip worker if the listener never bound.
    await admission.close();
    await Promise.all([clipService.close(), interfaceService.close()]);
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  const hostPort = `127.0.0.1:${port}`;
  const url = `http://${hostPort}`;
  let descriptorPath: string;
  try {
    descriptorPath = await publishDescriptor(opts.storeDir, { url, token });
  } catch (err) {
    // Do not leak the listener or the clip worker if we cannot publish.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await admission.close();
    await Promise.all([clipService.close(), interfaceService.close()]);
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
        // A removed session advertises no history: report durable_seq 0 regardless
        // of any stale registry entry (a prior detach left one frozen at its final
        // seq, and a delete does not clear it). Otherwise trust the registry over
        // disk for every session it knows (see the reserved/active-window note).
        const runtime = registry.get(s.id);
        const durableSeq = s.removed ? 0n : (runtime ? runtime.boundary.current() : s.durableSeq);
        // Readiness is a property of a live capture only: a retained or removed
        // session has no agent connection, whatever its log last recorded.
        const agent = s.removed ? undefined : runtime?.agentConnection;
        const agentConnection = agent === undefined ? { state: 'disconnected', reason: 'capture_not_live' }
          : agent === 'none' ? { state: 'disconnected', reason: 'no_agent' } : { state: agent };
        return { id: s.id, durable_seq: durableSeq.toString(), removed: s.removed, agent_connection: agentConnection };
      }));
      return;
    }
    const eventsMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      await handleEvents(req, res, decodeURIComponent(eventsMatch[1]!), searchParams);
      return;
    }
    const clipsMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/changes\/([0-9]+)\/clips$/);
    if (clipsMatch) {
      await handleClips(res, decodeURIComponent(clipsMatch[1]!), clipsMatch[2]!,
        opts.projectionTrace ? req.url : undefined);
      return;
    }
    const interfacesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/interfaces$/);
    if (interfacesMatch) {
      let id: string;
      try { id = decodeURIComponent(interfacesMatch[1]!); }
      catch { send(res, 400, 'invalid session id'); return; }
      await handleInterfaces(req, res, id, searchParams);
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

    const projectionSchemaMatch = pathname.match(/^\/v1\/schemas\/projections\/([^/]+)$/);
    if (projectionSchemaMatch) {
      let version: string;
      try { version = decodeURIComponent(projectionSchemaMatch[1]!); }
      catch { send(res, 400, 'invalid version'); return; }
      const bytes = await projectionSchemaBytes(version);
      if (!bytes) { send(res, 404, 'not found'); return; }
      send(res, 200, bytes, { 'content-type': 'application/json; charset=utf-8' });
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

  async function handleClips(res: ServerResponse, id: string, seqStr: string,
    traceRouteKey?: string): Promise<void> {
    if (!isValidSessionId(id)) { send(res, 404, 'not found'); return; }
    if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
    const logPath = sessionLogPath(opts.storeDir, id);
    try { await access(logPath); } catch {
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      send(res, 404, 'not found'); return;
    }

    // Reject a non-canonical seq (leading zeros): the route regex admits "01",
    // but that resolves via BigInt to change 1 and would then be stamped verbatim
    // into `change_seq`, violating the published `^[1-9][0-9]*$` pattern.
    if (!/^[1-9][0-9]*$/.test(seqStr)) { send(res, 404, 'not found'); return; }

    // The change must be within the durable high-water; a seq at or beyond it names
    // no committed change (the same boundary the events feed serves).
    const seq = BigInt(seqStr);
    const H = (await boundaryFor(id)).current();
    if (seq < 1n || seq > H) {
      // A delete racing this request can publish the tombstone and freeze the
      // boundary to 0 after the tombstone check above but before this read: any
      // positive seq then looks "beyond" H. That is removal, not an unknown
      // change: 410 if the marker is now durable, else the genuine 404.
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      send(res, 404, 'not found'); return;
    }

    // Read exactly the record at `seq`. openLogCursor positions after seq-1 and
    // readThrough(seq) yields that single event; corruption in the scanned prefix
    // throws LogCorruptError and surfaces as a clean 500 (never a faked projection).
    let ev;
    let cursor: LogCursor | undefined;
    try {
      cursor = await openLogCursor(logPath, seq - 1n);
      const batch = await cursor.readThrough(seq);
      ev = batch.find((e) => e.seq === seq);
    } finally {
      await cursor?.close();
    }
    // A seq within the durable boundary MUST have a record; its absence means the
    // log is short of its declared high-water — corruption, not an unknown change.
    // Reserve 404 for an existing record that simply isn't a file.changed event.
    if (!ev) throw new LogCorruptError('record missing within durable boundary');
    if (ev.type !== 'slipstream.file.changed.v1') { send(res, 404, 'not found'); return; }

    const before = parseClipSnapshot(ev.data.before);
    const after = parseClipSnapshot(ev.data.after);
    const path = ev.data.path;
    if (!before || !after || typeof path !== 'string') {
      throw new LogCorruptError('file.changed record missing a path or before/after snapshot');
    }

    // The projection itself carries availability: GC'd blobs yield an `unavailable`
    // status with a reason, served as a normal 200. The HTTP status reports whether
    // the request succeeded, not whether the content is still retained.
    const projection = await clipService.get({ changeSeq: seqStr, before, after,
      language: languageForPath(path), traceRouteKey });
    sendJson(res, 200, projection, opts.projectionTrace && traceRouteKey
      ? { observer: opts.projectionTrace, routeKey: traceRouteKey, scope: 'clip' } : undefined);
  }

  async function handleInterfaces(req: IncomingMessage, res: ServerResponse, id: string,
    params: URLSearchParams): Promise<void> {
    if (!isValidSessionId(id)) { send(res, 404, 'not found'); return; }
    if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
    const logPath = sessionLogPath(opts.storeDir, id);
    try { await access(logPath); } catch {
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      send(res, 404, 'not found'); return;
    }
    const allowed = new Set(['before_seq', 'after_seq', 'limit', 'path_prefix', 'after_path', 'include_identical']);
    const values = new Map<string, string>();
    for (const [key, value] of params) {
      if (!allowed.has(key) || values.has(key)) { send(res, 400, 'invalid request'); return; }
      values.set(key, value);
    }
    const beforeText = values.get('before_seq');
    const afterText = values.get('after_seq');
    if (beforeText === undefined || afterText === undefined || !/^(0|[1-9][0-9]*)$/.test(beforeText)
      || !/^(0|[1-9][0-9]*)$/.test(afterText)) { send(res, 400, 'invalid cutoffs'); return; }
    const beforeSeq = BigInt(beforeText), afterSeq = BigInt(afterText);
    const limitText = values.get('limit') ?? '16';
    const limit = Number(limitText);
    const prefix = values.get('path_prefix') ?? '';
    const identical = values.get('include_identical');
    if (beforeSeq > afterSeq || !/^[1-9][0-9]*$/.test(limitText) || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 16 || prefix.startsWith('/') || prefix.includes('\0')
      || prefix.split('/').includes('..') || (identical !== undefined && identical !== 'true')) {
      send(res, 400, 'invalid request'); return;
    }
    const H = (await boundaryFor(id)).current();
    if (afterSeq > H) {
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      send(res, 409, 'cursor beyond durable high-water', { [DURABLE_SEQ_HEADER]: H.toString() });
      return;
    }
    const abort = new AbortController();
    const onDisconnect = () => abort.abort();
    res.on('close', onDisconnect);
    res.on('error', onDisconnect);
    try {
      const page = await interfaceService.get({ sessionId: id, logPath, durableSeq: H,
        beforeSeq, afterSeq, pathPrefix: prefix, afterPath: values.get('after_path') ?? null,
        includeIdentical: identical === 'true', limit, signal: abort.signal,
        traceRouteKey: opts.projectionTrace ? req.url : undefined });
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      if (!res.destroyed) sendJson(res, 200, page, opts.projectionTrace && req.url
        ? { observer: opts.projectionTrace, routeKey: req.url, scope: 'interface' } : undefined);
    } catch (error) {
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      throw error;
    } finally {
      res.off('close', onDisconnect);
      res.off('error', onDisconnect);
    }
  }

  async function handleEvents(
    req: IncomingMessage, res: ServerResponse, id: string, params: URLSearchParams,
  ): Promise<void> {
    if (!isValidSessionId(id)) { send(res, 404, 'not found'); return; }
    if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
    const logPath = sessionLogPath(opts.storeDir, id);
    try { await access(logPath); } catch {
      // A delete that removed the history after the tombstone check above still owes
      // this request a 410, not a 404: re-check the marker before reporting missing.
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
      send(res, 404, 'not found'); return;
    }

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
      // A delete that froze this session's boundary to 0 makes any positive cursor
      // look "beyond" it. That is removal, not a stale cursor: 410 if the marker is
      // now durable, else the genuine 409.
      if (await readTombstone(opts.storeDir, id)) { send(res, 410, 'gone'); return; }
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
          [FOLD_CONTRACT_HEADER]: DISPLAY_FOLD_CONTRACT,
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
    // A retained session (known only from disk) has no registry entry, so a delete's
    // freeze(id, 0n) would have nothing to abort. Install a static entry first so
    // the follower we are about to register is reachable by that freeze.
    registry.installIfAbsent(id, boundary);
    // Join the registry's per-session abort set and re-resolve the boundary from
    // the SAME entry, synchronously with no await between: a session transition
    // (activate/freeze) has therefore either already happened (so we read its new
    // boundary here) or has not yet (so it will find us in the set and abort us).
    // A follower is never left pinned to a stale boundary while unregistered.
    registry.addFollower(id, ac);
    const followBoundary = registry.get(id)?.boundary ?? boundary;
    // Final tombstone re-check, AFTER registration: a delete that raced this follower
    // either aborted it via the freeze above (ac now aborted) or made the tombstone
    // durable before we registered (readTombstone sees it). Either way, 410 before
    // any 200 headers rather than streaming a log that is being deleted. An
    // already-started stream cannot be turned into a 410; the client reconnects and
    // this top-of-handler check (or line 191) then 410s it.
    const removedNow = await readTombstone(opts.storeDir, id);
    if (removedNow || ac.signal.aborted) {
      followers.delete(ac);
      registry.removeFollower(id, ac);
      res.off('close', onDisconnect);
      res.off('error', onDisconnect);
      // This recheck runs before writeHead(200), so headers are never sent yet: a
      // durable tombstone becomes a clean 410; a bare abort just tears the socket.
      if (removedNow) send(res, 410, 'gone');
      else res.destroy();
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream; charset=utf-8',
      [FOLD_CONTRACT_HEADER]: DISPLAY_FOLD_CONTRACT,
    });
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
      await admission.close();
      await Promise.all([clipService.close(), interfaceService.close()]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Remove the descriptor this server published; a dead reader must not leave
      // a stale pointer behind. ENOENT (already gone) is fine.
      await unlink(descriptorPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
    },
  };
}
