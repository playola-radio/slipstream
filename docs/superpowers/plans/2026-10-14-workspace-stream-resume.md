# One Stream per Workspace (Resume on Re-attach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `attach` on a worktree that already has a non-removed session resumes that session (same id, `seq` continues) instead of minting a new one.

**Architecture:** A log-derived lookup (`findWorkspaceSession`) runs inside the attach's in-flight window. A match is pinned in the boundary registry at its durable high-water `H` and then started through the existing `startCapture({ resumeSessionId })` path. Any failure to resume fails closed with `SESSION_RESUME_FAILED`. A `session.resumed` record resets the current-task pointer and question eligibility in both the live fold and the recovery fold.

**Tech Stack:** TypeScript on Node 24, `node:test`, `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-14-workspace-stream-resume-design.md`. Read it before any task.

## Global Constraints

Rules for every change:
- Never mint a fallback UUID once a candidate session was selected. Failure is `SESSION_RESUME_FAILED`, naming the session id and the cause.
- `/v1/sessions` wire shape is unchanged. Inactive sessions keep `agent_connection: {state:"disconnected", reason:"capture_not_live"}`.
- The attach reply gains no field. `already_active` stays reserved for an already-running binding.
- Single-active capture is unchanged. Chat B attaching while A is active still gets `SESSION_ACTIVE`.
- No production changes to `maintenance.ts`, `reader-runtime.ts` or `lock.ts`. `attach-workflow.ts` output is unchanged.
- Nothing new is appended to mark a connection stale. `session.resumed` implies it, and the contract says so.
- No caching or index for the lookup. Every answer is derived from the logs.

Process rules:
- Do not merge or migrate existing duplicate sessions.
- TDD: test first and watch it fail. Never disable a test. Tests that encode the old "fresh id per attach" behaviour are **rewritten** to the new behaviour.
- No `Co-Authored-By` or co-sign trailers. Never `--no-verify`.
- Never commit `.slipstream/`, `sessions/`, `blobs/` or `*.jsonl`. Never touch the real `~/.slipstream`.

Test commands:
- One file: `node --test --test-concurrency=1 src/<file>.test.ts`
- Full suite: `npm test`
- Tools suite: `npm run test:tools`
- Types: `npm run typecheck`

## Review Focus

The inputs and conditions most likely to bite a real user that no single task's happy path exercises. Each has a test pinned in the task that owns the code.

1. **A workspace whose session log ends in a corrupt final record.**
   - Expected: attach refuses with `SESSION_RESUME_FAILED` naming the session. It must not mint a second stream.
   - Pinned in: Task 1 (`WorkspaceLookupError`) and Task 4 (daemon mapping).
2. **The daemon is shut down while an attach is still looking up the workspace.**
   - Expected: shutdown waits for the attach, and the attach reports an error without starting capture.
   - Pinned in: Task 4.
3. **A reader client that is following a stopped session when it is resumed.**
   - Expected: after reconnecting with `Last-Event-ID`, it receives every post-resume record exactly once, with nothing missing.
   - Pinned in: Task 4 (in-process and disk-only follower).
4. **A delayed disk read in the reader that started before the resume pinned the boundary.**
   - Expected: it must not install a stale boundary over the live one.
   - Pinned in: Task 2.
5. **A `begin_task` from a chat that is still in flight while the workspace is detached and re-attached.**
   - Expected: it is refused (`SESSION_NOT_SELECTED`), not committed into the new activation.
   - Pinned in: Task 4.

---

## File Structure

| File | Responsibility in this change |
| --- | --- |
| `src/store-reader.ts` | `findWorkspaceSession`, `WorkspaceLookupError`, and `finalRecord` (extracted from `onDiskHighWater`) |
| `src/boundary-registry.ts` | `resolveBoundary` helper and the rewritten race-freedom invariant |
| `src/http-reader.ts` | `boundaryFor` delegates to `resolveBoundary` |
| `src/recovery.ts` | Fold resets on `session.resumed`; exposes `latestResumedSeq` |
| `src/session.ts` | Live-fold resets on `session.resumed`; `seedTaskState` eligibility after the latest resume |
| `src/control-protocol.ts` | `SESSION_RESUME_FAILED` code |
| `src/daemon.ts` | Lookup in attach, resume path, failure handling, `beginTask` binding guard, `workspaceLookup` test seam |
| `tools/qa-daemon.ts`, `tools/qa/harness-proc.test.ts` | QA readiness on a resumed session |
| `schemas/slipstream.capture.gap.v1.json`, `schemas/slipstream.session.resumed.v1.json` | Description text only |
| `docs/ask-agent/contract.md`, `SKILL.md`, `IMPLEMENTATION_PLAN.md` | Docs |

Task order: 1 → 2 → 3 → 4 → 5 → 6. Task 4 depends on Tasks 1–3.

---

### Task 1: Find a workspace's session from the logs

**Files:**
- Modify: `src/store-reader.ts` (`onDiskHighWater` at L37–78; add new exports after `listSessions`)
- Test: `src/store-reader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkspaceSessionMatch { id: string; durableSeq: bigint }
  export interface WorkspaceLookup { match: WorkspaceSessionMatch | undefined; skipped: { id: string; reason: string }[] }
  export class WorkspaceLookupError extends Error { readonly sessionId: string }
  export async function findWorkspaceSession(storeDir: string, canonicalRoot: string): Promise<WorkspaceLookup>
  ```
- `onDiskHighWater` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests**

Add to the imports in `src/store-reader.test.ts`: `findWorkspaceSession, WorkspaceLookupError, tombstonePath` from `./store-reader.ts`, and `rm` from `node:fs/promises`. Append:

```ts
describe('findWorkspaceSession', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  const line = (seq: number, type: string, data: unknown, time = '2026-10-14T10:00:00.000Z') =>
    JSON.stringify({ seq: String(seq), type, time, data }) + '\n';
  const started = (root: string, time?: string) => line(1, 'slipstream.session.started.v1', { root, max_bytes: 1 }, time);
  async function seed(dir: string, id: string, body: string): Promise<void> {
    await mkdir(join(dir, 'sessions', id), { recursive: true });
    await writeFile(sessionLogPath(dir, id), body);
  }
  async function emptyStore(): Promise<string> { return mkdtemp(join(tmpdir(), 'slip-ws-')); }

  it('finds the session whose started root matches and reports its durable seq', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work') + line(2, 'slipstream.capture.scope.v1', {}));
    await seed(dir, B, started('/elsewhere'));
    const found = await findWorkspaceSession(dir, '/work');
    assert.deepEqual(found.match, { id: A, durableSeq: 2n });
    assert.deepEqual(found.skipped, []);
  });

  it('returns no match for an empty or missing store', async () => {
    const dir = await emptyStore();
    assert.deepEqual(await findWorkspaceSession(dir, '/work'), { match: undefined, skipped: [] });
    assert.deepEqual(await findWorkspaceSession(join(dir, 'nope'), '/work'), { match: undefined, skipped: [] });
  });

  it('never returns a tombstoned session, even with a residual log', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work'));
    await writeFile(tombstonePath(dir, A), JSON.stringify({ version: 1 }));
    assert.equal((await findWorkspaceSession(dir, '/work')).match, undefined);
  });

  it('skips, with a reason, a session whose first record is torn, invalid, missing, or not session.started', async () => {
    const dir = await emptyStore();
    const D = '44444444-4444-4444-8444-444444444444';
    await seed(dir, A, '{"seq":"1","type":"slipstream.session.st');
    await seed(dir, B, 'not json\n');
    await seed(dir, C, line(1, 'slipstream.capture.scope.v1', {}));
    await mkdir(join(dir, 'sessions', D), { recursive: true }); // no log at all
    await mkdir(join(dir, 'sessions', 'not-a-uuid'), { recursive: true });
    const found = await findWorkspaceSession(dir, '/work');
    assert.equal(found.match, undefined);
    assert.deepEqual(found.skipped.map(s => s.id).sort(), [A, B, C, D]);
    assert.ok(found.skipped.every(s => s.reason.length > 0));
  });

  it('picks the duplicate whose last record is newest', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work') + line(2, 'x', {}, '2026-10-14T12:00:00.000Z'));
    await seed(dir, B, started('/work') + line(2, 'x', {}, '2026-10-14T11:00:00.000Z'));
    assert.equal((await findWorkspaceSession(dir, '/work')).match?.id, A);
  });

  it('breaks a last-record time tie by the smallest session id', async () => {
    const dir = await emptyStore();
    await seed(dir, B, started('/work'));
    await seed(dir, A, started('/work'));
    assert.equal((await findWorkspaceSession(dir, '/work')).match?.id, A);
  });

  it('ignores a torn tail when reading the matched session\'s last record', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work') + '{"seq":"2","ty');
    assert.deepEqual((await findWorkspaceSession(dir, '/work')).match, { id: A, durableSeq: 1n });
  });

  it('fails closed, naming the session, when a matched session\'s final record is unreadable', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work') + 'garbage\n');
    await assert.rejects(findWorkspaceSession(dir, '/work'),
      (err: unknown) => err instanceof WorkspaceLookupError && err.sessionId === A && err.message.includes(A));
  });

  it('fails closed when a matched session\'s final record has no valid time', async () => {
    const dir = await emptyStore();
    await seed(dir, A, started('/work') + JSON.stringify({ seq: '2', type: 'x', time: 'nope', data: {} }) + '\n');
    await assert.rejects(findWorkspaceSession(dir, '/work'), WorkspaceLookupError);
  });
});
```

