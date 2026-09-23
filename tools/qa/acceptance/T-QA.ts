/**
 * T-QA acceptance: prove the QA harness itself against a LIVE daemon.
 *
 * Criteria 1–4 run against the primary daemon the runner started (via `ctx`):
 * descriptor usability + auth, a real create→modify→delete lifecycle with exact
 * bytes, finite/SSE agreement + reconnect, and a negative control that MUST time
 * out. Criteria 5–8 concern qa-daemon lifecycle and safety, so the module spawns
 * its own qa-daemon children and observes them as real processes.
 *
 * Every claim that fails throws with actual-vs-expected detail; the runner turns
 * that into a failed check. The bearer token is never placed in evidence.
 */
import { writeFile, rm, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createReaderClient,
  awaitObservedChange,
  DurabilityTimeoutError,
  FILE_CHANGED_TYPE,
  type ReaderClient,
  type Assertion,
} from '../../qa-support.ts';
import { defaultDaemonStore, controlSocketPath } from '../../../src/daemon-location.ts';
import { startQaDaemon, runQaDaemonToExit } from '../harness-proc.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

function fail(msg: string): never {
  throw new Error(msg);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Collect SSE seqs from `after`, stopping when a seq ≥ `target` arrives or the
 * deadline elapses. Every frame's SSE `id` must equal the `seq` inside its own
 * data payload — the id is a resume token, so a stream that advertised a resume
 * position different from the event it carried would corrupt reconnection; a
 * disagreement fails the check. Aborts with the runner's `outer` signal too. */
async function collectSseSeqs(
  reader: ReaderClient,
  sessionId: string,
  after: bigint,
  target: bigint,
  deadlineMs: number,
  outer: AbortSignal,
): Promise<bigint[]> {
  const ctl = new AbortController();
  const onOuter = (): void => ctl.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  const seqs: bigint[] = [];
  let mismatch: string | null = null;
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    await reader.follow(sessionId, after, ctl.signal, (frame) => {
      if (frame.id === undefined) return;
      const id = BigInt(frame.id);
      const payloadSeq = (JSON.parse(frame.data) as { seq?: string }).seq;
      if (payloadSeq === undefined || BigInt(payloadSeq) !== id) {
        mismatch = `SSE frame id ${frame.id} disagreed with its data.seq ${String(payloadSeq)}`;
        ctl.abort();
        return;
      }
      seqs.push(id);
      if (id >= target) ctl.abort();
    });
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
  if (mismatch !== null) fail(mismatch);
  return seqs;
}

// --- Criteria 1–4: against the primary daemon (ctx) -------------------------

async function criterion1(ctx: AcceptanceContext): Promise<Assertion> {
  const sessions = await ctx.reader.sessions();
  if (!sessions.some((s) => s.id === ctx.sessionId)) {
    fail(`authenticated /v1/sessions did not list the attached session ${ctx.sessionId}; got ${JSON.stringify(sessions.map((s) => s.id))}`);
  }
  const unauth = await ctx.reader.raw('/v1/sessions', { auth: false });
  if (unauth.status !== 401) fail(`unauthenticated /v1/sessions returned ${unauth.status}, expected 401`);
  return {
    id: 'descriptor-and-auth',
    claim: 'fresh startup published a usable descriptor: authenticated /v1/sessions lists the session and unauthenticated access is 401',
    evidence: { sessions: sessions.length, unauthenticated_status: unauth.status },
  };
}

async function criterion2(ctx: AcceptanceContext): Promise<Assertion> {
  // A unique name per run makes the check safe under `--reuse`, where a fixed
  // name would already carry history and the `absent → content` create could
  // never be observed.
  const rel = `lifecycle-${randomUUID()}.txt`;
  const abs = join(ctx.worktree, rel);
  const v1 = Buffer.from('one\n', 'utf8');
  const v2 = Buffer.from('one two three\n', 'utf8');
  const short = { deadlineMs: 20_000, signal: ctx.signal };
  // Anchor on the durable high-water BEFORE the first write so the create match
  // cannot bind to a stale earlier record.
  const start = (await ctx.reader.finite(ctx.sessionId, 0n)).durableSeq;

  await writeFile(abs, v1);
  const created = await awaitObservedChange(ctx.reader, ctx.sessionId,
    { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes: v1 } }, start, short);

  await writeFile(abs, v2);
  const modified = await awaitObservedChange(ctx.reader, ctx.sessionId,
    { relPath: rel, before: { kind: 'content', bytes: v1 }, after: { kind: 'content', bytes: v2 } }, created.seq, short);

  await rm(abs);
  const deleted = await awaitObservedChange(ctx.reader, ctx.sessionId,
    { relPath: rel, before: { kind: 'content', bytes: v2 }, after: { kind: 'absent' } }, modified.seq, short);

  if (deleted.after.kind !== 'absent') fail(`final lifecycle state was ${deleted.after.kind}, expected absent`);
  return {
    id: 'create-modify-delete',
    claim: 'a real create→modify→delete produced three acknowledged states with exact hashes/bytes and a final absent state',
    evidence: {
      created_seq: created.seq.toString(),
      modified_seq: modified.seq.toString(),
      deleted_seq: deleted.seq.toString(),
      final_state: deleted.after.kind,
    },
  };
}

