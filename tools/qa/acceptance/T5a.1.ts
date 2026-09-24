/**
 * T5a.1 acceptance: the `interface.v1` response contract and comparison core
 * (INTERFACE-PROJECTION.md). This PR ships the language-neutral core only, so
 * its live surface is deliberately ABSENT — the acceptance proves that absence
 * (the schema is not served, no interface route exists) alongside the synthetic
 * corpus that exercises the core.
 *
 * LIVE claims hit the public reader of a real qa-daemon seeded with observed
 * changes. FIXTURE claims drive the checker oracle over the hand-written
 * contracts/interface/v1 corpus.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../../src/display-fold.ts';
import { validate, type JsonSchema } from '../../../src/schema.ts';
import { FILE_CHANGED_TYPE, type Assertion } from '../../qa-support.ts';
import {
  corpusCasePath,
  interfaceToLine,
  listCorpusCases,
  parseInterfaceInput,
} from '../../interface-projection-oracle.ts';
import type { AcceptanceContext, AcceptanceModule } from './types.ts';

const SCHEMA_PATH = fileURLToPath(new URL('../../../contracts/interface/v1/schema.json', import.meta.url));

function fail(msg: string): never {
  throw new Error(msg);
}

/** The schema is stored but NOT served, and no interface route exists yet: the
 * interface projection is unreachable through the public API until later PRs. */
async function notServedClaim(ctx: AcceptanceContext): Promise<Assertion> {
  const iface = await ctx.reader.raw('/v1/schemas/projections/interface.v1', { signal: ctx.signal });
  if (iface.status !== 404) fail(`interface.v1 schema must not be served yet, got ${iface.status}`);

  const clip = await ctx.reader.raw('/v1/schemas/projections/clip.v3', { signal: ctx.signal });
  if (clip.status !== 200) fail(`control: clip.v3 schema should be served, got ${clip.status}`);

  const { events } = await ctx.reader.finite(ctx.sessionId, 0n, ctx.signal);
  const change = events.find((event) => event.type === FILE_CHANGED_TYPE);
  if (change?.seq === undefined) fail('session has no file.changed event to probe for an interfaces route');

  const route = await ctx.reader.raw(`/v1/sessions/${ctx.sessionId}/changes/${change.seq}/interfaces`, { signal: ctx.signal });
  if (route.status !== 404) fail(`no interface route should exist yet, got ${route.status}`);

  return {
    id: 'interface-not-served',
    claim: 'LIVE: interface.v1 has no public surface yet — its schema route is 404 (while clip.v3 serves 200) and the per-change interfaces route is 404',
    evidence: { interface_schema: iface.status, clip_schema: clip.status, change_seq: change.seq, interface_route: route.status },
  };
}

/** Every hand-written case builds to its expected envelope, byte-for-byte. */
async function corpusClaim(): Promise<Assertion> {
  const names = await listCorpusCases();
  if (names.length === 0) fail('the interface.v1 corpus is empty');
  for (const name of names) {
    const input = parseInterfaceInput(await readFile(corpusCasePath(name, 'input.json')));
    const expected = canonicalJson(JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8')));
    const actual = interfaceToLine(input);
    if (actual !== expected) fail(`corpus case ${name} built to ${actual}, expected ${expected}`);
  }
  return {
    id: 'interface-corpus',
    claim: 'FIXTURE: every hand-written contracts/interface/v1 case builds to its expected envelope (the D3 correspondence, D10 precedence, and D8 ordering worked examples)',
    evidence: { cases: names.length, names },
  };
}

/** Every expected envelope validates against the stored (unserved) schema. */
async function schemaClaim(): Promise<Assertion> {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as JsonSchema;
  const names = await listCorpusCases();
  for (const name of names) {
    const expected = JSON.parse(await readFile(corpusCasePath(name, 'expected.json'), 'utf8'));
    const errors = validate(schema, expected);
    if (errors.length > 0) fail(`corpus case ${name} does not validate against interface.v1 schema: ${errors.join('; ')}`);
    if (('fallback_reason' in expected) !== (expected.status !== 'ready')) {
      fail(`corpus case ${name} must have fallback_reason exactly when status is not ready`);
    }
    if (expected.status !== 'ready' && expected.changes.length !== 0) {
      fail(`corpus case ${name} must have no changes unless status is ready`);
    }
  }
  return {
    id: 'interface-schema',
    claim: 'FIXTURE: every corpus expected.json validates against contracts/interface/v1/schema.json, with fallback_reason presence and non-ready empty changes checked directly',
    evidence: { cases: names.length },
  };
}

/** Row order is part of the contract: a permuted envelope must NOT equal the
 * oracle output, proving the corpus round-trip actually asserts D8 ordering. */
async function orderingClaim(): Promise<Assertion> {
  const expected = JSON.parse(await readFile(corpusCasePath('row-ordering', 'expected.json'), 'utf8'));
  if (!Array.isArray(expected.changes) || expected.changes.length < 2) {
    fail('row-ordering fixture must have at least two change rows to permute');
  }
  const actual = interfaceToLine(parseInterfaceInput(await readFile(corpusCasePath('row-ordering', 'input.json'))));
  const permuted = { ...expected, changes: [expected.changes[1], expected.changes[0], ...expected.changes.slice(2)] };
  if (canonicalJson(permuted) === actual) fail('swapping two change rows produced the same envelope; row order is not observable');
  if (canonicalJson(expected) !== actual) fail('row-ordering fixture no longer matches the oracle output');
  return {
    id: 'interface-row-ordering',
    claim: 'FIXTURE: reordering two change rows changes the envelope bytes, so the deterministic D8 row order is a checked property',
    evidence: { rows: expected.changes.length },
  };
}

export const t5a1: AcceptanceModule = {
  id: 'T5a.1',
  scenario: 'T-QA',
  async run(ctx) {
    return {
      assertions: [
        await notServedClaim(ctx),
        await corpusClaim(),
        await schemaClaim(),
        await orderingClaim(),
      ],
    };
  },
};