`onDiskHighWater` keeps its existing tests unchanged; they guard the refactor.

The symlink alias case belongs to the daemon (it canonicalizes before calling this function), so it is pinned in Task 4.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-concurrency=1 src/store-reader.test.ts`
Expected: FAIL. `findWorkspaceSession` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement**

In `src/store-reader.ts`, replace `onDiskHighWater` with a `finalRecord` reader plus a thin wrapper. The backward scan is moved verbatim.

```ts
interface FinalRecord { seq: bigint; time: unknown }

/** The last complete record's seq and time; undefined for a missing log or one
 * with no complete line. Torn trailing bytes are ignored. */
async function finalRecord(logPath: string): Promise<FinalRecord | undefined> {
  let handle;
  try { handle = await open(logPath, 'r'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let lastLine: string;
  try {
    // (existing backward-scan body, unchanged, except `return 0n` → `return undefined`)
  } finally { await handle.close(); }
  if (lastLine === '') throw new LogCorruptError('high-water: blank final record');
  let parsed: { seq?: unknown; time?: unknown };
  try { parsed = JSON.parse(lastLine) as { seq?: unknown; time?: unknown }; }
  catch { throw new LogCorruptError('high-water: invalid JSON in final record'); }
  if (typeof parsed.seq !== 'string' || !SEQ_RE.test(parsed.seq)) {
    throw new LogCorruptError('high-water: final record has no valid decimal-string seq');
  }
  return { seq: BigInt(parsed.seq), time: parsed.time };
}

export async function onDiskHighWater(logPath: string): Promise<bigint> {
  return (await finalRecord(logPath))?.seq ?? 0n;
}
```

Append after `listSessions`:

```ts
export interface WorkspaceSessionMatch { id: string; durableSeq: bigint }
export interface WorkspaceLookup { match: WorkspaceSessionMatch | undefined; skipped: { id: string; reason: string }[] }

/** A session recorded for this workspace whose history cannot be read. Attach
 * must fail closed on it rather than start a second stream for the workspace. */
export class WorkspaceLookupError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause: unknown) {
    super(`session ${sessionId} records this workspace but its log cannot be read: ${(cause as Error).message}`, { cause });
    this.name = 'WorkspaceLookupError';
    this.sessionId = sessionId;
  }
}

const FIRST_RECORD_LIMIT = 64 * 1024;

/** The `root` of a log's first record, which must be `session.started`. */
async function startedRoot(logPath: string): Promise<string> {
  const handle = await open(logPath, 'r');
  let line: string;
  try {
    const buffer = Buffer.allocUnsafe(FIRST_RECORD_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, FIRST_RECORD_LIMIT, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) throw new LogCorruptError('first record is torn or larger than 64 KiB');
    line = buffer.subarray(0, end).toString('utf8');
  } finally { await handle.close(); }
  let parsed: { type?: unknown; data?: { root?: unknown } | null };
  try { parsed = JSON.parse(line) as typeof parsed; }
  catch { throw new LogCorruptError('first record is not valid JSON'); }
  if (parsed.type !== 'slipstream.session.started.v1' || typeof parsed.data?.root !== 'string') {
    throw new LogCorruptError('first record is not a session.started record');
  }
  return parsed.data.root;
}

/** The non-removed session recorded for `canonicalRoot`, derived from the logs
 * alone. Duplicates resolve to the newest last record, then the smallest id. A
 * session whose first record cannot be read is skipped and reported. */