async function criterion3(ctx: AcceptanceContext): Promise<Assertion> {
  const finite = await ctx.reader.finite(ctx.sessionId, 0n);
  const H = finite.durableSeq;
  const finiteSeqs = finite.events.map((e) => BigInt(e.seq as string)).sort(cmp);
  if (finiteSeqs.length === 0) fail('finite replay returned no events to compare against SSE');

  // Full parity: SSE from 0 must REACH the durable high-water H and carry exactly
  // the finite identities up to H — not merely agree on whatever prefix it managed.
  const sse = await collectSseSeqs(ctx.reader, ctx.sessionId, 0n, H, 8_000, ctx.signal);
  const sseMax = maxOf(sse) ?? 0n;
  if (sseMax < H) fail(`SSE stream did not reach the durable high-water ${H}; it stopped at ${sseMax}`);
  const finiteUpToH = finiteSeqs.filter((s) => s <= H);
  const sseUpToH = [...new Set(sse.filter((s) => s <= H))].sort(cmp);
  if (!seqArraysEqual(finiteUpToH, sseUpToH)) {
    fail(`finite replay and SSE disagree up to durable high-water ${H}: finite=${finiteUpToH.join(',')} sse=${sseUpToH.join(',')}`);
  }

  // Reconnect after a mid-stream cursor; the stream must deliver the FULL suffix —
  // every finite identity greater than the cursor — and nothing at or below it.
  const cursor = finiteSeqs[0]!;
  const resumed = await collectSseSeqs(ctx.reader, ctx.sessionId, cursor, H, 8_000, ctx.signal);
  if (resumed.some((s) => s <= cursor)) {
    fail(`SSE reconnect after cursor ${cursor} delivered a seq at or below the cursor: ${resumed.join(',')}`);
  }
  const expectedSuffix = finiteSeqs.filter((s) => s > cursor && s <= H);
  const resumedSuffix = [...new Set(resumed.filter((s) => s <= H))].sort(cmp);
  if (!seqArraysEqual(expectedSuffix, resumedSuffix)) {
    fail(`SSE reconnect did not deliver the full suffix after cursor ${cursor}: expected=${expectedSuffix.join(',')} got=${resumedSuffix.join(',')}`);
  }
  return {
    id: 'finite-sse-agreement',
    claim: 'finite replay and SSE agree on every observed identity up to the durable high-water, and an SSE reconnect delivers the full suffix strictly after the applied cursor',
    evidence: {
      durable_seq: H.toString(),
      identities: finiteUpToH.length,
      reconnect_after: cursor.toString(),
      suffix_delivered: resumedSuffix.length,
    },
  };
}

