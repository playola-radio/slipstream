/**
 * T0.1 acceptance: the `display-fold.v1` contract and oracle (DISPLAY-FOLD.md).
 *
 * LIVE claims drive real files through live qa-daemons and fold what the PUBLIC
 * reader serves; they can only exercise the D1 boundary (a live QA session has
 * no harness evidence, attribution, coverage, or gaps without a `src/` change),
 * so the four non-empty components are proven by the FIXTURE corpus claim alone.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, foldDisplay } from '../../../src/display-fold.ts';
import {
  awaitObservedChange,
  createReaderClient,
  FILE_CHANGED_TYPE,
  mkdtempRoot,
  rmMkdtempRoot,
  type AnyRecord,
  type Assertion,
  type ReaderClient,
} from '../../qa-support.ts';
import { startQaDaemon } from '../harness-proc.ts';
import { corpusCasePath, foldToLine, listCorpusCases, parseFoldInput } from '../../display-fold-oracle.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

const EMPTY_FOLD = '{"contract":"display-fold.v1","result":"ok","state":{"attributions":[],"coverage":[],"evidence":[],"gaps":[]}}';
const BASELINED_TYPE = 'slipstream.file.baselined.v1';
const SCHEMAS_DIR = fileURLToPath(new URL('../../../schemas/', import.meta.url));
/** Headers the finite replay sent before T0.1 (plus what node:http adds itself). */
const PRE_EXISTING_HEADERS = new Set([
  'cache-control', 'content-type', 'slipstream-durable-seq',
  'content-length', 'transfer-encoding', 'date', 'connection', 'keep-alive',
]);

function fail(msg: string): never {
  throw new Error(msg);
}

function fold(records: readonly unknown[]): string {
  return canonicalJson(foldDisplay(records));
}

/** `ctx` is a session that baselined pre-existing files; add two real changes. */
async function d1Claim(ctx: AcceptanceContext): Promise<{ assertion: Assertion; events: AnyRecord[] }> {
  const deadline = { deadlineMs: 20_000, signal: ctx.signal };
  let cursor = (await ctx.reader.finite(ctx.sessionId, 0n)).durableSeq;
  for (const body of ['first display-fold change\n', 'second display-fold change\n']) {
    const rel = `display-fold-${randomUUID()}.txt`;
    const bytes = Buffer.from(body, 'utf8');
    await writeFile(join(ctx.worktree, rel), bytes);
    cursor = (await awaitObservedChange(ctx.reader, ctx.sessionId,
      { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes } }, cursor, deadline)).seq;
  }
  const { events, durableSeq } = await ctx.reader.finite(ctx.sessionId, 0n);
  const changed = events.filter((e) => e.type === FILE_CHANGED_TYPE).length;
  const baselined = events.filter((e) => e.type === BASELINED_TYPE).length;
  if (baselined < 2) fail(`expected at least 2 live file.baselined records, saw ${baselined}`);
  if (changed < 2) fail(`expected at least 2 live file.changed records, saw ${changed}`);
  const actual = fold(events);
  if (actual !== EMPTY_FOLD) fail(`a baseline/file-change-only session did not fold to the empty D1 state: ${actual}`);
  return {
    events,
    assertion: {
      id: 'd1-baseline-only',
      claim: 'LIVE: a session of real baselined and changed sandbox files, read through the public finite replay, folds to exactly the four empty D1 components with the contract id',
      evidence: {
        durable_seq: durableSeq.toString(),
        records: events.length,
        file_baselined: baselined,
        file_changed: changed,
        event_types: [...new Set(events.map((e) => e.type))].sort(),
        fold: actual,
      },
    },
  };
}

function determinismClaim(events: AnyRecord[]): Assertion {
  const once = fold(events);
  const again = fold(events);
  const duplicated = fold([...events, ...events]);
  if (again !== once) fail('two folds of the same live stream produced different bytes');
  if (duplicated !== once) fail(`a fully duplicated live stream folded differently: ${duplicated} vs ${once}`);
  return {
    id: 'fold-determinism',
    claim: 'LIVE: two folds of the live stream are byte-identical, and a fully duplicated stream folds to the same bytes',
    evidence: { records: events.length, duplicated_records: events.length * 2, bytes: Buffer.byteLength(once) },
  };
}

/** Collect SSE records from `after=0` until one at or beyond `target` arrives or
 * the deadline passes. */
async function collectSse(reader: ReaderClient, sessionId: string, target: bigint, outer: AbortSignal): Promise<AnyRecord[]> {
  const ctl = new AbortController();
  const onOuter = (): void => ctl.abort();
  outer.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => ctl.abort(), 8_000);
  const records: AnyRecord[] = [];
  try {
    await reader.follow(sessionId, 0n, ctl.signal, (frame) => {
      const record = JSON.parse(frame.data) as AnyRecord;
      records.push(record);
      if (BigInt(record.seq as string) >= target) ctl.abort();
    });
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
  return records;
}

function identitiesThrough(h: bigint): string[] {
  const out: string[] = [];
  for (let s = 1n; s <= h; s++) out.push(s.toString());
  return out;
}