export async function findWorkspaceSession(storeDir: string, canonicalRoot: string): Promise<WorkspaceLookup> {
  let entries: string[];
  try { entries = await readdir(sessionsDir(storeDir)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { match: undefined, skipped: [] };
    throw err;
  }
  const skipped: { id: string; reason: string }[] = [];
  let best: (WorkspaceSessionMatch & { ms: number }) | undefined;
  for (const id of entries.filter(isValidSessionId).sort()) {
    if ((await readTombstone(storeDir, id)) !== null) continue;
    const logPath = sessionLogPath(storeDir, id);
    let root: string;
    try { root = await startedRoot(logPath); }
    catch (err) { skipped.push({ id, reason: (err as Error).message }); continue; }
    if (root !== canonicalRoot) continue;
    let last: FinalRecord;
    let ms: number;
    try {
      last = (await finalRecord(logPath))!; // the first line is complete, so a final record exists
      ms = typeof last.time === 'string' ? Date.parse(last.time) : Number.NaN;
      if (Number.isNaN(ms)) throw new LogCorruptError('final record has no valid time');
    } catch (err) { throw new WorkspaceLookupError(id, err); }
    if (!best || ms > best.ms) best = { id, durableSeq: last.seq, ms };
  }
  return { match: best && { id: best.id, durableSeq: best.durableSeq }, skipped };
}
```

Notes:
- `isValidSessionId`, `readTombstone`, `sessionLogPath` and `sessionsDir` are already in this file.
- A missing log makes `open` throw ENOENT inside `startedRoot`. That is caught and skipped, as D3 requires.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 src/store-reader.test.ts`
Expected: PASS, including every pre-existing `onDiskHighWater` and `listSessions` test.

- [ ] **Step 5: Commit**

```bash
git add src/store-reader.ts src/store-reader.test.ts
git commit -m "feature: find a workspace's existing session from its logs"
```

---

### Task 2: Make the registry win over a slow disk read

**Files:**
- Modify: `src/boundary-registry.ts` (header comment L25–32; add the export after `createBoundaryRegistry`)
- Modify: `src/http-reader.ts` (`boundaryFor`, ~L263)
- Test: `src/boundary-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function resolveBoundary(registry: BoundaryRegistry, id: string, readDisk: () => Promise<bigint>): Promise<BoundarySource>
  ```
- Consumes: `staticBoundary` from `./reader-runtime.ts`, which is already imported there.

- [ ] **Step 1: Write the failing tests**

Add `resolveBoundary` to the import from `./boundary-registry.ts`, then append inside the `describe`:

```ts
  it('resolveBoundary prefers an entry installed while the disk read was pending', async () => {
    const registry = createBoundaryRegistry();
    let finish!: (seq: bigint) => void;
    const pending = resolveBoundary(registry, ID, () => new Promise<bigint>(r => { finish = r; }));
    registry.freeze(ID, 7n); // a resume pins the boundary meanwhile
    finish(3n);              // the stale disk read lands afterwards
    assert.equal((await pending).current(), 7n);
  });

  it('resolveBoundary prefers a late registry entry over a failed disk read', async () => {
    const registry = createBoundaryRegistry();
    let fail!: (err: Error) => void;
    const pending = resolveBoundary(registry, ID, () => new Promise<bigint>((_, reject) => { fail = reject; }));
    registry.freeze(ID, 7n);
    fail(new Error('torn'));
    assert.equal((await pending).current(), 7n);
  });

  it('resolveBoundary falls back to disk, or its error, when the registry never learns the id', async () => {
    const registry = createBoundaryRegistry();
    assert.equal((await resolveBoundary(registry, ID, async () => 4n)).current(), 4n);
    await assert.rejects(resolveBoundary(registry, ID, async () => { throw new Error('torn'); }), /torn/);
  });
```

Use the file's existing session-id constant if it has one (check the top of the file). Otherwise add `const ID = '11111111-1111-4111-8111-111111111111';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-concurrency=1 src/boundary-registry.test.ts`
Expected: FAIL. `resolveBoundary` is not exported.

- [ ] **Step 3: Implement**

Append to `src/boundary-registry.ts`:

```ts
/** A session's boundary: the registry's if it knows the id, else the disk
 * high-water. The registry is re-checked after the async disk read (and on its
 * failure), so a boundary pinned meanwhile is never replaced by a stale read. */
export async function resolveBoundary(
  registry: BoundaryRegistry, id: string, readDisk: () => Promise<bigint>,
): Promise<BoundarySource> {
  const known = registry.get(id);
  if (known) return known.boundary;
  let seq: bigint;
  try { seq = await readDisk(); }
  catch (err) {
    const late = registry.get(id);
    if (late) return late.boundary;
    throw err;
  }
  return registry.get(id)?.boundary ?? staticBoundary(seq);
}
```

In `src/http-reader.ts`:
- Import `resolveBoundary` from `./boundary-registry.ts`.
- Replace the body of `boundaryFor`, keeping its comment:

```ts
    return resolveBoundary(registry, id, () => onDiskHighWater(sessionLogPath(opts.storeDir, id)));
```

Replace the last paragraph of the header comment in `src/boundary-registry.ts` ("Race-freedom rests on one invariant… current boundary and joining the set that a transition aborts.") with:

```
 * Race-freedom rests on one invariant enforced by the daemon: before any session
 * log can grow, its registry boundary is installed — `reserve` (0) for a fresh
 * session, `freeze` at the durable high-water for one being resumed — and the
 * registry is authoritative over disk from then on. A disk fallback re-checks the
 * registry after its async read ({@link resolveBoundary}), so a read that started
 * before a resume pinned the boundary cannot install a stale one. Follower
 * registration and boundary reads are synchronous, so no await interleaves
 * between reading the current boundary and joining the set a transition aborts.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 src/boundary-registry.test.ts src/http-reader.test.ts`
Expected: PASS. The full `http-reader.test.ts` suite is the touched-area regression check.

- [ ] **Step 5: Commit**

```bash
git add src/boundary-registry.ts src/boundary-registry.test.ts src/http-reader.ts
git commit -m "bugfix: keep the reader from publishing a stale boundary over a resumed session"
```

---

### Task 3: A resume resets the current task and question eligibility

**Files:**
- Modify: `src/recovery.ts`:
  - `RecoveredSession` (~L23–53)
  - fold variables (~L124–140)
  - `case 'slipstream.session.resumed.v1'` (~L307)
  - the return object (~L338)
- Modify: `src/session.ts`: `seedTaskState` (L271–291) and `taskSequencer.onCommitted` (~L309)
- Test: `src/recovery.test.ts`, `src/session.test.ts` (rewrite the test at ~L713), `src/question-session.test.ts`

**Interfaces:**
- Produces: `RecoveredSession.latestResumedSeq: bigint`. It is 0n when the log has no `session.resumed` record. `RecoveredSession.currentTaskId` now only reflects declarations after the latest resume.

- [ ] **Step 1: Write the failing recovery tests**

Append to `src/recovery.test.ts`:

```ts
const resumed: EventInput = {
  type: 'slipstream.session.resumed.v1',
  occurred_at_ms: 7,
  data: { recovered_through_seq: '1', discarded_tail_bytes: 0 },
};

describe('recovery across a resume', () => {
  it('clears the current task at a resume but keeps the dedup index', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, task('t1', 'r1'), resumed]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.currentTaskId, undefined);
      assert.deepEqual([...rec.taskDeclarations.keys()], ['r1']);
      assert.equal(rec.latestResumedSeq, 3n);
    });
  });

  it('keeps a task declared after the latest resume current', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const path = await seedLog(dir, [started, task('t1', 'r1'), resumed, task('t2', 'r2')]);
      const rec = await recoverSession(path, SESSION, cas);
      assert.equal(rec.currentTaskId, 't2');
    });
  });

  it('reports latestResumedSeq 0 for a log that was never resumed', async () => {
    await withTempDir(async (dir) => {
      const cas = await createCas(join(dir, 'blobs'));
      const rec = await recoverSession(await seedLog(dir, [started]), SESSION, cas);
      assert.equal(rec.latestResumedSeq, 0n);
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 src/recovery.test.ts`
Expected: FAIL. `currentTaskId` is `'t1'`, not `undefined`, and `latestResumedSeq` is `undefined`.

- [ ] **Step 3: Implement the recovery fold**

In `src/recovery.ts`:
- Reword the `currentTaskId` doc on `RecoveredSession` to: "The `task_id` of the last task declaration after the latest `session.resumed`; undefined if none. A resume starts with no current task."
- Add the new field below it:
  ```ts
  /** Seq of the latest `session.resumed` record; 0n if never resumed. Questions
   * queued at or before it are history only and are never claimable again. */
  latestResumedSeq: bigint;
  ```
- Next to `let currentTaskId`, add `let latestResumedSeq = 0n;`.
- Replace the resumed case:
  ```ts
      case 'slipstream.session.resumed.v1':
        currentTaskId = undefined;
        latestResumedSeq = BigInt(event.seq);
        break;
  ```
- Add `latestResumedSeq,` to the returned object after `currentTaskId,`.

- [ ] **Step 4: Run the recovery tests to verify they pass**

Run: `node --test --test-concurrency=1 src/recovery.test.ts`
Expected: PASS. The existing 'rebuilds the current task…' test still expects `'t2'` (there is no resume in it).

- [ ] **Step 5: Rewrite the session resume test and add the D1/D2 live tests**

In `src/session.test.ts`, replace the test 'rebuilds the dedup index and current task across a resume' (~L713) with:

```ts
    it('rebuilds the dedup index across a resume but starts with no current task', async () => {
      await withTempPair(async (root, store) => {
        const platform = createFakePlatform();
        const s1 = await startCapture({ root, storeDir: store }, { platform });
        const sessionId = s1.sessionId;
        const original = await s1.beginTask({ title: 'Persisted', requestId: 'req-1' });
        await s1.stop();

        const s2 = await startCapture({ root, storeDir: store, resumeSessionId: sessionId }, { platform });
        try {
          // Dedup index rebuilt: a replayed duplicate returns the original result
          // and appends nothing — and does NOT make that task current again.
          const replay = await s2.beginTask({ title: 'Persisted', requestId: 'req-1' });
          assert.deepEqual(replay, original);
          assert.equal(declarations(await readRecords(s2.logPath)).length, 1,
            'a replayed declaration must not re-append after resume');

          await writeFile(join(root, 'c.ts'), 'v1');
          platform.observe('c.ts');
          let recs = await waitForRecords(s2.logPath, (r) => changesFor(r, 'c.ts').length >= 1);
          assert.equal(changesFor(recs, 'c.ts')[0]!.data.task_hint_id, undefined);

          // A fresh declaration after the resume groups later changes again.
          const next = await s2.beginTask({ title: 'After resume', requestId: 'req-2' });
          await writeFile(join(root, 'c.ts'), 'v2');
          platform.observe('c.ts');
          recs = await waitForRecords(s2.logPath, (r) => changesFor(r, 'c.ts').length >= 2);
          assert.equal(changesFor(recs, 'c.ts')[1]!.data.task_hint_id, next.task_id);
        } finally {
          await s2.stop();
        }
      });
    });
```

Add to `src/question-session.test.ts`. Reuse its imports; add `createLog`, `StorageError` and `appendFile` if they are missing. This test covers D2 at resume and through storage recovery, plus D1 through storage recovery.

```ts
it('does not make a pre-resume question claimable, even after storage recovery, and keeps a post-resume task', async () => {
  await withTempDir(async base => {
    const rawRoot = join(base, 'work'); await mkdir(rawRoot);
    const root = await realpath(rawRoot);
    const storeDir = join(base, 'store');
    const now = () => 1000;
    let platform = createFakePlatform();
    const s1 = await startCapture({ root, storeDir, now }, { platform });
    await writeFile(join(root, 'a.ts'), 'one\n'); platform.observe('a.ts');
    const ev = (await waitForRecords(s1.logPath, r => r.some(e => e.type === 'slipstream.file.changed.v1')))
      .find(e => e.type === 'slipstream.file.changed.v1')!;
    while (BigInt(s1.health.snapshot().durable_seq) < BigInt(ev.seq)) await new Promise(r => setTimeout(r, 5));
    await s1.askQuestion({ session_id: s1.sessionId, request_id: randomUUID(), text: 'Why?',
      context: { change_seq: ev.seq, path: 'a.ts', snapshot_sha256: ev.data.after.sha256, line_start: 1, line_end: 1 } }, target);
    await s1.stop();

    let failNextChange = false;
    platform = createFakePlatform();
    const s2 = await startCapture({ root, storeDir, now, resumeSessionId: s1.sessionId }, { platform, createLog: async opts => {
      const log = await createLog(opts);
      return { ...log, append: async input => {
        if (input.type === 'slipstream.file.changed.v1' && failNextChange) {
          failNextChange = false;
          await appendFile(opts.filePath, '{"type":"slipstream.file.changed.v1","data":');
          throw new StorageError('append', new Error('torn write'));
        }
        return log.append(input);
      } };
    } });
    try {
      assert.equal(await s2.claimQuestion(target), null, 'a pre-resume question must not be claimable');
      const t2 = await s2.beginTask({ title: 'After resume', requestId: 'r-after' });
      failNextChange = true;
      await writeFile(join(root, 'a.ts'), 'two\n'); platform.observe('a.ts');
      const deadline = Date.now() + 5000;
      // Wait for storage recovery to finish and for its reconciliation to record the change.
      let changes: { data: { task_hint_id?: string } }[] = [];
      while (true) {
        assert.ok(Date.now() < deadline, 'storage recovery did not reconcile a.ts');
        changes = (await readRecords(s2.logPath)).filter(e => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.ts')
          .slice(1) as typeof changes;
        if (s2.health.snapshot().state === 'healthy' && changes.length > 0) break;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(changes.at(-1)!.data.task_hint_id, t2.task_id, 'storage recovery keeps the post-resume task current');
      assert.equal(await s2.claimQuestion(target), null, 'storage recovery must not resurrect a pre-resume question');
    } finally { await s2.stop(); }
  });
});
```

The `.slice(1)` drops the pre-resume change. If the resume's own reconciliation also emits an `a.ts` change, the assertion still uses the last one, which is the one recorded after recovery.

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test --test-concurrency=1 src/session.test.ts src/question-session.test.ts`
Expected: FAIL. The first `task_hint_id` is still the old task, and the claim returns the old question.

- [ ] **Step 7: Implement the live fold and seed**

In `src/session.ts`, in `seedTaskState`, change the first loop so only post-resume questions become eligible. Full history still feeds `committedQuestions`.

```ts
    for (const event of rec.questions) {
      committedQuestions.set(event.data.request_id, { body: questionBody(event.data), result: questionResult(event) });
      // Questions queued before the latest resume stay history only (D2).
      if (BigInt(event.seq) > rec.latestResumedSeq) unattemptedQuestions.set(event.data.question_id, event);
    }
```

In `taskSequencer.onCommitted`, add as the first statement:

```ts
      // A resume starts without a current task or claimable questions (D1/D2).
      if (event.type === 'slipstream.session.resumed.v1') { currentTaskId = undefined; unattemptedQuestions.clear(); }
```

- [ ] **Step 8: Run the touched-area suites**

Run: `node --test --test-concurrency=1 src/recovery.test.ts src/session.test.ts src/question-session.test.ts src/answer-session.test.ts`
Expected: PASS. (Skip `answer-session.test.ts` if the file does not exist.)

- [ ] **Step 9: Commit**

```bash
git add src/recovery.ts src/recovery.test.ts src/session.ts src/session.test.ts src/question-session.test.ts
git commit -m "feature: start a resumed recording with no current task and no carried-over questions"
```

---

### Task 4: Attach resumes the workspace's session

**Files:**
- Modify: `src/control-protocol.ts` (the `ControlErrorCode` union at L21–38 and its doc comment at L16–20)
- Modify: `src/daemon.ts`:
  - `DaemonOptions` (L50–62)
  - imports (L5–23)
  - `startAndActivate` (L390–479)
  - `attach` (L500–536)
  - `beginTask` (L565–634)
- Test: `src/daemon.test.ts`

**Interfaces:**
- Consumes:
  - `findWorkspaceSession`, `WorkspaceLookupError`, `WorkspaceLookup` (Task 1)
  - `RecoveredSession.latestResumedSeq` semantics (Task 3)
  - `CorruptLogError` (`src/recovery.ts`) and `LogCorruptError` (`src/log-reader.ts`)
- Produces:
  - Control error code `'SESSION_RESUME_FAILED'`.
  - `DaemonOptions.workspaceLookup?: typeof findWorkspaceSession`, a test seam.
  - `beginTask` now resolves the worktree through `identityRealpath`.

- [ ] **Step 1: Add the test helpers**

Add these to `src/daemon.test.ts` below `withDaemon`. Add `findWorkspaceSession` to the `./store-reader.ts` import. `createLog`, `realpath` and `symlink` are already imported. Import `PublicEventInput` as a type from `./public-events.ts`.

```ts
type LogRecord = { seq: string; type: string; data: Record<string, unknown> };
async function readLog(store: string, id: string): Promise<LogRecord[]> {
  return (await readFile(sessionLogPath(store, id), 'utf8')).trim().split('\n').map(s => JSON.parse(s) as LogRecord);
}

/** A daemon with real enumeration (so detached edits reconcile) over a store the
 * test keeps across daemon restarts. */
async function withResumeDaemon(
  fn: (ctx: { store: string; worktree: string; daemon: () => Daemon; call: Call;
    restart: (extra?: Partial<Parameters<typeof startDaemon>[0]>) => Promise<void> }) => Promise<void>,
  extra: Partial<Parameters<typeof startDaemon>[0]> = {},
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), 'slip-daemon-resume-'));
  const worktree = await mkdtemp(join(tmpdir(), 'slip-daemon-resume-wt-'));
  const start = (more: Partial<Parameters<typeof startDaemon>[0]> = {}) => startDaemon({ storeDir: store,
    captureDependencies: { platform: createFakePlatform(), readQuestionContext: async () => 'selected' }, ...extra, ...more });
  let daemon = await start();
  const call: Call = (req) => sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, ...req }, responseTimeoutMs: 5000 });
  try {
    await fn({ store, worktree, daemon: () => daemon, call,
      restart: async (more) => { await daemon.stop(); daemon = await start(more); } });
  } finally {
    await daemon.stop().catch(() => {});
    await rm(store, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
}

/** A well-formed log for `root` written by the real writer, so lookup and
 * recovery see a genuine session that this daemon never touched. */
async function seedStartedSession(store: string, id: string, root: string, extra: PublicEventInput[] = []): Promise<void> {
  await mkdir(join(store, 'sessions', id), { recursive: true, mode: 0o700 });
  const log = await createLog({ filePath: sessionLogPath(store, id), sessionId: id });
  try {
    await log.append({ type: 'slipstream.session.started.v1', occurred_at_ms: 1, data: { root, max_bytes: 1024 } });
    for (const input of extra) await log.append(input);
  } finally { await log.close(); }
}

async function sessionsJson(daemon: Daemon): Promise<{ id: string; durable_seq: string }[]> {
  const res = await fetch(`${daemon.readerUrl}/v1/sessions`, { headers: { authorization: `Bearer ${daemon.readerToken}` } });
  return (await res.json()) as { id: string; durable_seq: string }[];
}

/** Read an SSE follow stream until `done` holds or the server ends it. */
async function follow(daemon: Daemon, id: string, after: string, done: (ids: string[]) => boolean,
  opened?: () => void): Promise<string[]> {
  const res = await fetch(`${daemon.readerUrl}/v1/sessions/${id}/events?follow=true`, {
    headers: { authorization: `Bearer ${daemon.readerToken}`, 'last-event-id': after } });
  opened?.();
  const ids: string[] = [];
  const reader = res.body!.getReader();
  let text = '';
  try {
    while (!done(ids)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += Buffer.from(value).toString('utf8');
      let cut;
      while ((cut = text.indexOf('\n\n')) >= 0) {
        const frame = text.slice(0, cut); text = text.slice(cut + 2);
        const idLine = frame.split('\n').find(l => l.startsWith('id:'));
        if (idLine) ids.push(idLine.slice(3).trim());
      }
    }
  } catch { /* an aborted follower ends with a network error; ids so far stand */ }
  finally { await reader.cancel().catch(() => {}); }
  return ids;
}
```

If the session dir mode is asserted owner-only in capture (`assertOwnerOnly`), use `mode: 0o700` as written. If `createLog` creates the directory itself, drop the `mkdir`. Check `src/log.ts`.

- [ ] **Step 2: Rewrite the four tests that encode "fresh id per attach"**

Rewrite each in place, keeping its position in the file:

1. **'does not carry an unattempted question into a fresh capture after daemon restart'** (~L398):
   - Rename it to `'does not carry an unattempted question across a resume after daemon restart'`.
   - Replace `assert.notEqual(rec(fresh).session_id, oldId);` with `assert.equal(rec(fresh).session_id, oldId);`.
   - Before the existing claim assertion, reconnect the chat: `await connectAgent(again, { verb: 'claim_question', harness: 'codex', harness_session_id: 'root', worktree, transcript_path: transcript });`.
   - The existing `question === null` assertion then pins D2.
2. **'mints a NEW session id on every attach (never reactivates a root)'** (~L452): replace it with
   ```ts
   it('resumes the same session id when the same chat re-attaches the same workspace', async () => {
     await withDaemon(async ({ worktree, call }) => {
       const idA = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id;
       await call({ verb: 'detach' });
       const b = await call({ verb: 'attach', worktree, ...IDENTITY });
       assert.equal(b.ok, true);
       assert.equal(rec(b).session_id, idA);
       assert.equal(rec(b).already_active, undefined);
     });
   });
   ```
3. **'drains an admitted source read through detach, then refuses the old capture after reattach'** (~L653):
   - Rename it to `'drains an admitted source read through detach, then refuses the question after a capture-only reattach'`.
   - Replace the last three assertions with:
   ```ts
      const resumed = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(rec(resumed).session_id, oldId);
      const oldRetry = await call({ verb: 'ask', session_id: oldId, request_id: ASK_REQUEST, text: 'Question', context: ASK_CONTEXT });
      // The earlier connection is not carried across the resume.
      assert.equal(oldRetry.ok === false && oldRetry.code, 'AGENT_NOT_CONNECTED');
   ```
4. **'does not retarget an old ask after a daemon restart and new attach'** (~L748):
   - Rename it to `'does not accept an ask after a daemon restart and capture-only resume'`.
   - Replace `assert.notEqual(rec(fresh).session_id, oldId);` with `assert.equal(rec(fresh).session_id, oldId);`.
   - Change the expected code to `'AGENT_NOT_CONNECTED'`.

- [ ] **Step 3: Write the new failing tests**

Add a new `describe('daemon workspace resume', …)` block:

```ts
describe('daemon workspace resume', () => {
  it('resumes with a continuous seq and reconciles edits made while detached', async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      await writeFile(join(worktree, 'a.ts'), 'one');
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      assert.equal((await call({ verb: 'detach' })).ok, true);
      const before = await readLog(store, id);
      await writeFile(join(worktree, 'a.ts'), 'two');
      const again = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(rec(again).session_id, id);
      const after = await readLog(store, id);
      assert.deepEqual(after.map(e => e.seq), after.map((_, i) => String(i + 1)));
      const tail = after.slice(before.length);
      assert.equal(tail[0]!.type, 'slipstream.session.resumed.v1');
      assert.equal(tail[0]!.seq, String(before.length + 1));
      assert.ok(tail.some(e => e.type === 'slipstream.capture.gap.v1' && e.data.reason === 'restart'));
      assert.ok(tail.some(e => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.ts'));
    });
  });

  it('resumes a session recorded by a previous daemon run', async () => {
    await withResumeDaemon(async ({ store, worktree, call, restart }) => {
      await writeFile(join(worktree, 'a.ts'), 'one');
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      const before = (await readLog(store, id)).length;
      await restart();
      await writeFile(join(worktree, 'a.ts'), 'two');
      assert.equal(rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id, id);
      const after = await readLog(store, id);
      assert.equal(after[before]!.type, 'slipstream.session.resumed.v1');
      assert.ok(after.slice(before).some(e => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.ts'));
    });
  });

  it('resumes through a symlinked path to the same workspace', async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      await call({ verb: 'detach' });
      const alias = join(store, 'alias');
      await symlink(worktree, alias);
      assert.equal(rec(await call({ verb: 'attach', worktree: alias, ...IDENTITY })).session_id, id);
    });
  });

  it('resumes for a different chat and runs a fresh setup check for it', async () => {
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = rec(await attachConnected(call, worktree, store)).session_id!;
      await call({ verb: 'detach' });
      const transcriptB = join(store, 'chat-b.jsonl');
      await writeFile(transcriptB, JSON.stringify({ type: 'user', sessionId: 'chat-b', cwd: await realpath(worktree),
        version: '2.1.283', entrypoint: 'sdk-cli', userType: 'external', isSidechain: false }) + '\n');
      const b = await call({ verb: 'attach', worktree, harness: 'claude-code', harness_session_id: 'chat-b', root_transcript: transcriptB });
      assert.equal(rec(b).session_id, id);
      assert.equal(rec(b).agent_connection, 'setup_pending');
      const log = await readLog(store, id);
      const resumedAt = log.findIndex(e => e.type === 'slipstream.session.resumed.v1');
      const pending = log.slice(resumedAt).filter(e => e.type === 'slipstream.agent.connection.v1');
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0]!.data.target, { harness: 'claude-code', harness_session_id: 'chat-b' });
      const ask = await call({ verb: 'ask', session_id: id, request_id: ASK_REQUEST, text: 'Why?', context: ASK_CONTEXT });
      assert.equal(ask.ok === false && ask.code, 'AGENT_NOT_CONNECTED');
    });
  });

  it('still refuses a different chat while the workspace is being recorded', async () => {
    await withResumeDaemon(async ({ worktree, call }) => {
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const other = await call({ verb: 'attach', worktree, harness: 'codex', harness_session_id: 'other' });
      assert.equal(other.ok === false && other.code, 'SESSION_ACTIVE');
    });
  });

  it('starts a new session after the workspace\'s session was removed', async () => {
    await withResumeDaemon(async ({ worktree, call }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      await call({ verb: 'detach' });
      assert.equal((await call({ verb: 'delete_session', session_id: id })).ok, true);
      const fresh = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(fresh.ok, true);
      assert.notEqual(rec(fresh).session_id, id);
    });
  });

  it('starts a new session and warns when the only candidate has an unreadable first record', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await withResumeDaemon(async ({ store, worktree, call }) => {
      await mkdir(join(store, 'sessions', ABSENT_ID), { recursive: true });
      await writeFile(sessionLogPath(store, ABSENT_ID), '{"torn');
      const res = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(res.ok, true);
      assert.notEqual(rec(res).session_id, ABSENT_ID);
      assert.ok(errors.mock.calls.some(c => String(c.arguments[0]).includes(ABSENT_ID)));
    });
  });
});
```

Fail-closed cases. Each one asserts:
- `SESSION_RESUME_FAILED` naming the id
- no new session directory
- state `detached`
- `/v1/sessions` still reports the pre-resume `H`

```ts
describe('daemon workspace resume fails closed', () => {
  const ID = '55555555-5555-4555-8555-555555555555';
  async function expectResumeFailed(store: string, daemon: Daemon, call: Call, worktree: string, H: string): Promise<void> {
    const before = await readdir(join(store, 'sessions'));
    const res = await call({ verb: 'attach', worktree, ...IDENTITY });
    assert.equal(res.ok === false && res.code, 'SESSION_RESUME_FAILED');
    assert.match(res.ok === false ? res.message : '', new RegExp(ID));
    assert.deepEqual((await readdir(join(store, 'sessions'))).sort(), before.sort(), 'no fallback session may be minted');
    assert.equal(rec(await call({ verb: 'status' })).state, 'detached');
    assert.equal((await sessionsJson(daemon)).find(s => s.id === ID)?.durable_seq, H);
  }
  const change = (sha: string): PublicEventInput => ({ type: 'slipstream.file.baselined.v1', occurred_at_ms: 2,
    data: { path: 'f', snapshot: { kind: 'content', sha256: sha, size: 3 } } });

  it('on a corrupt record in the middle of the log', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree), [
        { type: 'slipstream.capture.scope.v1', occurred_at_ms: 2, data: {} } as PublicEventInput,
        { type: 'slipstream.capture.scope.v1', occurred_at_ms: 3, data: {} } as PublicEventInput]);
      const lines = (await readFile(sessionLogPath(store, ID), 'utf8')).split('\n');
      lines[1] = '{"seq":"2","broken":true}';
      await writeFile(sessionLogPath(store, ID), lines.join('\n'));
      await expectResumeFailed(store, daemon(), call, worktree, '3');
    });
  });

  it('on an unreadable final record', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      await writeFile(sessionLogPath(store, ID), (await readFile(sessionLogPath(store, ID), 'utf8')) + 'garbage\n');
      const res = await call({ verb: 'attach', worktree, ...IDENTITY });
      assert.equal(res.ok === false && res.code, 'SESSION_RESUME_FAILED');
      assert.match(res.ok === false ? res.message : '', new RegExp(ID));
      void daemon;
    });
  });

  it('on a missing content blob', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree), [change(HEX_DEAD)]);
      await expectResumeFailed(store, daemon(), call, worktree, '2');
    });
  });

  it('on a session lock held by another live owner', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      await writeFile(join(store, 'sessions', ID, 'owner.lock'), JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
      await expectResumeFailed(store, daemon(), call, worktree, '1');
    });
  });

  it('on a capture startup failure', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      await seedStartedSession(store, ID, await realpath(worktree));
      const failing = createFakePlatform();
      failing.watch = async () => { throw new Error('watcher refused'); };
      await restart({ captureDependencies: { platform: failing } });
      await expectResumeFailed(store, daemon(), call, worktree, '1');
    });
  });
});
```

Notes for the implementer:
- Check how `lock.ts` decides an owner is "live". If a foreign nonce with our own pid is reclaimed rather than refused, use the pid of a live child instead: `spawn('sleep', ['30'])`, killed in `finally`.
- Check the `capture.scope.v1` data shape against its schema and fill in a valid `data`. Only the corruption of line 2 matters.
- **Root mismatch** is not reachable through attach once the lookup has matched on the stored root. The same `startCapture` throw path is exercised by the startup-failure case. Say so in the PR body rather than fabricating a race.

Reader followers and the activation race:

```ts
describe('daemon workspace resume and readers', () => {
  it('a follower on the stopped session reconnects and receives every post-resume record once', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      await call({ verb: 'detach' });
      const H = (await readLog(store, id)).length;
      let opened!: () => void; const isOpen = new Promise<void>(r => { opened = r; });
      const first = follow(daemon(), id, String(H), () => false, opened);
      await isOpen;
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const seen = await first; // ended by the freeze/activate abort
      const last = seen.at(-1) ?? String(H);
      const N = (await readLog(store, id)).length;
      const rest = await follow(daemon(), id, last, ids => ids.at(-1) === String(N));
      const all = [...seen, ...rest];
      assert.deepEqual(all, Array.from({ length: N - H }, (_, i) => String(H + 1 + i)));
    });
  });

  it('a follower of a session from a previous daemon run also sees the resume', async () => {
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      await restart();
      const H = (await readLog(store, id)).length;
      let opened!: () => void; const isOpen = new Promise<void>(r => { opened = r; });
      const first = follow(daemon(), id, String(H), () => false, opened);
      await isOpen;
      await call({ verb: 'attach', worktree, ...IDENTITY });
      const seen = await first;
      const N = (await readLog(store, id)).length;
      const rest = await follow(daemon(), id, seen.at(-1) ?? String(H), ids => ids.at(-1) === String(N));
      assert.deepEqual([...seen, ...rest], Array.from({ length: N - H }, (_, i) => String(H + 1 + i)));
    });
  });

  it('a finite read during the resume never goes past the pinned boundary', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    const failing = { platform: createFakePlatform() };
    // Hold capture startup inside the watch call: the boundary is already pinned.
    failing.platform.watch = (orig => async (o: WatchOptions) => { entered(); await gate; return orig(o); })(failing.platform.watch.bind(failing.platform));
    await withResumeDaemon(async ({ store, worktree, call, daemon, restart }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      await call({ verb: 'detach' });
      const H = String((await readLog(store, id)).length);
      await restart({ captureDependencies: failing });
      const attachP = call({ verb: 'attach', worktree, ...IDENTITY });
      await entering;
      assert.equal((await sessionsJson(daemon())).find(s => s.id === id)?.durable_seq, H);
      release();
      assert.equal((await attachP).ok, true);
    });
  });
});
```

The `failing.platform.watch` wrapping assumes `createFakePlatform().watch` is a plain method on the returned object. If it is not, wrap it with an object spread instead: `{ ...p, watch: … }`.

Maintenance concurrency, shutdown and the `begin_task` race all use the `workspaceLookup` seam or the existing `identityRealpath` seam:

```ts
describe('daemon workspace resume concurrency', () => {
  function heldLookup() {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    let hold = true;
    const workspaceLookup: typeof findWorkspaceSession = async (s, r) => {
      if (hold) { hold = false; entered(); await gate; }
      return findWorkspaceSession(s, r);
    };
    return { workspaceLookup, release, entering };
  }

  it('refuses delete_session and gc while an attach is still looking up the workspace', async () => {
    const held = heldLookup();
    await withResumeDaemon(async ({ worktree, call }) => {
      const attachP = call({ verb: 'attach', worktree, ...IDENTITY });
      await held.entering;
      const del = await call({ verb: 'delete_session', session_id: ABSENT_ID });
      assert.equal(del.ok === false && del.code, 'SESSION_ACTIVE');
      const gc = await call({ verb: 'gc' });
      assert.equal(gc.ok === false && gc.code, 'SESSION_ACTIVE');
      held.release();
      assert.equal((await attachP).ok, true);
    }, { workspaceLookup: held.workspaceLookup });
  });

  it('shutdown waits for an attach that is still looking up the workspace, and nothing starts', async () => {
    const held = heldLookup();
    await withResumeDaemon(async ({ store, worktree, call, daemon }) => {
      const attachP = call({ verb: 'attach', worktree, ...IDENTITY }).catch(err => err);
      await held.entering;
      let stopped = false;
      const stopP = daemon().stop().then(() => { stopped = true; });
      await new Promise(r => setTimeout(r, 25));
      assert.equal(stopped, false, 'shutdown must wait for the in-flight lookup');
      held.release();
      await stopP;
      await attachP;
      assert.deepEqual(await readdir(join(store, 'sessions')).catch(() => []), []);
    }, { workspaceLookup: held.workspaceLookup });
  });

  it('refuses a begin_task that straddles a detach and resume of the same session', async () => {
    let hold = false;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    await withResumeDaemon(async ({ store, worktree, call }) => {
      const id = rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id!;
      hold = true;
      const stale = call({ verb: 'begin_task', title: 'Old', request_id: 'r-old', worktree, ...IDENTITY });
      await entering;
      await call({ verb: 'detach' });
      assert.equal(rec(await call({ verb: 'attach', worktree, ...IDENTITY })).session_id, id);
      release();
      const res = await stale;
      assert.equal(res.ok === false && res.code, 'SESSION_NOT_SELECTED');
      assert.equal((await readLog(store, id)).filter(e => e.type === 'slipstream.task.started.v1').length, 0);
    }, { identityRealpath: async (p) => {
      if (hold) { hold = false; entered(); await gate; }
      return realpath(p);
    } });
  });
});
```

Notes:
- `readdir` must be imported from `node:fs/promises`.
- In the shutdown test, `withResumeDaemon`'s `finally` calls `daemon.stop()` again. It is `.catch`-guarded, and stopping twice must be harmless. If it is not, track a `stopped` flag in the helper.

- [ ] **Step 4: Run them to verify they fail**

Run: `node --test --test-concurrency=1 src/daemon.test.ts`
Expected: FAIL. The rewritten tests see a new id, `SESSION_RESUME_FAILED` is unknown, and the `workspaceLookup` option has no effect.

- [ ] **Step 5: Add the error code**

In `src/control-protocol.ts`:
- Add `| 'SESSION_RESUME_FAILED'` to `ControlErrorCode`.
- Add a sentence to the doc comment above it:
  > `SESSION_RESUME_FAILED`: attach found the workspace's existing session but could not resume it; the message names the session and whether to retry or restore/delete it. Attach never falls back to a new session.

- [ ] **Step 6: Implement the daemon changes**

In `src/daemon.ts`:

Imports:
- Change the store-reader import to `import { isValidSessionId, listSessions, findWorkspaceSession, WorkspaceLookupError } from './store-reader.ts';`
- Add `import { CorruptLogError } from './recovery.ts';`
- Add `import { LogCorruptError } from './log-reader.ts';`
- Skip any import that already exists.

In `DaemonOptions`, add after `identityRealpath`:

```ts
  /** Allows an attach's workspace lookup to be held deterministically. */
  workspaceLookup?: typeof findWorkspaceSession;
