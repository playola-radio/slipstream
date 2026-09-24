/**
 * T5b.1 acceptance: the shared bounded projection-admission budget, proven from
 * two angles.
 *
 * LIVE claims drive real source changes through a live qa-daemon and read the
 * clip projection the PUBLIC reader serves at
 * `GET /v1/sessions/{id}/changes/{seq}/clips`. They prove the clip service still
 * computes real projections after being migrated onto the shared budget, that the
 * cache/coalescing path is preserved (a repeated read is byte-identical), and —
 * the reason the budget exists — that a burst of clip reads does NOT starve
 * capture: a file written during the burst is still observed on the events feed.
 *
 * FIXTURE claims run the shipped checker (`projection-check.ts admission`) as a
 * child process against the REAL budget module: one saturates it and requires the
 * invariants to hold while overload and timeouts actually occur; the other is a
 * negative control that feeds a fabricated trace whose active work exceeds C and
 * requires the checker to REJECT it (exit 1). The negative control is what makes
 * the saturation pass meaningful — it shows the checker's teeth are real.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  awaitObservedChange,
  type Assertion,
  type ReaderClient,
} from '../../qa-support.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

const CHECKER = fileURLToPath(new URL('../../projection-check.ts', import.meta.url));

function fail(msg: string): never {
  throw new Error(msg);
}

interface ClipProjection {
  change_seq: string;
  projection_version: string;
  status: string;
  fallback_reason?: string;
  clips: unknown[];
}

/** GET the public clip projection for a change; require HTTP 200 and a
 * well-formed envelope stamped with the requested seq. */
async function getClips(reader: ReaderClient, sessionId: string, seq: string, signal: AbortSignal): Promise<ClipProjection> {
  const res = await reader.raw(`/v1/sessions/${sessionId}/changes/${seq}/clips`, { signal });
  if (res.status !== 200) fail(`clips for change ${seq} returned HTTP ${res.status}`);
  const body = res.body.toString('utf8');
  const proj = JSON.parse(body) as ClipProjection;
  if (proj.change_seq !== seq) fail(`clip projection stamped change_seq ${proj.change_seq}, expected ${seq}`);
  if (typeof proj.projection_version !== 'string' || proj.projection_version.length === 0) {
    fail(`clip projection for ${seq} missing projection_version`);
  }
  return proj;
}

/** Write a real .ts file and wait for its change to become durable, returning the
 * committed change seq as a string. */
async function writeAndObserve(ctx: AcceptanceContext, rel: string, body: string, after: bigint): Promise<{ seq: string; cursor: bigint }> {
  const bytes = Buffer.from(body, 'utf8');
  await writeFile(join(ctx.worktree, rel), bytes);
  const observed = await awaitObservedChange(
    ctx.reader, ctx.sessionId,
    { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes } },
    after, { deadlineMs: 20_000, signal: ctx.signal },
  );
  return { seq: observed.seq.toString(), cursor: observed.seq };
}

/** LIVE: a real source change yields a computed clip projection (not a transient
 * bound response), served through the public reader. */
async function computesClaim(ctx: AcceptanceContext, seq: string): Promise<Assertion> {
  const proj = await getClips(ctx.reader, ctx.sessionId, seq, ctx.signal);
  // 'ready'/'fallback' are genuine computed dispositions; 'skipped' is the
  // service's transient envelope (overloaded/timeout/worker-error) and would mean
  // the compute never produced a real projection.
  if (proj.status !== 'ready' && proj.status !== 'fallback') {
    fail(`live clip projection for ${seq} was not a computed result: status=${proj.status} reason=${proj.fallback_reason ?? ''}`);
  }
  if (proj.clips.length < 1) fail(`computed clip projection for ${seq} carried no clips`);
  return {
    id: 'clip-computes-through-budget',
    claim: 'LIVE: a real .ts change read through the public clips endpoint returns a computed projection (status ready/fallback) with at least one clip, so the clip service still computes after migrating onto the shared admission budget',
    evidence: { change_seq: seq, status: proj.status, clips: proj.clips.length },
  };
}

