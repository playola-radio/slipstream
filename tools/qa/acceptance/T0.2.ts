/**
 * T0.2 acceptance: every SUCCESSFUL live-history reply is labelled with its
 * display-rules version, error replies are not, and the released v1 rules are
 * frozen behind the change gate (STAGE-T-PREREQS Part 2.4, DA-2).
 *
 * LIVE claims drive a real qa-daemon and assert on the `Slipstream-Fold-Contract`
 * header the PUBLIC reader sends (finite 200, empty replay, SSE follow) and its
 * absence on 401/409. FIXTURE claims run the release checker over throwaway copies
 * of the contract tree to prove it rejects tampering and passes a clean tree.
 */
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISPLAY_FOLD_CONTRACT, canonicalJson, foldDisplay } from '../../../src/display-fold.ts';
import { REPO_ROOT, FOLD_ENTRY, discoverImportClosure } from '../../../src/fold-release.ts';
import { runFoldRelease, FOLD_RELEASE_EXIT, type RunFoldReleaseIO } from '../../fold-release-check.ts';
import { parseNdjson, type Assertion } from '../../qa-support.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

const FOLD_HEADER = 'slipstream-fold-contract';

function fail(msg: string): never {
  throw new Error(msg);
}

/** finite after=0 → 200 stamped with the contract the oracle exports. */
async function finiteHeaderClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const res = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { signal: ctx.signal });
  if (res.status !== 200) fail(`finite replay returned ${res.status}`);
  const header = res.headers.get(FOLD_HEADER);
  if (header !== DISPLAY_FOLD_CONTRACT) fail(`finite replay ${FOLD_HEADER}='${header}', expected '${DISPLAY_FOLD_CONTRACT}'`);
  return {
    id: 'finite-header',
    claim: `LIVE: a finite events reply is 200 and carries ${FOLD_HEADER} equal to the oracle's contract id`,
    evidence: { status: res.status, header },
  };
}

/** replay from the current high-water (after=H) → 200, stamped, and — since the
 * session may keep advancing between requests when acceptance runs against an
 * existing operator-supplied daemon — every record it does carry (if any) is
 * strictly newer than H rather than a stale replay of what after=H already
 * covers. */
async function emptyReplayClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const first = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { signal: ctx.signal });
  const H = first.headers.get('slipstream-durable-seq');
  if (H === null) fail('finite replay missing slipstream-durable-seq');
  const res = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=${H}`, { signal: ctx.signal });
  if (res.status !== 200) fail(`empty replay returned ${res.status}`);
  if (res.headers.get(FOLD_HEADER) !== DISPLAY_FOLD_CONTRACT) fail(`empty replay missing ${FOLD_HEADER}`);
  const records = parseNdjson(res.body.toString('utf8'));
  const stale = records.filter((r) => BigInt(r.seq as string) <= BigInt(H));
  if (stale.length) fail(`replay after=${H} carried ${stale.length} record(s) at or before H, expected only records newer than H`);
  return {
    id: 'empty-replay-header',
    claim: `LIVE: a finite replay from the current high-water is still 200 with ${FOLD_HEADER}, carrying no record at or before that high-water`,
    evidence: { durable_seq: H, body_bytes: res.body.length, records: records.length },
  };
}

/** SSE follow → 200 stamped in the response head, before any event byte. */
async function sseHeaderClaim(ctx: AcceptanceContext): Promise<Assertion> {
  // AbortSignal.any fires even if ctx.signal already aborted before we get here,
  // which a late addEventListener('abort', …) would miss; ac ends the stream once
  // we have the head.
  const ac = new AbortController();
  const signal = AbortSignal.any([ctx.signal, ac.signal]);
  try {
    const res = await ctx.reader.open(`/v1/sessions/${ctx.sessionId}/events?follow=true&after=0`, { signal });
    if (res.status !== 200) fail(`SSE follow returned ${res.status}`);
    const header = res.headers.get(FOLD_HEADER);
    if (header !== DISPLAY_FOLD_CONTRACT) fail(`SSE follow ${FOLD_HEADER}='${header}', expected '${DISPLAY_FOLD_CONTRACT}'`);
    return {
      id: 'sse-header',
      claim: `LIVE: an SSE follow reply is 200 and carries ${FOLD_HEADER} in its response head, before the first event`,
      evidence: { status: res.status, header },
    };
  } finally {
    ac.abort();
  }
}

/** 401 (no bearer) and 409 (cursor beyond H) carry NO fold-contract header. */
async function noHeaderOnErrorsClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const unauthorized = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { auth: false, signal: ctx.signal });
  if (unauthorized.status !== 401) fail(`unauthenticated request returned ${unauthorized.status}, expected 401`);
  if (unauthorized.headers.get(FOLD_HEADER) !== null) fail('401 reply carried a fold-contract header');

  const first = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { signal: ctx.signal });
  const H = BigInt(first.headers.get('slipstream-durable-seq') ?? '0');
  const beyond = (H + 1000n).toString();
  const conflict = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=${beyond}`, { signal: ctx.signal });
  if (conflict.status !== 409) fail(`cursor-beyond-H request returned ${conflict.status}, expected 409`);
  if (conflict.headers.get(FOLD_HEADER) !== null) fail('409 reply carried a fold-contract header');
  return {
    id: 'no-header-on-errors',
    claim: `LIVE: 401 and 409 replies carry no ${FOLD_HEADER} header`,
    evidence: { unauthorized: unauthorized.status, conflict: conflict.status },
  };
}