```

Next to `const identityRealpath = …` (L181), add: `const workspaceLookup = opts.workspaceLookup ?? findWorkspaceSession;`

Replace `attach` from `state = 'attaching';` to the end of the function with:

```ts
    // Set attaching BEFORE the first await so a concurrent attach is refused.
    state = 'attaching';
    sessionCompromised = false;
    const p = resolveAndStart(req);
    attachInFlight = p;
    try {
      return await p;
    } finally {
      if (attachInFlight === p) attachInFlight = undefined;
    }
  }

  /** Canonicalize the worktree, find its existing session, and start or resume
   * capture. Runs entirely inside `attachInFlight`, so shutdown and maintenance
   * wait for the lookup as well as the startup. */
  async function resolveAndStart(req: RequestEnvelope): Promise<Record<string, unknown> | ErrorFields> {
    const abandon = (fields: ErrorFields): ErrorFields => {
      if (state === 'attaching') state = 'detached';
      return fields;
    };
    let worktree: string;
    try {
      // Canonicalize before binding and before lookup: capture resolves the root
      // with realpath, so a symlinked or relative path must name the same root.
      worktree = await realpath(req.worktree as string);
    } catch (err) {
      return abandon(errFields('CAPTURE_NOT_READY', (err as Error).message));
    }
    let lookup;
    try {
      lookup = await workspaceLookup(storeDir, worktree);
    } catch (err) {
      if (err instanceof WorkspaceLookupError) {
        return abandon(errFields('SESSION_RESUME_FAILED', `${err.message}. ${corruptRemedy(err.sessionId)}`));
      }
      return abandon(errFields('STORAGE_UNAVAILABLE', `could not look up this workspace's session: ${(err as Error).message}`));
    }
    for (const s of lookup.skipped) {
      console.error(`slipstream daemon: skipped session ${s.id} while looking for ${worktree}'s session: ${s.reason}`);
    }
    if (torn || compromised || sessionCompromised || state !== 'attaching') {
      return abandon(errFields('STORAGE_UNAVAILABLE', 'daemon could not complete the attach'));
    }
    const identity = [req.harness as string, req.harness_session_id as string, req.root_transcript as string | undefined] as const;
    if (lookup.match) {
      const { id, durableSeq } = lookup.match;
      // Pin the boundary at the durable high-water BEFORE the log can grow, and
      // hold it until activation: readers never see past it mid-resume.
      registry.freeze(id, registry.get(id)?.boundary.current() ?? durableSeq);
      return startAndActivate(id, true, worktree, ...identity);
    }
    const id = randomUUID();
    // Reserve the registry entry (boundary 0) before startCapture creates the log
    // dir on disk, so the reader never over-publishes an uncommitted record.
    registry.reserve(id);
    return startAndActivate(id, false, worktree, ...identity);
  }
