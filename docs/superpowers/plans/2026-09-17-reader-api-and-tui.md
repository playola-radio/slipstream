# Reader API + disk-reading TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public `/v1` HTTP reader over the on-disk event log + CAS blobs, plus a minimal disk-reading TUI client that consumes only public artifacts.

**Architecture:** One sequential read over the on-disk `events.jsonl` at a single byte cursor serves both replay and follow, bounded by the authoritative in-process durable sequence (never physical EOF). A daemon-internal runtime adapts capture's durable boundary + a coalesced post-durability wakeup into race-free waits; the reader re-reads disk on each wakeup so the one byte cursor stays the single data source. The reader never mutates capture events. Loopback-only `node:http` with bearer auth + exact Host/Origin enforcement.

**Tech Stack:** TypeScript on Node 24 (native TS, ESM, no build step). Node built-ins only: `node:http`, `node:crypto`, `node:fs`/`fs/promises`. Tests: `node:test` + `node:assert/strict`. No HTTP framework, no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-17-reader-api-and-tui-design.md`

## Global Constraints

- **No new dependency, no HTTP framework.** Node built-ins only. If a built-in seems insufficient, STOP and ask.
- **The on-disk JSONL log + CAS blobs are the source of truth; the reader is a thin view.** No privileged back channel between daemon and client. `reader-runtime.ts` is daemon-internal and supplies boundaries/wakeups only, never event payloads to clients.
- **Serve only durably-flushed events.** The boundary is the in-process durable sequence (`Health.snapshot().durable_seq` / `Log.durableSeq()`), never physical EOF. Never emit an unterminated line. Never retain bytes beyond the boundary across a wakeup.
- **Honesty:** never a fake empty blob (a genuine zero-byte blob is an honest empty 200; a missing blob is 404). The reader never creates or mutates a capture event and never presents gaps/attribution as more certain.
- **A cursor is never silently reset.** `after` beyond durable high-water → 409 with `Slipstream-Durable-Seq`.
- **Owner-only storage perms preserved** (`DIR_MODE = 0o700`, `FILE_MODE = 0o600`, `assertOwnerOnly`).
- **Sequences are BigInt.** Never `Number` — cursors can exceed `Number.MAX_SAFE_INTEGER`.
- **Process:** TDD (test first, watch it fail, minimal impl, pass, commit). `npm run typecheck` + `npm test` green before every commit. Deterministic tests are `src/*.test.ts`; anything needing real FSEvents/timing is `src/*.os.test.ts`. Serial test concurrency (already configured). No `--no-verify`. No `Co-Authored-By` trailers. Branch off `develop`. Never commit `.slipstream/`, `sessions/`, `blobs/`, `*.jsonl`.
- **Reuse existing helpers** from `src/storage.ts` (`assertOwnerOnly`, `mkdirpDurable`, `writeAll`, `fsyncDir`, `StorageError`, `DIR_MODE`, `FILE_MODE`), `src/event.ts` (`EVENT_TYPES`, `CloudEvent`), `src/test/helpers.ts` (`withTempDir`, `withCas`, `withFakeSession`, `waitForRecords`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/store-reader.ts` (new) | Read-only storage layout: `listSessions`, path builders, tombstone read, schema-bytes allowlist, runtime-descriptor read. Types `SessionInfo`, `Tombstone`, `RuntimeDescriptor`. |
| `src/log-reader.ts` (new) | Cursor parsing, strict JSONL line parse, forward-compatible `ReaderEvent` envelope, stateful `openLogCursor` bounded by a durable seq. |
| `src/health.ts` (modify) | Add additive `subscribe(listener)` fired on `setDurableSeq` (post-durability wakeup source). No behavior change to existing methods. |
| `src/reader-runtime.ts` (new) | `BoundarySource`: live (health-backed) + static (fixed high-water). Race-free `waitForAdvance`. Daemon-internal. |
| `src/http-security.ts` (new) | `generateToken`, `publishDescriptor` (atomic owner-only), `checkAuth` (timing-safe), `checkHostOrigin`. |
| `src/http-reader.ts` (new) | `node:http` server, routing, status mapping, NDJSON + SSE framing, backpressure/lifecycle. |
| `src/tui.ts` (new) | Client: HTTP/SSE mode (default) + `--disk` finite mode. Rendering. |
| `src/cli.ts` (modify) | Add `serve` (capture + reader) and `view` (TUI) subcommands. Leave `watch` untouched. |
| `IMPLEMENTATION_PLAN.md` (modify) | Update Stage 2 Status line at the end. |

Note: `src/reader.ts` is the source-file snapshot reader — do NOT touch or reuse it; the name collision is intentional and stays distinct.

---

### Task 1: `store-reader.ts` — read-only layout, discovery, tombstone, schema bytes, descriptor

**Files:**
- Create: `src/store-reader.ts`
- Test: `src/store-reader.test.ts`

**Interfaces:**
- Consumes: `EVENT_TYPES` from `src/event.ts`; `assertOwnerOnly` from `src/storage.ts`.
- Produces:
  - `interface SessionInfo { id: string; durableSeq: bigint; removed: boolean }`
  - `interface Tombstone { version: number }`
  - `interface RuntimeDescriptor { url: string; token: string }`
  - `function sessionsDir(storeDir: string): string`
  - `function sessionLogPath(storeDir: string, id: string): string`
  - `function tombstonePath(storeDir: string, id: string): string`
  - `function blobPath(storeDir: string, hex: string): string`
  - `function listSessions(storeDir: string): Promise<SessionInfo[]>`
  - `function readTombstone(storeDir: string, id: string): Promise<Tombstone | null>`
  - `function isValidSessionId(id: string): boolean` (UUID v4 shape; rejects traversal)
  - `function isValidHex(hex: string): boolean` (`^[0-9a-f]{64}$`)
  - `function schemaBytes(type: string): Promise<Buffer | null>` (allowlist = `EVENT_TYPES`; null if unknown type)
  - `function onDiskHighWater(logPath: string): Promise<bigint>` (highest seq of the last complete line; `0n` if none)
  - `function readRuntimeDescriptor(storeDir: string): Promise<RuntimeDescriptor | null>` (reads the most recent `runtime/*.json`)

- [ ] **Step 1: Write the failing test**

```ts
// src/store-reader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessions, readTombstone, isValidSessionId, isValidHex,
  schemaBytes, onDiskHighWater, blobPath, sessionLogPath,
} from './store-reader.ts';

const UUID = '11111111-1111-4111-8111-111111111111';

async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-store-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  return dir;
}

describe('store-reader', () => {
  describe('isValidSessionId', () => {
    it('accepts a v4 uuid and rejects traversal', () => {
      assert.equal(isValidSessionId(UUID), true);
      assert.equal(isValidSessionId('../etc'), false);
      assert.equal(isValidSessionId('foo/bar'), false);
    });
  });

  describe('isValidHex', () => {
    it('accepts lowercase 64-hex and rejects uppercase or wrong length', () => {
      assert.equal(isValidHex('a'.repeat(64)), true);
      assert.equal(isValidHex('A'.repeat(64)), false);
      assert.equal(isValidHex('a'.repeat(63)), false);
    });
  });

  describe('onDiskHighWater', () => {
    it('returns the seq of the last complete line and ignores a torn trailing line', async () => {
      const dir = await store();
      const log = sessionLogPath(dir, UUID);
      await writeFile(log, '{"seq":"1"}\n{"seq":"2"}\n{"seq":"3"', 'utf8');
      assert.equal(await onDiskHighWater(log), 2n);
    });
    it('returns 0n for an empty or missing log', async () => {
      const dir = await store();
      assert.equal(await onDiskHighWater(sessionLogPath(dir, UUID)), 0n);
    });
  });

  describe('listSessions', () => {
    it('lists session ids with on-disk high-water and removed=false', async () => {
      const dir = await store();
      await writeFile(sessionLogPath(dir, UUID), '{"seq":"1"}\n{"seq":"2"}\n', 'utf8');
      const sessions = await listSessions(dir);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, UUID);
      assert.equal(sessions[0].durableSeq, 2n);
      assert.equal(sessions[0].removed, false);
    });
    it('marks a tombstoned session removed', async () => {
      const dir = await store();
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      const sessions = await listSessions(dir);
      assert.equal(sessions[0].removed, true);
    });
  });

  describe('readTombstone', () => {
    it('returns null when absent and the parsed marker when present', async () => {
      const dir = await store();
      assert.equal(await readTombstone(dir, UUID), null);
      await writeFile(join(dir, 'sessions', UUID, 'removed.json'), '{"version":1}', 'utf8');
      assert.deepEqual(await readTombstone(dir, UUID), { version: 1 });
    });
  });

  describe('schemaBytes', () => {
    it('returns bytes for a known type and null for an unknown type', async () => {
      const known = await schemaBytes('slipstream.file.changed.v1');
      assert.ok(known && known.length > 0);
      assert.equal(await schemaBytes('nope.v1'), null);
      assert.equal(await schemaBytes('../secret'), null);
    });
  });

  describe('blobPath', () => {
    it('builds the sharded CAS path under the store', () => {
      const hex = 'ab' + '0'.repeat(62);
      assert.equal(blobPath('/s', hex), join('/s', 'blobs', 'sha256', 'ab', hex));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/store-reader.test.ts`
Expected: FAIL — `Cannot find module './store-reader.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/store-reader.ts
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES } from './event.ts';

export interface SessionInfo { id: string; durableSeq: bigint; removed: boolean }
export interface Tombstone { version: number }
export interface RuntimeDescriptor { url: string; token: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));

export function isValidSessionId(id: string): boolean { return UUID_RE.test(id); }
export function isValidHex(hex: string): boolean { return HEX_RE.test(hex); }

export function sessionsDir(storeDir: string): string { return join(storeDir, 'sessions'); }
export function sessionLogPath(storeDir: string, id: string): string {
  return join(sessionsDir(storeDir), id, 'events.jsonl');
}
export function tombstonePath(storeDir: string, id: string): string {
  return join(sessionsDir(storeDir), id, 'removed.json');
}
export function blobPath(storeDir: string, hex: string): string {
  return join(storeDir, 'blobs', 'sha256', hex.slice(0, 2), hex);
}

export async function onDiskHighWater(logPath: string): Promise<bigint> {
  let text: string;
  try { text = await readFile(logPath, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
    throw err;
  }
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return 0n;
  const complete = text.slice(0, lastNl);
  const nl = complete.lastIndexOf('\n');
  const lastLine = complete.slice(nl + 1);
  if (!lastLine) return 0n;
  const seq = (JSON.parse(lastLine) as { seq?: string }).seq;
  return seq ? BigInt(seq) : 0n;
}

export async function readTombstone(storeDir: string, id: string): Promise<Tombstone | null> {
  try {
    const raw = await readFile(tombstonePath(storeDir, id), 'utf8');
    const parsed = JSON.parse(raw) as Tombstone;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listSessions(storeDir: string): Promise<SessionInfo[]> {
  let entries: string[];
  try { entries = await readdir(sessionsDir(storeDir)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SessionInfo[] = [];
  for (const id of entries) {
    if (!isValidSessionId(id)) continue;
    const removed = (await readTombstone(storeDir, id)) !== null;
    const durableSeq = await onDiskHighWater(sessionLogPath(storeDir, id));
    out.push({ id, durableSeq, removed });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export async function schemaBytes(type: string): Promise<Buffer | null> {
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return null;
  return readFile(join(SCHEMAS_DIR, `${type}.json`));
}

export async function readRuntimeDescriptor(storeDir: string): Promise<RuntimeDescriptor | null> {
  const dir = join(storeDir, 'runtime');
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (files.length === 0) return null;
  let newest = files[0]; let newestMs = -1;
  for (const f of files) {
    const s = await stat(join(dir, f));
    if (s.mtimeMs > newestMs) { newestMs = s.mtimeMs; newest = f; }
  }
  return JSON.parse(await readFile(join(dir, newest), 'utf8')) as RuntimeDescriptor;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/store-reader.test.ts` → Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/store-reader.ts src/store-reader.test.ts
git commit -m "feature: read-only store layout, session discovery, tombstone, schema bytes"
```

---

### Task 2: `log-reader.ts` — cursor parsing, strict line parse, bounded stateful cursor

**Files:**
- Create: `src/log-reader.ts`
- Test: `src/log-reader.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure).
- Produces:
  - `interface ReaderEvent { seq: bigint; type: string; raw: string; data: Record<string, unknown> }`
  - `class LogCorruptError extends Error {}`
  - `function parseCursor(raw: string | undefined): bigint | null` (null → caller returns 400; missing → `0n`)
  - `function parseLine(line: string): ReaderEvent` (throws `LogCorruptError` on a complete-but-invalid line; unknown `type` is accepted)
  - `interface LogCursor { readThrough(boundary: bigint): Promise<ReaderEvent[]>; close(): Promise<void> }`
  - `function openLogCursor(logPath: string, after: bigint): Promise<LogCursor>`

`openLogCursor` reads the file incrementally from a retained byte offset. On each `readThrough(boundary)`: read new bytes from the retained offset, split on `\n`, parse each **complete** line, emit those with `after < seq <= boundary`, and STOP at the first line with `seq > boundary` — advancing the retained offset only past the last emitted line, dropping any read-ahead buffer (so bytes beyond the boundary are re-read after it advances, never retained). A trailing line with no `\n` is never emitted. Lines with `seq <= after` before the cursor is positioned are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// src/log-reader.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCursor, parseLine, openLogCursor, LogCorruptError } from './log-reader.ts';

const line = (seq: number, type = 'slipstream.file.changed.v1', extra = {}) =>
  JSON.stringify({ specversion: '1.0', id: String(seq), source: 'urn:slipstream:session:x',
    type, datacontenttype: 'application/json', seq: String(seq),
    time: '2026-01-01T00:00:00.000Z', data: { session_id: 'x', ...extra } }) + '\n';

async function logWith(...lines: string[]): Promise<string> {
  const p = join(await mkdtemp(join(tmpdir(), 'slip-log-')), 'events.jsonl');
  await writeFile(p, lines.join(''), 'utf8');
  return p;
}

describe('log-reader', () => {
  describe('parseCursor', () => {
    it('treats missing as 0n, parses decimals, rejects junk', () => {
      assert.equal(parseCursor(undefined), 0n);
      assert.equal(parseCursor('0'), 0n);
      assert.equal(parseCursor('42'), 42n);
      assert.equal(parseCursor('9007199254740993'), 9007199254740993n);
      assert.equal(parseCursor('-1'), null);
      assert.equal(parseCursor('01'), null);
      assert.equal(parseCursor('x'), null);
    });
  });

  describe('parseLine', () => {
    it('accepts an unknown event type but throws on invalid json', () => {
      const ev = parseLine(line(5, 'some.future.type.v9').trimEnd());
      assert.equal(ev.seq, 5n);
      assert.equal(ev.type, 'some.future.type.v9');
      assert.throws(() => parseLine('{not json'), LogCorruptError);
    });
  });

  describe('openLogCursor', () => {
    it('emits only (after, boundary] and never an unterminated trailing line', async () => {
      const p = await logWith(line(1), line(2), line(3));
      await appendFile(p, '{"seq":"4"'); // torn tail, no newline
      const cur = await openLogCursor(p, 1n);
      const first = await cur.readThrough(2n);
      assert.deepEqual(first.map((e) => e.seq), [2n]);
      const second = await cur.readThrough(3n);
      assert.deepEqual(second.map((e) => e.seq), [3n]); // 4 is torn -> never emitted
      await cur.close();
    });

    it('does not emit lines beyond the boundary even if present on disk', async () => {
      const p = await logWith(line(1), line(2), line(3));
      const cur = await openLogCursor(p, 0n);
      assert.deepEqual((await cur.readThrough(1n)).map((e) => e.seq), [1n]);
      assert.deepEqual((await cur.readThrough(3n)).map((e) => e.seq), [2n, 3n]);
      await cur.close();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/log-reader.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/log-reader.ts
import { open, type FileHandle } from 'node:fs/promises';

export interface ReaderEvent { seq: bigint; type: string; raw: string; data: Record<string, unknown> }
export class LogCorruptError extends Error {}

const CURSOR_RE = /^(0|[1-9][0-9]*)$/;
const SEQ_RE = /^[1-9][0-9]*$/;

export function parseCursor(raw: string | undefined): bigint | null {
  if (raw === undefined) return 0n;
  if (!CURSOR_RE.test(raw)) return null;
  return BigInt(raw);
}

export function parseLine(line: string): ReaderEvent {
  let obj: unknown;
  try { obj = JSON.parse(line); }
  catch { throw new LogCorruptError(`invalid JSON: ${line.slice(0, 80)}`); }
  if (typeof obj !== 'object' || obj === null) throw new LogCorruptError('line is not an object');
  const rec = obj as Record<string, unknown>;
  const seq = rec.seq; const type = rec.type; const data = rec.data;
  if (typeof seq !== 'string' || !SEQ_RE.test(seq)) throw new LogCorruptError('bad seq');
  if (typeof type !== 'string') throw new LogCorruptError('bad type');
  if (typeof data !== 'object' || data === null) throw new LogCorruptError('bad data');
  return { seq: BigInt(seq), type, raw: line, data: data as Record<string, unknown> };
}

export interface LogCursor {
  readThrough(boundary: bigint): Promise<ReaderEvent[]>;
  close(): Promise<void>;
}

export async function openLogCursor(logPath: string, after: bigint): Promise<LogCursor> {
  const handle: FileHandle = await open(logPath, 'r');
  let offset = 0;          // byte offset of the next unread byte on disk
  let positioned = after === 0n; // have we skipped past `after` yet?

  async function readNewComplete(): Promise<{ lines: string[]; consumed: number }> {
    const chunkSize = 64 * 1024;
    const buf = Buffer.alloc(chunkSize);
    let acc = '';
    let read = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, read);
      if (bytesRead === 0) break;
      acc += buf.toString('utf8', 0, bytesRead);
      read += bytesRead;
      if (bytesRead < chunkSize) break;
    }
    const lastNl = acc.lastIndexOf('\n');
    if (lastNl < 0) return { lines: [], consumed: 0 };
    const complete = acc.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete + '\n', 'utf8');
    return { lines: complete.split('\n'), consumed };
  }

  return {
    async readThrough(boundary: bigint): Promise<ReaderEvent[]> {
      if (boundary <= after) return [];
      const { lines } = await readNewComplete();
      const out: ReaderEvent[] = [];
      let advance = offset;
      for (const line of lines) {
        if (line === '') { advance += 1; continue; } // stray blank line's LF
        const ev = parseLine(line);
        const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
        if (!positioned) {
          if (ev.seq <= after) { advance += lineBytes; continue; }
          positioned = true;
        }
        if (ev.seq > boundary) break;      // stop; do not advance past boundary
        out.push(ev);
        advance += lineBytes;
      }
      offset = advance;
      return out;
    },
    async close() { await handle.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/log-reader.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/log-reader.ts src/log-reader.test.ts
git commit -m "feature: durable-bounded log cursor and strict line/cursor parsing"
```

---

### Task 3: `health.ts` — additive durable-advance subscription

**Files:**
- Modify: `src/health.ts`
- Test: `src/health.test.ts` (add cases; keep existing green)

**Interfaces:**
- Consumes: existing `Health` / `createHealth`.
- Produces (added to `Health`): `subscribe(listener: () => void): () => void` — registers a listener called (synchronously, after the value is set) on every `setDurableSeq`; returns an unsubscribe function. Listeners must be cheap; they must not perform I/O or await inside the callback.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/health.test.ts
import { createHealth } from './health.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('health subscribe', () => {
  it('notifies listeners on setDurableSeq and stops after unsubscribe', () => {
    const h = createHealth();
    let calls = 0;
    const off = h.subscribe(() => { calls += 1; });
    h.setDurableSeq(1n);
    h.setDurableSeq(2n);
    assert.equal(calls, 2);
    off();
    h.setDurableSeq(3n);
    assert.equal(calls, 2);
    assert.equal(h.snapshot().durable_seq, '3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/health.test.ts` → FAIL (`h.subscribe is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `src/health.ts`: add `subscribe` to the `Health` interface and implement in `createHealth`.

```ts
// interface Health { ... add: }
  subscribe(listener: () => void): () => void;
```

```ts
// inside createHealth, maintain a listener set and fire it in setDurableSeq
  const listeners = new Set<() => void>();
  // ... existing state ...
  return {
    // ... existing methods ...
    setDurableSeq(seq: bigint) {
      durableSeq = seq;                 // existing assignment
      for (const l of listeners) l();   // NEW: notify after the value is set
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
```

(Adapt to the file's actual structure; the only behavioral addition is firing listeners after `durableSeq` is assigned.)

- [ ] **Step 4: Run the touched area's full suite**

Run: `node --test src/health.test.ts` → PASS. Then the touched-area regression: `node --test src/health.test.ts src/session.test.ts` and `npm run typecheck`. Expected: all green (change is additive).

- [ ] **Step 5: Commit**

```bash
git add src/health.ts src/health.test.ts
git commit -m "feature: add durable-seq advance subscription to health for the reader wakeup"
```

---

### Task 4: `reader-runtime.ts` — boundary source + race-free wait

**Files:**
- Create: `src/reader-runtime.ts`
- Test: `src/reader-runtime.test.ts`

**Interfaces:**
- Consumes: `Health` from `src/health.ts` (via `.snapshot().durable_seq` + `.subscribe`).
- Produces:
  - `interface BoundarySource { current(): bigint; waitForAdvance(from: bigint, signal: AbortSignal): Promise<void> }`
  - `function liveBoundary(health: Health): BoundarySource` — `current()` reads `BigInt(health.snapshot().durable_seq)`; `waitForAdvance(from, signal)` resolves when `current() > from` (checking immediately, then on each health notification), rejects on abort. Race-free: subscribe first, then re-check `current()`, then await.
  - `function staticBoundary(seq: bigint): BoundarySource` — `current()` returns `seq`; `waitForAdvance` resolves only on abort-reject (a quiescent session never advances).

- [ ] **Step 1: Write the failing test**

```ts
// src/reader-runtime.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from './health.ts';
import { liveBoundary, staticBoundary } from './reader-runtime.ts';

describe('reader-runtime', () => {
  describe('liveBoundary', () => {
    it('resolves immediately when already advanced', async () => {
      const h = createHealth(5n);
      const b = liveBoundary(h);
      assert.equal(b.current(), 5n);
      await b.waitForAdvance(4n, new AbortController().signal); // returns
    });

    it('resolves when the boundary advances via a health notification', async () => {
      const h = createHealth(2n);
      const b = liveBoundary(h);
      const waited = b.waitForAdvance(2n, new AbortController().signal);
      queueMicrotask(() => h.setDurableSeq(3n));
      await waited;
      assert.equal(b.current(), 3n);
    });

    it('rejects on abort', async () => {
      const h = createHealth(1n);
      const b = liveBoundary(h);
      const ac = new AbortController();
      const waited = b.waitForAdvance(1n, ac.signal);
      ac.abort();
      await assert.rejects(waited);
    });
  });

  describe('staticBoundary', () => {
    it('reports a fixed seq and only settles on abort', async () => {
      const b = staticBoundary(7n);
      assert.equal(b.current(), 7n);
      const ac = new AbortController(); ac.abort();
      await assert.rejects(b.waitForAdvance(7n, ac.signal));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/reader-runtime.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/reader-runtime.ts
import type { Health } from './health.ts';

export interface BoundarySource {
  current(): bigint;
  waitForAdvance(from: bigint, signal: AbortSignal): Promise<void>;
}

export function liveBoundary(health: Health): BoundarySource {
  const current = () => BigInt(health.snapshot().durable_seq);
  return {
    current,
    waitForAdvance(from, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        let off: (() => void) | undefined;
        const onAbort = () => { cleanup(); reject(new Error('aborted')); };
        const cleanup = () => { off?.(); signal.removeEventListener('abort', onAbort); };
        const check = () => { if (current() > from) { cleanup(); resolve(); } };
        signal.addEventListener('abort', onAbort, { once: true });
        off = health.subscribe(check);
        check(); // race-free: re-check after subscribing
      });
    },
  };
}

export function staticBoundary(seq: bigint): BoundarySource {
  return {
    current: () => seq,
    waitForAdvance(_from, signal) {
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/reader-runtime.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/reader-runtime.ts src/reader-runtime.test.ts
git commit -m "feature: reader boundary source with race-free durable-advance wait"
```

---

### Task 5: `http-security.ts` — token, descriptor publish, auth + host/origin checks

**Files:**
- Create: `src/http-security.ts`
- Test: `src/http-security.test.ts`

**Interfaces:**
- Consumes: `mkdirpDurable`, `writeAll`, `fsyncDir`, `DIR_MODE`, `FILE_MODE` from `src/storage.ts`; `RuntimeDescriptor` type from `src/store-reader.ts`.
- Produces:
  - `function generateToken(): string` (32 random bytes, hex)
  - `function publishDescriptor(storeDir: string, descriptor: RuntimeDescriptor): Promise<string>` (writes `runtime/<uuid>.json` atomically owner-only; returns the file path)
  - `function checkAuth(header: string | undefined, token: string): boolean` (timing-safe bearer compare)
  - `interface HostOriginResult { ok: boolean; status?: 403 }`
  - `function checkHostOrigin(headers: Record<string,string|string[]|undefined>, expectedHostPort: string): boolean` (exact `Host`; if `Origin` present it must equal `http://<expectedHostPort>`; duplicate/foreign/forwarded → false)

- [ ] **Step 1: Write the failing test**

```ts
// src/http-security.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, publishDescriptor, checkAuth, checkHostOrigin } from './http-security.ts';

describe('http-security', () => {
  it('generateToken returns 64 hex chars', () => {
    assert.match(generateToken(), /^[0-9a-f]{64}$/);
  });

  it('publishDescriptor writes an owner-only json under runtime/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slip-sec-'));
    const path = await publishDescriptor(dir, { url: 'http://127.0.0.1:1/', token: 'abc' });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(parsed, { url: 'http://127.0.0.1:1/', token: 'abc' });
    assert.equal((await stat(path)).mode & 0o077, 0);
  });

  it('checkAuth accepts the exact bearer and rejects others', () => {
    assert.equal(checkAuth('Bearer secrettoken', 'secrettoken'), true);
    assert.equal(checkAuth('Bearer wrong', 'secrettoken'), false);
    assert.equal(checkAuth(undefined, 'secrettoken'), false);
    assert.equal(checkAuth('secrettoken', 'secrettoken'), false); // missing Bearer prefix
  });

  it('checkHostOrigin requires exact host and, if present, exact origin', () => {
    const hp = '127.0.0.1:8787';
    assert.equal(checkHostOrigin({ host: hp }, hp), true);
    assert.equal(checkHostOrigin({ host: hp, origin: `http://${hp}` }, hp), true);
    assert.equal(checkHostOrigin({ host: hp, origin: 'http://evil.test' }, hp), false);
    assert.equal(checkHostOrigin({ host: 'evil.test' }, hp), false);
    assert.equal(checkHostOrigin({ host: [hp, hp] as unknown as string }, hp), false);
    assert.equal(checkHostOrigin({}, hp), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/http-security.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http-security.ts
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirpDurable, writeAll, fsyncDir, FILE_MODE } from './storage.ts';
import type { RuntimeDescriptor } from './store-reader.ts';

export function generateToken(): string { return randomBytes(32).toString('hex'); }

export async function publishDescriptor(storeDir: string, descriptor: RuntimeDescriptor): Promise<string> {
  const dir = join(storeDir, 'runtime');
  await mkdirpDurable(dir);
  const path = join(dir, `${randomUUID()}.json`);
  const tmp = `${path}.tmp`;
  const body = Buffer.from(JSON.stringify(descriptor), 'utf8');
  const handle = await open(tmp, 'wx', FILE_MODE);
  try { await writeAll(handle, body); await handle.sync(); }
  finally { await handle.close(); }
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
  await fsyncDir(dir);
  return path;
}

export function checkAuth(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const got = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export function checkHostOrigin(
  headers: Record<string, string | string[] | undefined>,
  expectedHostPort: string,
): boolean {
  const host = headers.host;
  if (typeof host !== 'string' || host !== expectedHostPort) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return origin === `http://${expectedHostPort}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/http-security.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/http-security.ts src/http-security.test.ts
git commit -m "feature: reader auth token, runtime descriptor publish, host/origin checks"
```

---

### Task 6: `http-reader.ts` — server skeleton, auth/origin gate, `GET /v1/sessions`, error mapping

**Files:**
- Create: `src/http-reader.ts`
- Test: `src/http-reader.test.ts`

**Interfaces:**
- Consumes: `listSessions` (store-reader); `checkAuth`, `checkHostOrigin`, `generateToken`, `publishDescriptor` (http-security); `liveBoundary`/`staticBoundary` (reader-runtime, used in later tasks).
- Produces:
  - `interface ActiveSession { id: string; health: Health; logPath: string }`
  - `interface ReaderServerOptions { storeDir: string; active?: ActiveSession; host?: string; port?: number }`
  - `interface ReaderServer { url: string; port: number; token: string; descriptorPath: string; close(): Promise<void> }`
  - `function startReaderServer(opts: ReaderServerOptions): Promise<ReaderServer>`

Server binds `127.0.0.1`, generates a token, publishes the descriptor, and on every request: enforce method GET (`405` + `Allow: GET`), `checkHostOrigin` (`403`), `checkAuth` (`401`), then route. `Cache-Control: no-store` on all responses. Unmatched route → `404`. This task implements only `GET /v1/sessions`; other routes return `404` until later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// src/http-reader.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReaderServer, type ReaderServer } from './http-reader.ts';

const UUID = '22222222-2222-4222-8222-222222222222';

async function storeWithSession(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slip-http-'));
  await mkdir(join(dir, 'sessions', UUID), { recursive: true });
  await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), '{"seq":"1"}\n{"seq":"2"}\n', 'utf8');
  return dir;
}

async function GET(srv: ReaderServer, path: string, headers: Record<string,string> = {}) {
  return fetch(`${srv.url}${path}`, {
    headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}`, ...headers },
  });
}

describe('http-reader core', () => {
  let dir: string; let srv: ReaderServer;
  before(async () => { dir = await storeWithSession(); srv = await startReaderServer({ storeDir: dir }); });
  after(async () => { await srv.close(); });

  it('lists sessions with durable seq and removed flag', async () => {
    const res = await GET(srv, '/v1/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, [{ id: UUID, durable_seq: '2', removed: false }]);
  });

  it('rejects a missing bearer with 401', async () => {
    const res = await fetch(`${srv.url}/v1/sessions`, { headers: { host: `127.0.0.1:${srv.port}` } });
    assert.equal(res.status, 401);
  });

  it('rejects a foreign origin with 403', async () => {
    const res = await GET(srv, '/v1/sessions', { origin: 'http://evil.test' });
    assert.equal(res.status, 403);
  });

  it('rejects a non-GET method with 405 and Allow: GET', async () => {
    const res = await fetch(`${srv.url}/v1/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });

  it('returns 404 for an unknown route', async () => {
    assert.equal((await GET(srv, '/v1/nope')).status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/http-reader.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http-reader.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
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
  const url = `http://${hostPort}/`;
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
    // events / blobs / schemas routes added in later tasks
    send(res, 404, 'not found');
  }

  return {
    url, port, token, descriptorPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/http-reader.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/http-reader.ts src/http-reader.test.ts
git commit -m "feature: reader HTTP server skeleton, auth/origin gate, GET /v1/sessions"
```

---

### Task 7: `GET /v1/sessions/{id}/events` finite NDJSON + 400/404/409/410 + high-water header

**Files:**
- Modify: `src/http-reader.ts`
- Test: `src/http-reader.test.ts` (add cases)

**Interfaces:**
- Consumes: `parseCursor`, `openLogCursor` (log-reader); `readTombstone`, `isValidSessionId`, `sessionLogPath` (store-reader); `liveBoundary`, `staticBoundary` (reader-runtime); `onDiskHighWater` (store-reader).
- Produces: the finite events route inside `http-reader.ts`. Header name constant `DURABLE_SEQ_HEADER = 'slipstream-durable-seq'`.

Boundary resolution for `{id}`: if `active?.id === id` → `liveBoundary(active.health)`; else `staticBoundary(await onDiskHighWater(sessionLogPath(...)))`. Order of checks: valid id shape (else 404) → tombstone (else nothing) → tombstone present → 410 → log exists (else 404) → parse cursor (else 400) → sample `H = boundary.current()` → `after > H` → 409 (+header). Finite: stream `(after, H]` as `application/x-ndjson; charset=utf-8`, one LF per record, header `slipstream-durable-seq: H`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/http-reader.test.ts
describe('http-reader events (finite)', () => {
  let dir: string; let srv: ReaderServer;
  before(async () => { dir = await storeWithSession(); srv = await startReaderServer({ storeDir: dir }); });
  after(async () => { await srv.close(); });

  it('returns (after, H] as ndjson with the durable-seq header', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=0`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    assert.deepEqual(lines.map((l) => JSON.parse(l).seq), ['1', '2']);
  });

  it('returns an empty 200 with the header when caught up', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
    assert.equal((await res.text()), '');
  });

  it('400 on an invalid cursor', async () => {
    assert.equal((await GET(srv, `/v1/sessions/${UUID}/events?after=-1`)).status, 400);
  });

  it('404 on an unknown session', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    assert.equal((await GET(srv, `/v1/sessions/${other}/events?after=0`)).status, 404);
  });

  it('409 when the cursor is beyond the durable high-water, with the header', async () => {
    const res = await GET(srv, `/v1/sessions/${UUID}/events?after=99`);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('slipstream-durable-seq'), '2');
  });

  it('410 for a tombstoned session', async () => {
    const removed = '44444444-4444-4444-8444-444444444444';
    await mkdir(join(dir, 'sessions', removed), { recursive: true });
    await writeFile(join(dir, 'sessions', removed, 'removed.json'), '{"version":1}', 'utf8');
    assert.equal((await GET(srv, `/v1/sessions/${removed}/events?after=0`)).status, 410);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/http-reader.test.ts` → FAIL on the new cases (route returns 404).

- [ ] **Step 3: Write minimal implementation**

Add near the top of `http-reader.ts`:
```ts
import { parseCursor, openLogCursor } from './log-reader.ts';
import { readTombstone, isValidSessionId, sessionLogPath, onDiskHighWater } from './store-reader.ts';
import { liveBoundary, staticBoundary, type BoundarySource } from './reader-runtime.ts';
import { access } from 'node:fs/promises';

export const DURABLE_SEQ_HEADER = 'slipstream-durable-seq';
```

Add a route branch inside `handle`, before the final 404:
```ts
    const eventsMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (eventsMatch) {
      await handleEvents(req, res, decodeURIComponent(eventsMatch[1]), searchParams);
      return;
    }
```

And the handler + boundary helper:
```ts
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

    const raw = params.get('after') ?? undefined;
    const after = parseCursor(raw ?? undefined);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/http-reader.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/http-reader.ts src/http-reader.test.ts
git commit -m "feature: finite NDJSON events endpoint with cursor error codes and high-water header"
```

---

### Task 8: `GET /v1/blobs/sha256/{hex}` + `GET /v1/schemas/{type}`

**Files:**
- Modify: `src/http-reader.ts`
- Test: `src/http-reader.test.ts` (add cases)

**Interfaces:**
- Consumes: `blobPath`, `isValidHex`, `schemaBytes` (store-reader). Streams the blob with `fs.createReadStream` for backpressure.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/http-reader.test.ts
import { createCas } from './cas.ts';

describe('http-reader blobs + schemas', () => {
  let dir: string; let srv: ReaderServer; let hex: string; let empty: string;
  before(async () => {
    dir = await storeWithSession();
    const cas = await createCas(join(dir, 'blobs'));
    hex = (await cas.put(Buffer.from('hello'))).sha256;
    empty = (await cas.put(Buffer.alloc(0))).sha256;
    srv = await startReaderServer({ storeDir: dir });
  });
  after(async () => { await srv.close(); });

  it('serves blob bytes as octet-stream', async () => {
    const res = await GET(srv, `/v1/blobs/sha256/${hex}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'hello');
  });

  it('serves a genuine zero-byte blob as an empty 200', async () => {
    const res = await GET(srv, `/v1/blobs/sha256/${empty}`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  it('400 on malformed hex, 404 on a missing blob', async () => {
    assert.equal((await GET(srv, '/v1/blobs/sha256/ZZZ')).status, 400);
    assert.equal((await GET(srv, `/v1/blobs/sha256/${'a'.repeat(64)}`)).status, 404);
  });

  it('serves a known schema verbatim and 404 on an unknown type', async () => {
    const res = await GET(srv, '/v1/schemas/slipstream.file.changed.v1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type.const, 'slipstream.file.changed.v1');
    assert.equal((await GET(srv, '/v1/schemas/nope.v1')).status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/http-reader.test.ts` → FAIL on the new cases.

- [ ] **Step 3: Write minimal implementation**

Add imports and route branches before the final 404:
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { blobPath, isValidHex, schemaBytes } from './store-reader.ts';
```
```ts
    const blobMatch = pathname.match(/^\/v1\/blobs\/sha256\/([^/]+)$/);
    if (blobMatch) {
      const hex = blobMatch[1];
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
      const bytes = await schemaBytes(decodeURIComponent(schemaMatch[1]));
      if (!bytes) { send(res, 404, 'not found'); return; }
      send(res, 200, bytes, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/http-reader.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/http-reader.ts src/http-reader.test.ts
git commit -m "feature: blob and schema reader endpoints with honest 400/404 mapping"
```

---

### Task 9: SSE follow (`follow=true`) — one-cursor replay→follow, Last-Event-ID, heartbeats, backpressure

**Files:**
- Modify: `src/http-reader.ts`
- Test: `src/http-reader.test.ts` (add SSE + reconnect cases)

**Interfaces:**
- Consumes: everything from Tasks 6–8 plus `BoundarySource.waitForAdvance`.
- Produces: SSE branch inside `handleEvents`. `Last-Event-ID` header overrides `after` (validated the same; malformed → 400). SSE frames: `id: <seq>\nevent: slipstream\ndata: <raw>\n\n`. Heartbeat: `: heartbeat\n\n` on an interval. Backpressure: if `res.write()` returns false, await `drain` with a deadline (`SSE_DRAIN_DEADLINE_MS = 10000`); on timeout, destroy. Abort via an `AbortController` tied to `res` `close`/`error`. On boundary source that never advances (quiescent), the connection idles with heartbeats until the client disconnects.

For this task the daemon wiring passes `active` so `liveBoundary` is exercised; the test drives advances by appending to the log **and** bumping the active session's health (a `FakeActive` helper).

- [ ] **Step 1: Write the failing test**

```ts
// add to src/http-reader.test.ts
import { createHealth } from './health.ts';
import { appendFile } from 'node:fs/promises';

function sseEvents(text: string): { id: string; data: string }[] {
  return text.split('\n\n').filter((f) => f.includes('data:')).map((frame) => {
    const id = /(^|\n)id: (.*)/.exec(frame)?.[2] ?? '';
    const data = /(^|\n)data: (.*)/.exec(frame)?.[2] ?? '';
    return { id, data };
  });
}

describe('http-reader SSE follow', () => {
  it('replays then follows with one cursor: no gap, no duplicate across the seam', async () => {
    const dir = await storeWithSession();               // has seq 1,2 on disk
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
      signal: ac.signal,
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = ''; const seen: string[] = [];
    async function pump(until: number) {
      while (seen.length < until) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        for (const e of sseEvents(acc)) if (e.data && !seen.includes(e.id)) seen.push(e.id);
      }
    }
    await pump(2);                                       // replayed 1,2
    // live append 3 and advance the durable boundary
    await appendFile(join(dir, 'sessions', UUID, 'events.jsonl'),
      JSON.stringify({ specversion:'1.0', id:'3', source:'urn:slipstream:session:'+UUID,
        type:'slipstream.file.changed.v1', datacontenttype:'application/json', seq:'3',
        time:'2026-01-01T00:00:00.000Z', data:{ session_id: UUID } }) + '\n');
    health.setDurableSeq(3n);
    await pump(3);
    assert.deepEqual(seen, ['1', '2', '3']);            // no gap, no dup
    ac.abort();
    await srv.close();
  });

  it('Last-Event-ID overrides after and yields exactly the suffix', async () => {
    const dir = await storeWithSession();
    const health = createHealth(2n);
    const srv = await startReaderServer({
      storeDir: dir, active: { id: UUID, health, logPath: join(dir, 'sessions', UUID, 'events.jsonl') },
    });
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/v1/sessions/${UUID}/events?after=0&follow=true`, {
      headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}`, 'last-event-id': '1' },
      signal: ac.signal,
    });
    const reader = res.body!.getReader(); const decoder = new TextDecoder();
    let acc = ''; let firstId = '';
    while (!firstId) {
      const { value, done } = await reader.read(); if (done) break;
      acc += decoder.decode(value, { stream: true });
      firstId = sseEvents(acc)[0]?.id ?? '';
    }
    assert.equal(firstId, '2');                          // 1 skipped
    ac.abort(); await srv.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/http-reader.test.ts` → FAIL (follow not implemented; finite path closes immediately).

- [ ] **Step 3: Write minimal implementation**

In `handleEvents`, replace the finite-only tail with a follow branch. Add:
```ts
const SSE_HEARTBEAT_MS = 15000;
const SSE_DRAIN_DEADLINE_MS = 10000;

function isFollow(params: URLSearchParams): boolean {
  const v = params.get('follow');
  return v === 'true' || v === '1';
}
async function writeBackpressured(res: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('drain timeout')); }, SSE_DRAIN_DEADLINE_MS);
    const onDrain = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { clearTimeout(timer); res.off('drain', onDrain); signal.removeEventListener('abort', onAbort); };
    res.once('drain', onDrain); signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

Inside `handleEvents`, after computing `after` and the tombstone/404 checks, branch:
```ts
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
      res.writeHead(200, { 'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8', [DURABLE_SEQ_HEADER]: H.toString() });
      const cursor = await openLogCursor(logPath, effectiveAfter);
      try { for (const ev of await cursor.readThrough(H)) res.write(ev.raw + '\n'); }
      finally { await cursor.close(); }
      res.end();
      return;
    }

    // follow=true: SSE, one cursor over disk bounded by the advancing durable boundary
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8' });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    res.on('error', () => ac.abort());
    const heartbeat = setInterval(() => {
      if (!res.write(':' + ' heartbeat\n\n')) { /* let backpressure path handle */ }
    }, SSE_HEARTBEAT_MS);
    const cursor = await openLogCursor(logPath, effectiveAfter);
    try {
      let cur = effectiveAfter;
      for (;;) {
        const target = boundary.current();
        if (target > cur) {
          for (const ev of await cursor.readThrough(target)) {
            await writeBackpressured(res, `id: ${ev.seq}\nevent: slipstream\ndata: ${ev.raw}\n\n`, ac.signal);
            cur = ev.seq;
          }
        }
        await boundary.waitForAdvance(cur, ac.signal); // rejects on abort → exits loop
      }
    } catch { /* aborted or drain timeout */ }
    finally { clearInterval(heartbeat); await cursor.close(); if (!res.writableEnded) res.destroy(); }
    return;