async function criterion4(ctx: AcceptanceContext): Promise<Assertion> {
  const rel = `negative-control-${randomUUID()}.txt`;
  const abs = join(ctx.worktree, rel);
  const real = Buffer.from('the real bytes\n', 'utf8');
  const wrong = Buffer.from('bytes that were never written\n', 'utf8');
  const cursor = (await ctx.reader.finite(ctx.sessionId, 0n)).durableSeq;

  await writeFile(abs, real);

  // Positive control first: the write IS captured with its REAL bytes. Without
  // this, a timeout could mean "wrong hash" OR "watcher is dead" — and a dead
  // watcher would make the negative control pass vacuously. Proving the real
  // change is durable establishes that the later timeout is the wrong hash alone.
  await awaitObservedChange(ctx.reader, ctx.sessionId,
    { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes: real } },
    cursor, { deadlineMs: 20_000, signal: ctx.signal });

  let timedOut = false;
  try {
    // Same durable change, but assert a WRONG expected after-hash: the matcher
    // must never match — it must hit the deadline.
    await awaitObservedChange(ctx.reader, ctx.sessionId,
      { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes: wrong } },
      cursor, { deadlineMs: 3_000, signal: ctx.signal });
  } catch (err) {
    if (err instanceof DurabilityTimeoutError) timedOut = true;
    else throw err;
  }
  if (!timedOut) fail('negative control did NOT time out: the checker matched a state it should not have — the proof is unsound');
  return {
    id: 'negative-control',
    claim: 'with capture proven live, an intentionally unmatched expected hash hits the deadline and FAILS rather than reporting ready',
    evidence: { positive_ack: true, timed_out: true, deadline_ms: 3_000 },
  };
}

// --- Criteria 5–8: qa-daemon lifecycle and safety (own children) ------------