```

Add next to `errFields` at the end of the file:

```ts
function corruptRemedy(id: string): string {
  return `Restore its data, or remove it with \`slipstream delete ${id}\` (this discards that history)`;
}
```

Change `startAndActivate`'s signature to:

```ts
  async function startAndActivate(
    id: string,
    resume: boolean,
    resolvedWorktree: string,
    harness: string,
    harnessSessionId: string,
    rootTranscript?: string,
  ): Promise<Record<string, unknown> | ErrorFields> {
```

Inside `startAndActivate`:
- Delete the `let resolvedWorktree: string;` declaration, the realpath line, and its comment (they moved to `resolveAndStart`).
- In the `startCapture` options, replace `sessionId: id,` with `...(resume ? { resumeSessionId: id } : { sessionId: id }),`.
- Replace the `catch` block with:

```ts
    } catch (err) {
      // A fresh session never activated: freeze at 0, never delete the entry, so
      // the reader cannot fall back to disk for a half-written log. A resumed
      // session keeps the boundary pinned at its pre-resume high-water.
      if (!resume) registry.freeze(id, 0n);
      if (state === 'attaching') state = 'detached';
      if (err instanceof RootIdentityError) return errFields('IDENTITY_UNRESOLVED', err.message);
      if (resume) {
        const remedy = err instanceof CorruptLogError || err instanceof LogCorruptError
          ? corruptRemedy(id)
          : `Retry attach; if it keeps failing, ${corruptRemedy(id).toLowerCase()}`;
        return errFields('SESSION_RESUME_FAILED', `could not resume session ${id}: ${(err as Error).message}. ${remedy}`);
      }
      if (err instanceof StorageError) return errFields('STORAGE_UNAVAILABLE', err.message);
      return errFields('CAPTURE_NOT_READY', (err as Error).message);
    }