/** LIVE: reading the same change twice is byte-identical — the cache/coalescing
 * path survived the migration. */
async function cacheClaim(ctx: AcceptanceContext, seq: string): Promise<Assertion> {
  const first = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/changes/${seq}/clips`, { signal: ctx.signal });
  const second = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/changes/${seq}/clips`, { signal: ctx.signal });
  if (first.status !== 200 || second.status !== 200) fail(`repeated clips read returned ${first.status}/${second.status}`);
  if (!first.body.equals(second.body)) {
    fail(`two reads of change ${seq} clips differed:\n${first.body.toString('utf8')}\n${second.body.toString('utf8')}`);
  }
  return {
    id: 'clip-cache-stable-through-budget',
    claim: 'LIVE: two public reads of the same change\'s clips are byte-identical, so the content-addressed cache and in-flight coalescing still work after the migration onto the shared budget',
    evidence: { change_seq: seq, bytes: first.body.length },
  };
}

/** GET a change's clips during the burst; require HTTP 200 and return its status.
 * The clip service maps a shed request (overloaded/timeout/worker-error) to a
 * transient envelope with HTTP 200, so status — not the HTTP code — tells shed
 * apart from computed. */
async function readClipStatus(ctx: AcceptanceContext, seq: string): Promise<string> {
  const r = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/changes/${seq}/clips`, { signal: ctx.signal });
  if (r.status !== 200) fail(`a clip read during the burst returned HTTP ${r.status}`);
  return (JSON.parse(r.body.toString('utf8')) as ClipProjection).status;
}

/** LIVE: real projection load must not starve capture. Contend for clip's single
 * budget slot with concurrent reads over several DISTINCT COLD changes (each a real
 * uncomputed projection, not a cache hit), and require that a file written during
 * the load is still observed on the public events feed within the deadline. Some
 * reads may be shed by the bound — that is the bound working, not starvation. */
async function captureNotStarvedClaim(ctx: AcceptanceContext, startCursor: bigint): Promise<Assertion> {
  const coldSeqs: string[] = [];
  let cursor = startCursor;
  for (let i = 0; i < 6; i++) {
    const rel = `t5b1-cold-${i}-${randomUUID()}.ts`;
    const observed = await writeAndObserve(ctx, rel, `export const cold${i} = () => ${i};\n`, cursor);
    coldSeqs.push(observed.seq);
    cursor = observed.cursor;
  }

  // Concurrent reads over distinct cold seqs: duplicate reads of one seq coalesce,
  // distinct seqs each need their own compute, so the single-slot budget genuinely
  // queues and sheds while the load is in flight.
  const statuses: Promise<string>[] = [];
  for (let round = 0; round < 3; round++) {
    for (const seq of coldSeqs) statuses.push(readClipStatus(ctx, seq));
  }

  const rel = `t5b1-under-load-${randomUUID()}.ts`;
  const t0 = Date.now();
  const observed = writeAndObserve(ctx, rel, 'export const underLoad = () => 1;\n', cursor);
  const [resolved, { seq: newSeq }] = await Promise.all([Promise.all(statuses), observed]);
  const captureMs = Date.now() - t0;

  const computed = resolved.filter((s) => s === 'ready' || s === 'fallback').length;
  const shed = resolved.filter((s) => s !== 'ready' && s !== 'fallback').length;
  return {
    id: 'capture-not-starved-by-clip-load',
    claim: 'LIVE: while concurrent clip reads over 6 distinct cold changes contend for the single-slot clip budget, a newly written source file is still observed on the public events feed within the deadline; some reads may return the transient shed envelope, which is the shared bound working rather than capture starvation',
    evidence: { distinct_cold_changes: coldSeqs.length, concurrent_reads: resolved.length, computed, shed, new_change_seq: newSeq, capture_ms: captureMs },
  };
}

interface CheckerRun { status: number; report: Record<string, unknown> }

function runChecker(args: string[]): CheckerRun {
  const child = spawnSync(process.execPath, [CHECKER, 'admission', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (child.error) fail(`checker failed to spawn: ${child.error.message}`);
  const stdout = child.stdout.trim();
  let report: Record<string, unknown> = {};
  if (stdout.length > 0) {
    try { report = JSON.parse(stdout.split('\n').at(-1)!) as Record<string, unknown>; }
    catch { fail(`checker stdout was not JSON: ${stdout}`); }
  }
  return { status: child.status ?? -1, report };
}

/** FIXTURE: the shipped checker saturates the real budget and reports the
 * invariants held while overload and timeouts actually occurred. */
function saturationClaim(): Assertion {
  const { status, report } = runChecker(['--saturate']);
  if (status !== 0) fail(`checker --saturate exited ${status}, expected 0 (invariants held)`);
  if (report.invariantsHeld !== true) fail(`checker --saturate reported invariantsHeld=${String(report.invariantsHeld)}`);
  const config = report.config as { C: number; Q: number } | undefined;
  const activeMax = report.activeMax as number;
  if (!config || activeMax > config.C) fail(`checker --saturate active work ${activeMax} exceeded C=${config?.C}`);
  if ((report.overloaded as number) <= 0) fail('saturation produced no overloaded rejections; the bound was not actually exercised');
  if ((report.timeouts as number) <= 0) fail('saturation produced no timeouts; the deadline was not actually exercised');
  return {
    id: 'admission-saturation-holds-invariants',
    claim: 'FIXTURE: the projection-check.ts admission --saturate checker drives synthetic jobs across two workloads against the REAL budget module and exits 0 with active work never exceeding C, while overload and timeouts both occur',
    evidence: {
      config, active_max: activeMax, queue_max: report.queueMax,
      overloaded: report.overloaded, timeouts: report.timeouts, ok: report.ok, submitted: report.submitted,
    },
  };
}

/** FIXTURE (negative control): a fabricated trace whose active work exceeds C
 * must be REJECTED by the checker (exit 1), proving its invariant check has teeth. */
async function negativeControlClaim(): Promise<Assertion> {
  const dir = await mkdtemp(join(tmpdir(), 'slipstream-t5b1-'));
  try {
    const tracePath = join(dir, 'over-c.json');
    const fabricated = {
      config: { C: 2, Q: 8, W: 8, D: 100 },
      submitted: 3, admitted: 3, overloaded: 0, ok: 3, timeouts: 0, errors: 0,
      activeMax: 3, queueMax: 0,
    };
    await writeFile(tracePath, JSON.stringify(fabricated));
    const { status, report } = runChecker(['--check-trace', tracePath]);
    if (status !== 1) fail(`checker rejected a fabricated over-C trace with exit ${status}, expected 1`);
    if (report.invariantsHeld !== false) fail(`checker did not flag the over-C trace: invariantsHeld=${String(report.invariantsHeld)}`);
    return {
      id: 'admission-negative-control-rejected',
      claim: 'FIXTURE: feeding the checker a fabricated trace whose active work (3) exceeds C (2) makes it exit 1 and report invariantsHeld=false, proving the saturation pass is a real gate and not vacuously green',
      evidence: { exit: status, violations: report.violations },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const t5b1: AcceptanceModule = {
  id: 'T5b.1',
  requiresPlatform: 'darwin',
  async run(ctx) {
    const start = (await ctx.reader.finite(ctx.sessionId, 0n, ctx.signal)).durableSeq;
    const seqs: string[] = [];
    let cursor = start;
    for (const [rel, body] of [
      ['t5b1-a.ts', 'export function a() {\n  return 1;\n}\n'],
      ['t5b1-b.ts', 'export const b = 2;\nexport const c = 3;\n'],
    ] as const) {
      const observed = await writeAndObserve(ctx, rel, body, cursor);
      seqs.push(observed.seq);
      cursor = observed.cursor;
    }
    return {
      assertions: [
        await computesClaim(ctx, seqs[0]!),
        await cacheClaim(ctx, seqs[0]!),
        await captureNotStarvedClaim(ctx, cursor),
        saturationClaim(),
        await negativeControlClaim(),
      ],
    };
  },
};