/** The header is additive: the finite body is unchanged event NDJSON (a prefix
 * of any later replay, since the session may keep advancing between requests
 * when acceptance runs against an existing operator-supplied daemon — history
 * is append-only, so `a`'s bytes must recur verbatim at the front of `b`) and
 * folds under exactly the advertised contract (as in T0.1). */
async function bodyUnchangedClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const a = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { signal: ctx.signal });
  const b = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/events?after=0`, { signal: ctx.signal });
  if (!b.body.subarray(0, a.body.length).equals(a.body)) fail("a later finite replay did not reproduce the earlier one's bytes as a prefix");
  const events = parseNdjson(a.body.toString('utf8'));
  const folded = JSON.parse(canonicalJson(foldDisplay(events))) as { contract: string; result: string };
  if (folded.contract !== DISPLAY_FOLD_CONTRACT) fail(`served body folds under '${folded.contract}', not the advertised '${DISPLAY_FOLD_CONTRACT}'`);
  if (folded.result !== 'ok') fail(`served body folds to result '${folded.result}', not 'ok' — the header would advertise a contract the body cannot satisfy`);
  return {
    id: 'body-unchanged',
    claim: `LIVE: stamping ${FOLD_HEADER} left prior history byte-stable across replays, and it folds cleanly (result 'ok') under the advertised contract`,
    evidence: { body_bytes: a.body.length, later_body_bytes: b.body.length, records: events.length, folds_under: folded.contract, result: folded.result },
  };
}

/** A throwaway copy of just what the release gates read. Not a git repo, so the
 * immutability gate reports not-applicable and the fingerprint gate drives exit. */
async function stageContractTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slip-t02-'));
  await mkdir(join(root, 'src'), { recursive: true });
  for (const rel of discoverImportClosure(REPO_ROOT)) await cp(join(REPO_ROOT, rel), join(root, rel));
  await cp(join(REPO_ROOT, 'contracts/display-fold/v1'), join(root, 'contracts/display-fold/v1'), { recursive: true });
  return root;
}

function runChecker(root: string): { code: number; result: { fingerprint: { failures: string[] } } } {
  let out = '';
  const io: RunFoldReleaseIO = { argv: ['--root', root], cwd: REPO_ROOT, stdout: (l) => { out += l; }, stderr: () => {} };
  const code = runFoldRelease(io);
  return { code, result: JSON.parse(out) as { fingerprint: { failures: string[] } } };
}

/** FIXTURE: the checker rejects each class of tampering and passes a clean tree. */
async function checkerControlsClaim(): Promise<Assertion> {
  const controls: Record<string, unknown> = {};

  // (a) altered released expected.json → exit 1 naming the case.
  {
    const root = await stageContractTree();
    try {
      const p = join(root, 'contracts/display-fold/v1/empty/expected.json');
      await writeFile(p, `${await readFile(p, 'utf8')} `);
      const { code, result } = runChecker(root);
      if (code !== FOLD_RELEASE_EXIT.FAIL) fail(`altered fixture: exit ${code}, expected 1`);
      if (!result.fingerprint.failures.some((f) => /'empty'/.test(f))) fail('altered fixture: failure did not name the case');
      controls.altered_fixture = { code, failures: result.fingerprint.failures };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // (b) changed byte on a listed dependency → fingerprint mismatch, exit 1.
  {
    const root = await stageContractTree();
    try {
      const p = join(root, 'src/snapshot.ts');
      await writeFile(p, `${await readFile(p, 'utf8')}\n// drift\n`);
      const { code, result } = runChecker(root);
      if (code !== FOLD_RELEASE_EXIT.FAIL) fail(`changed dependency: exit ${code}, expected 1`);
      if (!result.fingerprint.failures.some((f) => /fingerprint changed/.test(f))) fail('changed dependency: no fingerprint mismatch');
      controls.changed_dependency = { code };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // (c) new unlisted import in the closure → omission failure, exit 1.
  {
    const root = await stageContractTree();
    try {
      await writeFile(join(root, 'src/extra.ts'), 'export const extra = 1;\n');
      const entry = join(root, FOLD_ENTRY);
      await writeFile(entry, `import { extra } from './extra.ts';\nvoid extra;\n${await readFile(entry, 'utf8')}`);
      const { code, result } = runChecker(root);
      if (code !== FOLD_RELEASE_EXIT.FAIL) fail(`unlisted import: exit ${code}, expected 1`);
      if (!result.fingerprint.failures.some((f) => /not listed in the manifest/.test(f))) fail('unlisted import: no omission failure');
      controls.unlisted_import = { code };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // (d) unmodified tree → exit 0.
  {
    const root = await stageContractTree();
    try {
      const { code } = runChecker(root);
      if (code !== FOLD_RELEASE_EXIT.PASS) fail(`clean tree: exit ${code}, expected 0`);
      controls.clean_tree = { code };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return {
    id: 'checker-controls',
    claim: 'FIXTURE: the release checker exits 1 (naming the case) on an altered fixture, a changed dependency, or an unlisted import, and exits 0 on a clean tree',
    evidence: controls,
  };
}

export const t02: AcceptanceModule = {
  id: 'T0.2',
  async run(ctx) {
    return {
      assertions: [
        await finiteHeaderClaim(ctx),
        await emptyReplayClaim(ctx),
        await sseHeaderClaim(ctx),
        await noHeaderOnErrorsClaim(ctx),
        await bodyUnchangedClaim(ctx),
        await checkerControlsClaim(),
      ],
    };
  },
};