async function criterion5(): Promise<Assertion> {
  const root = await freshRoot();
  let handle: Awaited<ReturnType<typeof startQaDaemon>> | null = null;
  try {
    handle = await startQaDaemon({ root });
    const { store, url, token, session_id, descriptor_path } = handle.env;
    const reader = createReaderClient(url, token);
    if ((await reader.raw('/v1/sessions')).status !== 200) fail('daemon reader was not live before shutdown');
    const socket = controlSocketPath(store);

    await handle.stop();
    handle = null; // stopped as the check intends; nothing left for finally to kill

    const rootGone = !(await exists(root));
    const descriptorGone = !(await exists(descriptor_path));
    const socketGone = !(await exists(socket));
    const readerClosed = await isConnectionRefused(url, token, session_id);
    if (!rootGone) fail(`default cleanup did not remove the owned root ${root}`);
    if (!descriptorGone) fail(`descriptor ${descriptor_path} survived shutdown`);
    if (!socketGone) fail(`control socket ${socket} survived shutdown`);
    if (!readerClosed) fail('reader still answered after shutdown; it was not closed');
    return {
      id: 'ctrl-c-cleanup',
      claim: 'Ctrl-C closes the reader, removes its descriptor and control socket, and default cleanup removes the owned root',
      evidence: { root_removed: rootGone, descriptor_removed: descriptorGone, socket_removed: socketGone, reader_closed: readerClosed },
    };
  } finally {
    if (handle) await handle.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function criterion6(): Promise<Assertion> {
  const root = await freshRoot();
  try {
    // --keep retains artifacts after shutdown.
    const a = await startQaDaemon({ root, scenario: 'T-QA', keep: true });
    const sessionA = a.env.session_id;
    await a.stop();
    if (!(await exists(root))) fail('--keep did not retain the root after shutdown');

    // --reuse starts a fresh daemon + new session while retained history stays readable.
    const b = await startQaDaemon({ root, reuse: true });
    const sessionB = b.env.session_id;
    try {
      if (sessionA === sessionB) fail(`--reuse advertised the same session ${sessionA}; a fresh session was expected`);
      const reader = createReaderClient(b.env.url, b.env.token);
      const sessions = await reader.sessions();
      const ids = sessions.map((s) => s.id);
      if (!ids.includes(sessionA)) fail(`retained history for session ${sessionA} was not readable via the reused daemon; saw ${JSON.stringify(ids)}`);
      if (!ids.includes(sessionB)) fail(`reused daemon did not list its new session ${sessionB}`);
      // The retained session's events are still publicly served.
      const retained = await reader.finite(sessionA, 0n);
      if (!retained.events.some((e) => e.type === FILE_CHANGED_TYPE)) {
        fail(`retained session ${sessionA} served no file.changed history after reuse`);
      }
      return {
        id: 'keep-and-reuse',
        claim: '--keep retains artifacts; --reuse starts a new session with a refreshed descriptor while retained history stays publicly readable',
        evidence: { session_a: sessionA, session_b: sessionB, distinct_sessions: true, retained_history_readable: true },
      };
    } finally {
      await b.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function criterion7(): Promise<Assertion> {
  const root = await freshRoot();
  let first: Awaited<ReturnType<typeof startQaDaemon>> | null = null;
  try {
    first = await startQaDaemon({ root });
    // A second invocation against the active root must be refused, non-zero.
    const second = await runQaDaemonToExit({ root });
    if (second.code === 0) fail('a second invocation against the active QA root exited 0; it should have been refused');

    // The first daemon is undisturbed.
    const reader = createReaderClient(first.env.url, first.env.token);
    if ((await reader.raw('/v1/sessions')).status !== 200) fail('the first daemon stopped answering after a refused second invocation');
    return {
      id: 'second-invocation-refused',
      claim: 'a second invocation against an active QA root fails without disrupting the first daemon',
      evidence: { second_exit_code: second.code, first_still_live: true },
    };
  } finally {
    if (first) await first.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function criterion8(): Promise<Assertion> {
  const realStore = defaultDaemonStore();
  const realExistedBefore = await exists(realStore);

  const direct = await runQaDaemonToExit({ root: realStore });
  if (direct.code === 0) fail(`qa-daemon accepted --root ${realStore} (the real store); it must refuse it`);
  if (!/overlaps the real daemon store/.test(direct.stderr)) {
    fail(`refusal of --root ${realStore} did not cite the real-store overlap; stderr: ${direct.stderr.trim()}`);
  }

  const overlapping = join(realStore, 'qa-sub');
  const nested = await runQaDaemonToExit({ root: overlapping });
  if (nested.code === 0) fail(`qa-daemon accepted --root ${overlapping} overlapping the real store; it must refuse it`);

  // Never touched: if the real store did not exist, the refusal must not have created it.
  const realExistsAfter = await exists(realStore);
  if (!realExistedBefore && realExistsAfter) fail(`refusing --root ${realStore} nonetheless created it`);
  if (await exists(overlapping)) fail(`refusing --root ${overlapping} nonetheless created it`);
  return {
    id: 'refuse-real-store',
    claim: 'the harness refuses --root ~/.slipstream and overlapping paths and never touches them',
    evidence: { real_store_exit: direct.code, overlapping_exit: nested.code, real_store_untouched: true },
  };
}

// --- helpers ----------------------------------------------------------------

function cmp(a: bigint, b: bigint): number { return a < b ? -1 : a > b ? 1 : 0; }
function maxOf(xs: bigint[]): bigint | null { return xs.length ? xs.reduce((m, x) => (x > m ? x : m)) : null; }
function seqArraysEqual(a: bigint[], b: bigint[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function freshRoot(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'slipstream-qa-tqa-')), 'root');
}

/** True if the reader URL now refuses connections (daemon stopped). */
async function isConnectionRefused(url: string, token: string, sessionId: string): Promise<boolean> {
  try {
    const reader = createReaderClient(url, token);
    await reader.raw(`/v1/sessions/${sessionId}/events?after=0`);
    return false;
  } catch {
    return true;
  }
}

export const tqa: AcceptanceModule = {
  id: 'T-QA',
  requiresPlatform: 'darwin',
  async run(ctx) {
    const assertions: Assertion[] = [];
    assertions.push(await criterion1(ctx));
    assertions.push(await criterion2(ctx));
    assertions.push(await criterion3(ctx));
    assertions.push(await criterion4(ctx));
    assertions.push(await criterion5());
    assertions.push(await criterion6());
    assertions.push(await criterion7());
    assertions.push(await criterion8());
    return { assertions };
  },
};