```

Note the `':' + ' heartbeat\n\n'` avoids an accidental leading-space lint; a heartbeat is any line starting with `:`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/http-reader.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/http-reader.ts src/http-reader.test.ts
git commit -m "feature: SSE follow with one-cursor replay-then-follow, Last-Event-ID, heartbeats, backpressure"
```

---

### Task 10: `tui.ts` — disk mode + HTTP/SSE mode + rendering

**Files:**
- Create: `src/tui.ts`
- Test: `src/tui.test.ts`

**Interfaces:**
- Consumes: `listSessions`, `openLogCursor` equivalents via store-reader/log-reader for `--disk`; `readRuntimeDescriptor` for HTTP mode; `fetch` streaming for SSE.
- Produces:
  - `function renderEvent(ev: ReaderEvent): string` — one human-readable line: `seq · <kind> · <path|-> · <content sha7|absent|unavailable:reason|-> · [gap:reason]`, control chars sanitized.
  - `function replayFromDisk(storeDir: string, id: string, opts?: { after?: bigint }): Promise<string[]>` — finite replay lines from the on-disk log, bounded by `onDiskHighWater`.
  - `async function runTui(argv: string[], out: (line: string) => void): Promise<void>` — `--disk` finite mode vs HTTP/SSE live mode; selects store/session explicitly.

