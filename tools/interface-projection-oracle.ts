/**
 * The `interface.v1` oracle plumbing shared by `projection-check.ts interface`
 * and the T5a.1 acceptance check: strict parsing of a hand-written `input.json`
 * into a `BuildInput`, the build-to-canonical-line step, and access to the
 * synthetic corpus under contracts/interface/v1/.
 *
 * Parsing is the tool layer's job, not the core's: the core is typed and pure;
 * everything that could be malformed on disk is validated here and rejected with
 * `InterfaceInputError` (checker exit code 2).
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonicalJson } from '../src/display-fold.ts';
import {
  buildInterfaceProjection,
  type BuildInput,
  type Declaration,
  type Identity,
  type ScopeSegment,
  type SideExtraction,
} from '../src/interface-projection.ts';

/** Input the builder never sees: bad bytes, bad JSON, or a malformed shape. */
export class InterfaceInputError extends Error {}

const CORPUS_DIR = fileURLToPath(new URL('../contracts/interface/v1/', import.meta.url));
const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CHANGE_SEQ = /^[1-9][0-9]*$/;

function fail(msg: string): never {
  throw new InterfaceInputError(msg);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Reject unknown keys so a mistyped corpus field fails loudly, never silently. */
function noExtraKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(`${where} has an unexpected property '${key}'`);
  }
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be a string`);
  return value as string;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value.map((v, i) => asString(v, `${where}[${i}]`));
}

function asInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseScope(value: unknown, where: string): ScopeSegment[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value.map((seg, i) => {
    const o = asObject(seg, `${where}[${i}]`);
    noExtraKeys(o, ['kind', 'name'], `${where}[${i}]`);
    return { kind: asString(o.kind, `${where}[${i}].kind`), name: asString(o.name, `${where}[${i}].name`) };
  });
}

function parseIdentity(value: unknown, where: string): Identity {
  const o = asObject(value, where);
  noExtraKeys(o, ['kind', 'scope', 'name', 'guards'], where);
  return {
    kind: asString(o.kind, `${where}.kind`),
    scope: parseScope(o.scope, `${where}.scope`),
    name: asString(o.name, `${where}.name`),
    guards: asStringArray(o.guards, `${where}.guards`),
  };
}

function parseDeclaration(value: unknown, where: string): Declaration {
  const o = asObject(value, where);
  noExtraKeys(o, ['identity', 'display_name', 'signature', 'span'], where);
  const span = asObject(o.span, `${where}.span`);
  noExtraKeys(span, ['byte_start', 'byte_end'], `${where}.span`);
  const byteStart = asInteger(span.byte_start, `${where}.span.byte_start`);
  const byteEnd = asInteger(span.byte_end, `${where}.span.byte_end`);
  if (byteEnd < byteStart) fail(`${where}.span.byte_end must be >= byte_start`);
  return {
    identity: parseIdentity(o.identity, `${where}.identity`),
    displayName: asString(o.display_name, `${where}.display_name`),
    signature: asString(o.signature, `${where}.signature`),
    span: { byteStart, byteEnd },
  };
}

function parseSide(value: unknown, where: string): SideExtraction {
  const o = asObject(value, where);
  const status = asString(o.status, `${where}.status`);
  switch (status) {
    case 'complete': {
      noExtraKeys(o, ['status', 'declarations'], where);
      if (!Array.isArray(o.declarations)) fail(`${where}.declarations must be an array`);
      return {
        status: 'complete',
        declarations: o.declarations.map((d, i) => parseDeclaration(d, `${where}.declarations[${i}]`)),
      };
    }
    case 'absent':
      noExtraKeys(o, ['status'], where);
      return { status: 'absent' };
    case 'notEvaluated':
      noExtraKeys(o, ['status'], where);
      return { status: 'notEvaluated' };
    case 'incomplete':
      noExtraKeys(o, ['status', 'reason'], where);
      return { status: 'incomplete', reason: asString(o.reason, `${where}.reason`) };
    case 'unavailable':
      noExtraKeys(o, ['status', 'reason'], where);
      return { status: 'unavailable', reason: asString(o.reason, `${where}.reason`) };
    default:
      return fail(`${where}.status '${status}' is not a valid side status`);
  }
}

function parseNullableString(value: unknown, where: string): string | null {
  if (value === null) return null;
  return asString(value, where);
}

/** Parse a hand-written input.json into a validated BuildInput. */
export function parseInterfaceInput(bytes: Uint8Array): BuildInput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('input is not valid UTF-8');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail('input is not valid JSON');
  }
  const o = asObject(json, 'input');
  noExtraKeys(o, ['change_seq', 'language', 'language_version', 'before', 'after', 'admission'], 'input');

  const admission = o.admission;
  if (admission !== undefined && admission !== 'overloaded' && admission !== 'timeout' && admission !== 'cancelled') {
    fail("input.admission must be one of overloaded, timeout, cancelled");
  }

  const changeSeq = asString(o.change_seq, 'input.change_seq');
  if (!CHANGE_SEQ.test(changeSeq)) fail('input.change_seq must be a positive decimal string');

  const input: BuildInput = {
    changeSeq,
    language: parseNullableString(o.language, 'input.language'),
    languageVersion: parseNullableString(o.language_version, 'input.language_version'),
    before: parseSide(o.before, 'input.before'),
    after: parseSide(o.after, 'input.after'),
  };
  if (admission !== undefined) input.admission = admission;
  return input;
}

/** The oracle's single canonical output line for a validated input. */
export function interfaceToLine(input: BuildInput): string {
  return canonicalJson(buildInterfaceProjection(input));
}

export function corpusCasePath(name: string, file: 'input.json' | 'expected.json'): string {
  if (!CASE_NAME.test(name)) fail(`invalid fixture name '${name}'`);
  return join(CORPUS_DIR, name, file);
}

export async function listCorpusCases(): Promise<string[]> {
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && CASE_NAME.test(e.name))
    .map((e) => e.name)
    .sort();
}