```

The rest of `startAndActivate` is unchanged. Its abort path freezes at `health` durable seq, and activation is as today.

In `beginTask`:
- Capture the binding before the await: `const binding = current;`, placed immediately before the `let declaredWorktree` line.
- Change `declaredWorktree = await realpath(req.worktree);` to `declaredWorktree = await identityRealpath(req.worktree);`.
- Change the post-await check `if (state !== 'active' || !current) {` to `if (state !== 'active' || !current || current !== binding) {`.
- Update its comment to mention that an id can now come back to life, so the binding reference, not the id, is compared.

- [ ] **Step 7: Run the daemon suite and the full suite**

Run: `node --test --test-concurrency=1 src/daemon.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

Some existing tests may still encode "fresh id per attach", for example asserting an empty connection-event list for a re-attach of the same worktree. Rewrite each one to the resume behaviour, and list it in the commit message body. Never delete or skip one.

The claim-race test at ~L157 should still pass unchanged:
- Its second `ask` now replays as `duplicate: true` into the same session.
- It still expects zero dispatch attempts.

If it fails, adjust only the assertions that depend on the ids differing.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/control-protocol.ts src/daemon.ts src/daemon.test.ts
git commit -m "feature: re-attaching a workspace continues its existing recording"
```

---

### Task 5: QA harness readiness on a resumed session

**Files:**
- Modify: `tools/qa-daemon.ts` (~L316–334)
- Test: `tools/qa/harness-proc.test.ts` (~L66)

**Interfaces:**
- Consumes: the attach behaviour from Task 4. A `--reuse` run with a new `harness_session_id` now resumes the retained session.

- [ ] **Step 1: Update the test to the new behaviour**

In `tools/qa/harness-proc.test.ts`, replace

```ts
        // --reuse starts a fresh session against the retained store.
        assert.notEqual(reuse.env.session_id, sessionA);
```

with

```ts
        // --reuse resumes the workspace's retained session (one stream per workspace).
        assert.equal(reuse.env.session_id, sessionA);
```

- [ ] **Step 2: Run it**

Run: `node --test --test-concurrency=1 tools/qa/harness-proc.test.ts`

Possible results:
- It fails on the `equal` assertion, or `ready_through_seq` points before the resume records. Continue to Step 3.
- It passes outright. Still do Step 3: readiness must not be the pre-resume baseline.

- [ ] **Step 3: Make readiness use the post-resume position**

In `tools/qa-daemon.ts`, after `const sessionId = attach.session_id as string;`, read the attach-time durable position. Attach returns only after startup and reconciliation have committed.

```ts
    const attachedStatus = await sendControlRequest({ socketPath: daemon.socketPath, request: { v: 1, verb: 'status' } });
    const attachedThrough = attachedStatus.ok ? BigInt(String((attachedStatus as Record<string, unknown>).durable_seq ?? '0')) : 0n;
```

Then:
- Replace `let readyThroughSeq = baseline.durableSeq;` with
  `let readyThroughSeq = baseline.durableSeq > attachedThrough ? baseline.durableSeq : attachedThrough;`
- Pass `after: baseline.seq > attachedThrough ? baseline.seq : attachedThrough` to `scenario.seed`.

On a fresh session `attachedThrough ≤ baseline.durableSeq`, so nothing changes. On a resumed one, scenario seeding looks only past the resume.

Check the types of `baseline.seq` and `baseline.durableSeq` first. If either is a string, convert with `BigInt(...)` before comparing.

In the `harness-proc` test, add after the `equal` assertion:

```ts
        assert.ok(BigInt(reuse.env.ready_through_seq) > BigInt(keep.env.ready_through_seq),
          'a resumed run is ready only past its resume records');
```

- [ ] **Step 4: Run the tools suite**

Run: `npm run test:tools`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/qa-daemon.ts tools/qa/harness-proc.test.ts
git commit -m "chore: let the QA harness reuse a resumed recording"
```

---

### Task 6: Contract, skill, schema descriptions, plan status

**Files:**
- Modify: `docs/ask-agent/contract.md` (L46–55, L105, ~L373, L388–442)
- Modify: `SKILL.md` (L24–25)
- Modify: `schemas/slipstream.capture.gap.v1.json` (the `reason` property, ~L58)
- Modify: `schemas/slipstream.session.resumed.v1.json` (`$comment`, L5)
- Modify: `IMPLEMENTATION_PLAN.md` (append a section after A5)

- [ ] **Step 1: Schemas (descriptions only; no structural change)**

In `schemas/slipstream.capture.gap.v1.json`, add to the `reason` property object, beside `enum`:

```json
          "$comment": "restart: the daemon did not watch this session for an unknown interval — a daemon restart, or a re-attach after a detach. Reconciliation afterwards reports observed states, not the edits in between."
```

In `schemas/slipstream.session.resumed.v1.json`, replace the `$comment` value with:

```
"Recorded at recovered_through_seq + 1 when capture of an existing session resumes (daemon restart or re-attach). It resets live state: there is no current task until a new task.started, questions queued before it are never claimable again, and any earlier agent.connection record is stale. Self-contained; unknown fields permitted for forward compatibility."
```

Run: `node --test --test-concurrency=1 src/**/schema*.test.ts`. If no such file exists, run `npm test`. The schemas must still compile.

- [ ] **Step 2: Contract**

In `docs/ask-agent/contract.md`, make these edits:

1. **L105 bullet** ("A full daemon restart/detach/new attach makes the old queue ineligible…"). Replace it with:
   > A detach, daemon restart or new attach makes the queue ineligible. Re-attaching the same workspace resumes the same capture `session_id`, but questions queued before the resume are never claimable again (`session.resumed` resets eligibility); nothing is migrated and no dispatch attempt is fabricated. A retry of a pre-resume `request_id` on the resumed capture replays its original acceptance with `duplicate: true`, but that question will not be delivered; ask again with a new `request_id`. A retry addressed to a capture that is no longer selected returns `SESSION_NOT_SELECTED`.
2. **The "in-process storage recovery" bullet** (L104). Replace "even though daemon restart creates a new capture" with "and never makes a question queued before the latest `session.resumed` claimable".
3. **~L373.** Replace "A detach, daemon restart or new attach ends the capture; a late answer to an old question gets `SESSION_NOT_SELECTED` and the old log stays readable." with:
   > A detach or daemon restart ends the capture; an answer sent while no capture is selected gets `SESSION_NOT_SELECTED`. If the same chat re-attaches the same workspace, the capture resumes and an answer to a question already delivered to that chat is still recorded.
4. **Agent readiness section.** After the list item "Until then, `ask` returns `AGENT_NOT_CONNECTED`…", add:
   > - A resumed capture never inherits a connection. Its `session.resumed` record makes every earlier `slipstream.agent.connection.v1` record stale, and a log consumer must treat connection state from before the latest `session.resumed` as unknown. The attaching chat, which may differ from the earlier one, goes through a fresh setup check.
5. **The `capture_not_live` paragraph.** Change "detached, replaced, removed and pre-readiness recordings; old logs stay readable and their questions stay bound to them." to "detached, removed and pre-readiness recordings; their logs stay readable."
6. **The attach-idempotency paragraph.** Append:
   > `attach` from a detached daemon resumes the workspace's existing session: the newest non-removed session whose `session.started` root equals the canonical worktree. The `session_id` is unchanged and `seq` continues after a `session.resumed` record and a `capture.gap` with reason `restart`. A new session is created only when the workspace has none. A session whose first record cannot be read is skipped with a daemon-log warning. If the selected session cannot be resumed (its lock is held, storage fails, or its history is corrupt), attach returns `SESSION_RESUME_FAILED` naming the session and never starts a second one. Retry for a lock or storage problem; restore the data, or `slipstream delete <session-id>` to discard that history, for corruption. A resumed capture has no current task until the agent calls `begin_task` again.
7. **Error-code lists.** Where the attach error codes are enumerated, add `SESSION_RESUME_FAILED`. Find them with `grep -n "SESSION_ACTIVE" docs/ask-agent/contract.md`. `ask` and `answer` cannot return it, so do not add it to `AskRejected` or `AnswerRejected`.

- [ ] **Step 3: SKILL.md**

Replace L24–25:

```markdown
Do **not** call it for every individual edit, and do not re-call it to "resume"
a task you already declared — one declaration per task is enough. The one
exception: after `slipstream attach` runs again for this workspace, declare
your current task again. A new attach starts with no current task.
```

- [ ] **Step 4: IMPLEMENTATION_PLAN.md status**

Append after the A5 section:

```markdown
## W1: One stream per workspace (2026-10-14)

**Goal:** `attach` resumes the workspace's existing non-removed session (same
id, continuous `seq`) instead of minting a new one. A fresh session is created
only when the workspace has none.
Spec: `docs/superpowers/specs/2026-10-14-workspace-stream-resume-design.md`.
Plan: `docs/superpowers/plans/2026-10-14-workspace-stream-resume.md`.

**Status**: In Progress — implementation complete on
`briankeane/daemon-workspace-stream-resume`; awaiting review.
```

Set the status to "Complete" only after the PR merges.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run test:tools && npm run typecheck`
Expected: all PASS.

```bash
git add docs/ask-agent/contract.md SKILL.md schemas/slipstream.capture.gap.v1.json schemas/slipstream.session.resumed.v1.json IMPLEMENTATION_PLAN.md
git commit -m "chore: document that re-attaching continues the workspace's recording"
```

---

## After the tasks (whole-branch gates, per CLAUDE.md)

1. Touched-area regression:
   - Run `npm test`, `npm run test:tools` and `npm run typecheck` on the final branch.
   - Run `npm run lint` if `package.json` defines it.
2. Cross-layer contract trace:
   - Confirm `SESSION_RESUME_FAILED` flows unchanged through `src/control-client.ts`, the CLI and `src/attach-workflow.ts`. They print `code: message` generically; no client change.
   - Confirm `/v1/sessions` output is byte-identical in shape.
3. Codex gates:
   - **review** mode on the branch diff.
   - Then **challenge** and the **Excess Audit**, concurrently in the background.
   - Adjudicate, then apply one fix wave.
4. PR: open it via `codex exec` against `develop`. Then run fix-review via `codex exec`.