`renderEvent` reads only public fields; unknown types render as `seq · <type> · -`. Sanitize by replacing `[ -]` with `�`.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEvent, replayFromDisk } from './tui.ts';
import { parseLine } from './log-reader.ts';

const UUID = '55555555-5555-4555-8555-555555555555';

describe('tui', () => {
  describe('renderEvent', () => {
    it('renders a content change and sanitizes control chars in the path', () => {
      const ev = parseLine(JSON.stringify({ seq: '7', type: 'slipstream.file.changed.v1',
        data: { path: 'a b', after: { kind: 'content', sha256: 'abcdef0'.padEnd(64,'0'), size: 3 } } }));
      const line = renderEvent(ev);
      assert.match(line, /^7 · slipstream\.file\.changed\.v1 · a�b · abcdef0/);
    });
    it('renders an unknown type without throwing', () => {
      const ev = parseLine(JSON.stringify({ seq: '8', type: 'future.v9', data: {} }));
      assert.match(renderEvent(ev), /^8 · future\.v9 · -/);
    });
  });

  describe('replayFromDisk', () => {
    it('returns rendered lines for the whole durable log', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'slip-tui-'));
      await mkdir(join(dir, 'sessions', UUID), { recursive: true });
      const mk = (seq: number) => JSON.stringify({ seq: String(seq), type: 'slipstream.file.changed.v1',
        data: { path: `f${seq}`, after: { kind: 'absent' } } }) + '\n';
      await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), mk(1) + mk(2), 'utf8');
      const lines = await replayFromDisk(dir, UUID);
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^1 · /);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/tui.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tui.ts
import { openLogCursor, type ReaderEvent } from './log-reader.ts';
import { onDiskHighWater, sessionLogPath, listSessions, readRuntimeDescriptor } from './store-reader.ts';