export async function prefixClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const { events, durableSeq: H } = await ctx.reader.finite(ctx.sessionId, 0n);
  if (H === 0n) fail('finite replay has no durable records; a prefix comparison would be vacuous');
  const expected = identitiesThrough(H);
  const finiteSeqs = events.map((e) => e.seq as string);
  if (finiteSeqs.join(',') !== expected.join(',')) fail(`finite replay through ${H} is not contiguous from 1: ${finiteSeqs.join(',')}`);

  const sse = (await collectSse(ctx.reader, ctx.sessionId, H, ctx.signal)).filter((r) => BigInt(r.seq as string) <= H);
  const received = [...new Set(sse.map((r) => r.seq as string))].sort((a, b) => Number(BigInt(a) - BigInt(b)));
  if (received.join(',') !== expected.join(',')) {
    fail(`SSE did not deliver every identity through durable seq ${H}: got ${received.join(',')}`);
  }

  // Equal folds alone prove little when both are empty, so also require that
  // every shared identity carried the same record: folding both transports
  // together must not find a conflict.
  const combined = foldDisplay([...events, ...sse]);
  if (combined.result !== 'ok') fail(`finite and SSE records disagree: ${canonicalJson(combined)}`);
  const finiteFold = fold(events);
  const sseFold = fold(sse);
  if (sseFold !== finiteFold) fail(`fold of SSE truncated at ${H} differs from the finite fold: ${sseFold} vs ${finiteFold}`);
  return {
    id: 'fold-prefix-agreement',
    claim: 'LIVE: SSE delivered every identity 1..H (H = slipstream-durable-seq) with records identical to the finite replay, and its fold truncated at H equals the finite fold byte-for-byte',
    evidence: { durable_seq: H.toString(), identities_received: received.length, sse_records_through_h: sse.length, fold: finiteFold },
  };
}

export function negativeControlClaim(events: AnyRecord[]): Assertion {
  const target = events.at(-1);
  if (!target) fail('no live record to build a negative control from');
  const conflicting = { ...target, data: { ...target.data, qa_negative_control: true } };
  const result = foldDisplay([...events, conflicting]);
  if (result.result !== 'corrupt') fail(`a same-(source,seq) record with different content was not reported as corrupt: ${canonicalJson(result)}`);
  if (result.error.source !== target.source || result.error.seq !== target.seq) {
    fail(`corruption named ${result.error.source}/${result.error.seq}, expected ${String(target.source)}/${String(target.seq)}`);
  }
  return {
    id: 'fold-negative-control',
    claim: 'LIVE: appending an in-memory copy of a live record with the same (source, seq) but different content makes the fold report corruption instead of picking a winner',
    evidence: { result: result.result, source: result.error.source, seq: result.error.seq },
  };
}

export async function corpusClaim(): Promise<Assertion> {
  const names = await listCorpusCases();
  if (names.length === 0) fail('the display-fold.v1 corpus is empty');
  for (const name of names) {
    const input = parseFoldInput(await readFile(corpusCasePath(name, 'input.ndjson')));
    const expected = canonicalJson(JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8')));
    const { line } = foldToLine(input);
    if (line !== expected) fail(`corpus case ${name} folded to ${line}, expected ${expected}`);
  }
  return {
    id: 'fold-corpus',
    claim: 'FIXTURE: every hand-written contracts/display-fold/v1 case folds to its expected envelope (the only proof of non-empty attributions, evidence, coverage, and gaps)',
    evidence: { cases: names.length, names },
  };
}

async function noNewSurfaceClaim(ctx: AcceptanceContext, events: AnyRecord[]): Promise<Assertion> {
  const res = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`);
  if (res.status !== 200) fail(`finite replay returned ${res.status}`);
  const headers = [...res.headers.keys()].sort();
  const unexpected = headers.filter((h) => !PRE_EXISTING_HEADERS.has(h));
  if (unexpected.length > 0) fail(`finite replay sent headers that did not exist before T0.1: ${unexpected.join(', ')}`);

  const schemaTypes = new Set((await readdir(SCHEMAS_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  const liveTypes = [...new Set(events.map((e) => e.type as string))].sort();
  const unknown = liveTypes.filter((t) => !schemaTypes.has(t));
  if (unknown.length > 0) fail(`live stream carried event types with no published schema: ${unknown.join(', ')}`);
  return {
    id: 'no-new-surface',
    claim: 'LIVE: the finite replay sends only its pre-existing headers, and every live event type is one of the published schemas',
    evidence: { headers, live_types: liveTypes, schema_types: schemaTypes.size },
  };
}

/** Start a kept daemon, write files into its worktree, then reuse the root so a
 * FRESH session baselines those files. The runner's own session starts on an
 * empty worktree and so could never show a file.baselined record. */
async function withBaselinedSession<T>(signal: AbortSignal, body: (ctx: AcceptanceContext) => Promise<T>): Promise<T> {
  const root = await mkdtempRoot('slipstream-qa-t01-');
  try {
    const seed = await startQaDaemon({ root, keep: true });
    try {
      for (const name of ['display-fold-a.txt', 'display-fold-b.txt']) {
        await writeFile(join(seed.env.worktree, name), `${name}\n`);
      }
    } finally {
      await seed.stop();
    }
    const live = await startQaDaemon({ root, reuse: true });
    try {
      const reader = createReaderClient(live.env.url, live.env.token);
      return await body({ worktree: live.env.worktree, sessionId: live.env.session_id, reader, signal });
    } finally {
      await live.stop();
    }
  } finally {
    await rmMkdtempRoot(root).catch(() => {});
  }
}

export const t01: AcceptanceModule = {
  id: 'T0.1',
  requiresPlatform: 'darwin',
  async run(ctx) {
    const live = await withBaselinedSession(ctx.signal, async (session) => {
      const { assertion: d1, events } = await d1Claim(session);
      return [
        d1,
        determinismClaim(events),
        await prefixClaim(session),
        negativeControlClaim(events),
        await noNewSurfaceClaim(session, events),
      ];
    });
    return { assertions: [...live, await corpusClaim()] };
  },
};
