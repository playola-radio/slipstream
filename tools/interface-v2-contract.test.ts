import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllSchemas, type JsonSchema } from '../src/schema.ts';
import {
  checkCase,
  loadCases,
  loadProjectionSchema,
  parseRequest,
  runInterfaceV2Contract,
  type FixtureCase,
} from './interface-v2-contract.ts';
import { main, EXIT } from './projection-check.ts';

type Obj = Record<string, any>;

let schema: JsonSchema;
let eventSchemas: Map<string, JsonSchema>;
let cases: FixtureCase[];

before(async () => {
  [schema, eventSchemas, cases] = await Promise.all([loadProjectionSchema(), loadAllSchemas(), loadCases()]);
});

function base(): FixtureCase {
  return structuredClone(cases.find((c) => c.name === 'ts-parameter-change')!);
}

function errorsAfter(mutate: (c: FixtureCase & { expected: Obj; history: Obj }) => void): string[] {
  const c = base() as FixtureCase & { expected: Obj; history: Obj };
  mutate(c);
  return checkCase(c, schema, eventSchemas);
}

function file(c: { expected: Obj }): Obj {
  return c.expected.files[0];
}

describe('interface.v2 contract fixtures', () => {
  it('every committed case is valid', () => {
    for (const c of cases) assert.deepEqual(checkCase(c, schema, eventSchemas), [], c.name);
  });

  it('the CLI passes and proves its negative control is rejected', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['interface-v2-contract'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0] ?? '{}').negative_control_rejected, true);
  });

  it('rejects arguments', async () => {
    assert.equal(await runInterfaceV2Contract({ argv: ['x'], stdout: () => {}, stderr: () => {} }), 2);
  });
});

describe('interface.v2 contract validator rejects', () => {
  const rejects = (name: string, mutate: Parameters<typeof errorsAfter>[0]): void => {
    it(name, () => assert.notDeepEqual(errorsAfter(mutate), []));
  };

  rejects('a schema violation', (c) => { file(c).status = 'done'; });
  rejects('rows on a non-ready file', (c) => { file(c).status = 'incomplete'; file(c).fallback_reason = 'before-parse-error'; file(c).coverage.before = { state: 'incomplete', reason: 'parse-error' }; });
  rejects('a fallback reason on a ready file', (c) => { file(c).fallback_reason = 'timeout'; });
  rejects('a language without its version', (c) => { file(c).language_version = null; });
  rejects('an equal component whose sides differ', (c) => { file(c).changes[0].parameters[0].op = 'equal'; });
  rejects('a changed component whose sides are equal', (c) => { file(c).changes[0].result.op = 'changed'; });
  rejects('an added row with an equal component', (c) => {
    const row = file(c).changes[0];
    row.kind = 'added';
    row.before = null;
  });
  rejects('a signatureChanged row with nothing changed', (c) => { file(c).changes[0].parameters = []; });
  rejects('a span splitting the blob', (c) => { file(c).changes[0].after.span.byte_end = 99; });
  rejects('provenance pointing at another record', (c) => { file(c).before.record_seq = '20'; });
  rejects('a snapshot that differs from its record', (c) => { file(c).after.snapshot.size = 30; });
  rejects('an identical status for differing endpoints', (c) => {
    file(c).status = 'identical';
    file(c).changes = [];
    file(c).coverage = { before: { state: 'notEvaluated' }, after: { state: 'notEvaluated' } };
  });
  rejects('a partial page with only ready files', (c) => { c.expected.status = 'partial'; });
  rejects('a skipped page that carries files', (c) => { c.expected.status = 'skipped'; c.expected.fallback_reason = 'timeout'; });
  rejects('a complete page with a cursor', (c) => { c.expected.page.next_after_path = 'src/f.ts'; });
  rejects('a range that differs from the request', (c) => { c.expected.range.after_seq = '19'; });
  rejects('a wrong baseline disclosure', (c) => { c.expected.inventory.baseline_completed_seq = null; });
  rejects('a gap list that omits a gap while claiming completeness', (c) => {
    c.history.events.splice(1, 0, { ...structuredClone(c.history.events[1]), seq: '5', id: '5', type: 'slipstream.capture.gap.v1', data: { session_id: c.history.session_id, scope: { kind: 'session' }, reason: 'restart', observed_at_ms: 5 } });
  });
  rejects('a blob whose key is not its hash', (c) => {
    const key = Object.keys(c.history.blobs)[0] as string;
    c.history.blobs[key] = 'tampered';
  });
  rejects('a referenced blob that is neither stored nor declared missing', (c) => {
    const key = Object.keys(c.history.blobs)[0] as string;
    delete c.history.blobs[key];
  });
  rejects('an event that breaks its public schema', (c) => { delete c.history.events[0].data.path; });
  rejects('a request beyond the durable high-water with a 200 body', (c) => { c.history.durable_seq = '19'; });
  rejects('an unknown harness condition', (c) => { c.history.harness = { slow: true }; });
  rejects('a case with both expected files', (c) => { c.expectedError = { http_status: 500 }; });
  rejects('a 409 without the durable-seq header', (c) => {
    delete (c as FixtureCase).expected;
    c.history.durable_seq = '19';
    c.expectedError = { http_status: 409 };
  });
  rejects('a 400 for a well-formed request', (c) => {
    delete (c as FixtureCase).expected;
    c.expectedError = { http_status: 400 };
  });
});

describe('interface.v2 request grammar', () => {
  const sid = '11111111-1111-4111-8111-111111111111';
  const req = (q: string): ReturnType<typeof parseRequest> => parseRequest(`GET /v1/sessions/${sid}/interfaces?${q}\n`);

  it('accepts a full request and defaults the limit', () => {
    const r = req('before_seq=0&after_seq=18446744073709551617&path_prefix=src%2F&include_identical=true');
    assert.ok(typeof r !== 'string');
    assert.equal(r.after, 18446744073709551617n);
    assert.equal(r.limit, 16);
    assert.equal(r.pathPrefix, 'src/');
  });

  const malformed: Array<[string, string]> = [
    ['a missing cutoff', 'before_seq=1'],
    ['a non-canonical cutoff', 'before_seq=01&after_seq=2'],
    ['before after after', 'before_seq=3&after_seq=2'],
    ['an unknown parameter', 'before_seq=1&after_seq=2&x=1'],
    ['a duplicate parameter', 'before_seq=1&after_seq=2&after_seq=2'],
    ['a limit above 16', 'before_seq=1&after_seq=2&limit=17'],
    ['an absolute prefix', 'before_seq=1&after_seq=2&path_prefix=%2Fetc'],
    ['a parent-directory prefix', 'before_seq=1&after_seq=2&path_prefix=src%2F..%2F'],
    ['include_identical=false', 'before_seq=1&after_seq=2&include_identical=false'],
  ];
  for (const [name, q] of malformed) {
    it(`rejects ${name}`, () => assert.equal(typeof req(q), 'string'));
  }
});