const sanitize = (s: string) => s.replace(/[ -]/g, '�');

function snapshotLabel(snap: unknown): string {
  if (typeof snap !== 'object' || snap === null) return '-';
  const s = snap as Record<string, unknown>;
  if (s.kind === 'content' && typeof s.sha256 === 'string') return s.sha256.slice(0, 7);
  if (s.kind === 'absent') return 'absent';
  if (s.kind === 'unavailable') return `unavailable:${String(s.reason)}`;
  return '-';
}

export function renderEvent(ev: ReaderEvent): string {
  const d = ev.data;
  const path = typeof d.path === 'string' ? sanitize(d.path) : '-';
  const parts = [ev.seq.toString(), ev.type, path];
  if (ev.type === 'slipstream.file.changed.v1') parts.push(snapshotLabel(d.after));
  else if (ev.type === 'slipstream.capture.gap.v1') parts.push(`gap:${sanitize(String(d.reason ?? 'unknown'))}`);
  return parts.join(' · ');
}

export async function replayFromDisk(
  storeDir: string, id: string, opts: { after?: bigint } = {},
): Promise<string[]> {
  const logPath = sessionLogPath(storeDir, id);
  const H = await onDiskHighWater(logPath);
  const cursor = await openLogCursor(logPath, opts.after ?? 0n);
  try { return (await cursor.readThrough(H)).map(renderEvent); }
  finally { await cursor.close(); }
}

export async function runTui(argv: string[], out: (line: string) => void): Promise<void> {
  const disk = argv.includes('--disk');
  const store = argFor(argv, '--store');
  const session = argFor(argv, '--session');
  if (!store) { out('usage: slipstream view --store <dir> [--session <id>] [--disk]'); return; }
  if (!session) {
    for (const s of await listSessions(store)) out(`${s.id}  durable=${s.durableSeq}${s.removed ? '  (removed)' : ''}`);
    return;
  }
  if (disk) { for (const line of await replayFromDisk(store, session)) out(line); return; }
  await followHttp(store, session, out);
}

function argFor(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function followHttp(store: string, session: string, out: (l: string) => void): Promise<void> {
  const desc = await readRuntimeDescriptor(store);
  if (!desc) { out('no running reader (runtime descriptor not found); try --disk'); return; }
  const url = new URL(`v1/sessions/${session}/events?after=0&follow=true`, desc.url);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${desc.token}`, host: new URL(desc.url).host },
  });
  if (!res.ok || !res.body) { out(`reader responded ${res.status}`); return; }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let acc = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    acc += decoder.decode(value, { stream: true });
    let i;
    while ((i = acc.indexOf('\n\n')) >= 0) {
      const frame = acc.slice(0, i); acc = acc.slice(i + 2);
      const m = /(^|\n)data: (.*)$/.exec(frame);
      if (m) { const { parseLine } = await import('./log-reader.ts'); out(renderEvent(parseLine(m[2]))); }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/tui.test.ts` → PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/tui.ts src/tui.test.ts
git commit -m "feature: minimal disk-and-HTTP TUI client over public artifacts"
```

---

### Task 11: `cli.ts` — `serve` and `view` subcommands

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts` (add cases; keep existing green)

**Interfaces:**
- Consumes: `startCapture` (session.ts), `startReaderServer` (http-reader), `runTui` (tui).
- Produces: `parseArgs` extended to recognize `serve` and `view`; `main()` dispatches. `serve [dir] [--store <dir>]` → `startCapture` + `startReaderServer({ storeDir, active: { id, health, logPath } })`, prints the descriptor path to stderr, wires SIGINT/SIGTERM to close both. `view ...` → `runTui(process.argv.slice(3), console.log)`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/cli.test.ts
import { parseArgs } from './cli.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('cli parseArgs (reader commands)', () => {
  it('parses serve with a store override', () => {
    assert.deepEqual(parseArgs(['serve', '/w', '--store', '/s']),
      { command: 'serve', dir: '/w', store: '/s' });
  });
  it('parses view passing through remaining args', () => {
    const parsed = parseArgs(['view', '--store', '/s', '--session', 'abc', '--disk']);
    assert.equal(parsed?.command, 'view');
  });
});
```

Note: existing `parseArgs` returns `{ dir, store }` for `watch`. Extend the return type to include a `command` discriminant while keeping `watch` working; update the existing `watch` test expectation to `{ command: 'watch', dir, store }` in the same commit.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/cli.test.ts` → FAIL (no `command`, no `serve`/`view`).

- [ ] **Step 3: Write minimal implementation**

Refactor `parseArgs` to a discriminated result and add dispatch in `main()`. Keep `watch` behavior identical apart from the added `command` field. Wire `serve` to start capture + reader and print `descriptorPath`. (Follow the file's existing style for arg handling and signal wiring.)

- [ ] **Step 4: Run the touched area's full suite**

Run: `node --test src/cli.test.ts` → PASS (including the updated `watch` case). Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feature: serve and view CLI subcommands wiring capture, reader, and TUI"
```

---

### Task 12: Integration tests — two-reader convergence, stale-cursor reconnect, schema-evolution guard

**Files:**
- Create: `src/reader-convergence.test.ts`
- (No production changes expected; if a test reveals a gap, fix in the owning module and note it.)

**Interfaces:**
- Consumes: `startReaderServer`, `withFakeSession` (drives real capture over `FakePlatform` to produce a real on-disk log + blobs), `createCas`.
- The **direct-disk reader in this test is a separate minimal re-implementation** — a strict JSONL parse + its own reducer — NOT a call into `log-reader.ts`, so agreement is evidence of independent correctness.

- [ ] **Step 1: Write the failing test**

```ts
// src/reader-convergence.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startReaderServer } from './http-reader.ts';
import { withFakeSession } from './test/helpers.ts';

// INDEPENDENT direct-disk reader — deliberately not the production log-reader.
function directDiskEvents(logText: string): { seq: string; type: string; obj: any }[] {
  return logText.split('\n').filter((l) => l.length > 0).map((l) => {
    const obj = JSON.parse(l);
    return { seq: obj.seq, type: obj.type, obj };
  });
}

describe('reader convergence', () => {
  it('the HTTP reader and an independent disk reader agree on ordered event identities', async () => {
    await withFakeSession(
      async (root) => { await (await import('node:fs/promises')).writeFile(join(root, 'a.txt'), 'hi'); },
      async ({ root, session, observe, waitFor }) => {
        observe(join(root, 'a.txt'));
        await waitFor((recs) => recs.some((r) => r.type === 'slipstream.file.changed.v1'));
        const storeDir = session.logPath.replace(/sessions\/.+$/, '').replace(/\/$/, '');
        const srv = await startReaderServer({ storeDir });
        try {
          const H = BigInt(session.health.snapshot().durable_seq);
          const res = await fetch(`${srv.url}/v1/sessions/${session.sessionId}/events?after=0`, {
            headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
          });
          const httpSeqs = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l).seq);
          const diskSeqs = directDiskEvents(await readFile(session.logPath, 'utf8'))
            .filter((e) => BigInt(e.seq) <= H).map((e) => e.seq);
          assert.deepEqual(httpSeqs, diskSeqs);
          assert.ok(httpSeqs.length > 0);
        } finally { await srv.close(); }
      },
    );
  });

  it('reconnect from a stale cursor returns exactly the suffix (idempotent by seq)', async () => {
    // finite request from a mid cursor K returns (K, H]; applying twice is idempotent by (session,seq)
    // Build a store with seqs 1..3 and assert after=1 -> [2,3], after=3 -> [].
    // (Use a fixed on-disk log as in http-reader.test.ts.)
  });

  it('schema-evolution guard: unknown type between and after known events, plus unknown fields', async () => {
    // Write a log: known(1), unknown-type(2, extra nested field), known(3, extra top-level field).
    // Assert the finite feed returns all three seqs in order and the cursor reaches 3.
  });
});
```

Fill in the two stubbed tests with concrete fixed-log fixtures mirroring `http-reader.test.ts` (write `events.jsonl` directly with an unknown `type` and extra fields, start the server, assert seqs `['1','2','3']` and that a follow-up `after=3` is empty). Keep them deterministic (no capture needed).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/reader-convergence.test.ts` → FAIL until fixtures + assertions are filled in.

- [ ] **Step 3: Complete the fixtures and assertions**

Write the concrete unknown-type/unknown-field fixture and the stale-cursor fixture as described. No production code changes expected.

- [ ] **Step 4: Run the full suite**

Run: `npm test` (whole deterministic tier) and `npm run typecheck`. Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/reader-convergence.test.ts
git commit -m "test: two-reader convergence, stale-cursor reconnect, schema-evolution guard"
```

---

### Task 13: Update the Stage 2 status line

**Files:**
- Modify: `IMPLEMENTATION_PLAN.md` (Stage 2 **Status** line only — do not reword any success criterion)

- [ ] **Step 1:** Change the Stage 2 `**Status**` from "In Progress — durable write path + restart reconciliation (PR 2a) complete… Remaining for PR 2b: …" to note PR 2b complete: the `/v1` reader API (finite NDJSON + SSE follow, one-cursor replay-then-follow, error codes, loopback bearer auth + host/origin), the two-reader convergence and stale-cursor tests, the schema-evolution guard, and the disk-reading TUI. Note the recovery durable-sync gap is tracked as separate work.

- [ ] **Step 2: Run the full suite one more time**

Run: `npm test` and `npm run typecheck` (and `npm run test:os` if any `*.os.test.ts` were added). Expected: green.

- [ ] **Step 3: Commit**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "chore: mark Stage 2 PR 2b reader API and TUI complete"
```

---

## Self-review (completed during planning)

**Spec coverage:** `/v1/sessions` (T6), events finite + errors + header (T7), blobs + schemas (T8), SSE follow / one-cursor / Last-Event-ID / heartbeats / backpressure (T9), auth + host/origin (T5, gated in T6), 410 tombstone (T7), durable-bounded cursor (T2, T4), TUI disk + HTTP (T10), CLI (T11), convergence + reconnect + schema-evolution + error-code tests (T7, T8, T12). Recovery durable-sync gap is explicitly out of scope (separate PR).

**Placeholder scan:** the only intentionally-stubbed steps are the two extra assertions in T12 Step 1, whose Step 3 gives the concrete fixture recipe; all code steps carry real code.

**Type consistency:** `ReaderEvent` (T2) is consumed unchanged by T9/T10; `BoundarySource` (T4) by T7/T9; `SessionInfo.durableSeq` (T1, bigint) is serialized to `durable_seq` string in T6; `DURABLE_SEQ_HEADER` (T7) reused in T9; `RuntimeDescriptor` (T1) produced by T5 `publishDescriptor` and read by T10.
