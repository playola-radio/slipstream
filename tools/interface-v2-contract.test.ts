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

type Case = FixtureCase & { expected: Obj; expectedError: Obj; history: Obj };

function errorsAfter(mutate: (c: Case) => void, name = 'ts-parameter-change'): string[] {
  const c = structuredClone(cases.find((x) => x.name === name)!) as Case;
  mutate(c);
  return checkCase(c, schema, eventSchemas);
}

function file(c: { expected: Obj }): Obj {
  return c.expected.files[0];
}

function row(c: { expected: Obj }): Obj {
  return file(c).changes[0];
}

function event(c: { history: Obj }, seq: string): Obj {
  return c.history.events.find((e: Obj) => e.seq === seq);
}

function asError(c: Case, httpStatus: number): void {
  delete (c as FixtureCase).expected;
  c.expectedError = { http_status: httpStatus };
}

describe('interface.v2 contract fixtures', () => {
  it('rejects malformed ignore policies even when the projection marker agrees', () => {
    const errors = errorsAfter((c) => {
      c.history.events[0].data.capture_ignores = {
        version: 1, git: { root_prefix: '', ignore_case: false,
          sources: [{ dir: '../outside', text: '*.log' }], tracked_exceptions: [] }, slipstreamignore: null,
      };
    }, 'range-ignore-rules');
    assert.ok(errors.some((e) => e.includes('invalid rule source path')));
  });

  it('the CLI validates every case and proves its negative control is rejected', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['interface-v2-contract'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    const report = JSON.parse(out[0] ?? '{}');
    assert.equal(report.cases, 72);
    assert.deepEqual(report.failures, []);
    assert.equal(report.negative_control_rejected, true);
    assert.equal(code, EXIT.PASS);
  });

  it('rejects arguments', async () => {
    assert.equal(await runInterfaceV2Contract({ argv: ['x'], stdout: () => {}, stderr: () => {} }), 2);
  });
});

describe('interface.v2 contract validator rejects', () => {
  const rejects = (name: string, expected: RegExp, mutate: (c: Case) => void, caseName?: string): void => {
    it(name, () => {
      const errors = errorsAfter(mutate, caseName);
      assert.ok(errors.some((e) => expected.test(e)), `no error matched ${String(expected)}: ${JSON.stringify(errors)}`);
    });
  };

  rejects('a schema violation', /^expected: /, (c) => { file(c).status = 'done'; });
  rejects('rows on a non-ready file', /only a ready file/, (c) => { file(c).status = 'incomplete'; file(c).fallback_reason = 'before-parse-error'; file(c).coverage.before = { state: 'incomplete', reason: 'parse-error' }; });
  rejects('a fallback reason on a ready file', /fallback_reason must be present/, (c) => { file(c).fallback_reason = 'timeout'; });
  rejects('a language without its version', /null together/, (c) => { file(c).language_version = null; });
  rejects('an equal component whose sides differ', /equal but the sides differ/, (c) => { row(c).parameters[0].op = 'equal'; });
  rejects('an equal component whose sides differ only in whitespace', /equal but the sides differ/, (c) => { row(c).result.after.type.text = ' void'; });
  rejects('a changed component whose sides are equal', /changed but the sides are equal/, (c) => { row(c).result.op = 'changed'; });
  rejects('an added row with an equal component', /must be added/, (c) => { row(c).kind = 'added'; row(c).before = null; });
  rejects('a signatureChanged row with nothing changed', /every component equal/, (c) => { row(c).parameters = []; });
  rejects('a span splitting the blob', /outside the/, (c) => { row(c).after.span.byte_end = 99; });
  rejects('a TypeScript function without a result slot', /null exactly for a TypeScript constructor/, (c) => { row(c).result = null; });
  rejects('a TypeScript throws mode other than notExpressible', /throws mode/, (c) => { row(c).throws = { op: 'equal', before: { mode: 'none' }, after: { mode: 'none' } }; });
  rejects('a TypeScript parameter label', /no label/, (c) => { row(c).parameters[0].before.label = '_'; });
  rejects('a before endpoint that is not the latest record at before_seq', /§2.2 resolves/, (c) => { file(c).before = { kind: 'unknownBoundary' }; });
  rejects('an after endpoint that is not the latest record at after_seq', /§2.2 resolves/, (c) => { file(c).after.record_seq = '2'; file(c).after.field = 'snapshot'; });
  rejects('a snapshot that differs from its record', /§2.2 resolves/, (c) => { file(c).after.snapshot.size = 30; });
  rejects('an identical status for differing endpoints', /precedence gives ready/, (c) => {
    file(c).status = 'identical';
    file(c).changes = [];
    file(c).coverage = { before: { state: 'notEvaluated' }, after: { state: 'notEvaluated' } };
  });
  rejects('an extraction reason outranking an incomplete side', /precedence gives incomplete \/ before-parse-error/, (c) => {
    file(c).status = 'incomplete';
    file(c).fallback_reason = 'duplicate-declaration';
    file(c).coverage.before = { state: 'incomplete', reason: 'parse-error' };
    file(c).changes = [];
  });
  rejects('an unavailable status without an unavailable side', /precedence gives ready/, (c) => {
    file(c).status = 'unavailable';
    file(c).fallback_reason = 'before-blob-missing';
    file(c).changes = [];
  });
  rejects('an unsupported status for a file with a language', /precedence gives ready/, (c) => {
    file(c).status = 'unsupported';
    file(c).fallback_reason = 'unsupported-language';
    file(c).changes = [];
  });
  rejects('a skipped file with no harness condition', /precedence gives ready/, (c) => {
    file(c).status = 'skipped';
    file(c).fallback_reason = 'timeout';
    file(c).changes = [];
  });
  rejects('a partial page with only ready files', /must be ready/, (c) => { c.expected.status = 'partial'; });
  rejects('a complete page with a cursor', /next_after_path/, (c) => { c.expected.page.next_after_path = 'src/f.ts'; });
  rejects('a complete page that omits an eligible file', /expected.files: must list/, (c) => { c.expected.files.shift(); }, 'ts-shared-type-only');
  rejects('a page shorter than its limit', /expected.files: must list/, (c) => { c.request = c.request.replace('limit=1', 'limit=16'); }, 'range-page-boundary-first');
  rejects('an incomplete page claiming completion', /page.complete: must be false/, (c) => { c.expected.page = { complete: true, next_after_path: null }; }, 'range-page-boundary-first');
  rejects('a range that differs from the request', /range: does not match/, (c) => { c.expected.range.after_seq = '3'; });
  rejects('a wrong baseline disclosure', /baseline_completed_seq/, (c) => { c.expected.inventory.baseline_completed_seq = null; });
  rejects('missing policy exclusions', /policy_exclusions/, (c) => { c.expected.inventory.policy_exclusions = []; });
  rejects('a gap list that omits a recorded gap', /the full recorded list/, (c) => { c.expected.gaps = []; }, 'range-gap-unchanged-hashes');
  rejects('a history that does not start with session.started', /session.started must be the first record/, (c) => { c.history.events[0].type = 'slipstream.capture.baseline.completed.v1'; });
  rejects('a history with a seq hole', /not contiguous/, (c) => { c.history.events.splice(2, 1); });
  rejects('a durable high-water past the last event', /must be the last event seq/, (c) => { c.history.durable_seq = '5'; });
  rejects('a blob whose key is not its hash', /not the sha256/, (c) => {
    const key = Object.keys(c.history.blobs)[0] as string;
    c.history.blobs[key] = 'tampered';
  });
  rejects('a referenced blob that is neither stored nor declared missing', /neither stored nor declared missing/, (c) => {
    const key = Object.keys(c.history.blobs)[0] as string;
    delete c.history.blobs[key];
  });
  rejects('an event that breaks its public schema', /history.events\[1\]/, (c) => { delete c.history.events[1].data.path; });
  rejects('a 200 body over a broken predecessor chain', /give 500/, (c) => { event(c, '4').data.before = { kind: 'absent' }; });
  rejects('a 500 over an intact chain', /give 200/, (c) => { event(c, '4').data.before = event(c, '2').data.snapshot; }, 'range-corrupt-chain-500');
  rejects('a request beyond the durable high-water with a 200 body', /give 409/, (c) => { c.request = c.request.replace('after_seq=4', 'after_seq=5'); });
  rejects('a 409 without the durable-seq header', /slipstream-durable-seq/, (c) => {
    c.request = c.request.replace('after_seq=4', 'after_seq=5');
    asError(c, 409);
  });
  rejects('a 400 for a well-formed request', /give 200, not 400/, (c) => { asError(c, 400); });
  rejects('an unknown harness condition', /unexpected property 'slow'/, (c) => { c.history.harness = { slow: true }; });
  rejects('a non-zero harness limit', /must be 0/, (c) => { c.history.harness = { limits: { file_result_bytes: 1 } }; });
  rejects('a non-zero pre-first-file scan limit', /scan_records: must be 0/, (c) => {
    c.history.harness.limits.scan_records = 1;
  }, 'range-scan-limit-before-file');
  rejects('an unknown pre-first-file interrupt phase', /phase.*resolve/, (c) => {
    c.history.harness.interrupt.phase = 'after';
  }, 'range-deadline-before-file');
  rejects('an unknown pre-first-file interrupt reason', /reason.*timeout.*cancelled/, (c) => {
    c.history.harness.interrupt.reason = 'overloaded';
  }, 'range-cancelled-before-file');
  rejects('a lookahead interruption after an unreachable file', /after_path is not a completed path/, (c) => {
    c.history.harness.interrupt.after_path = 'src/b.ts';
  }, 'range-lookahead-timeout');
  rejects('a lookahead interruption before the page stops comparing files', /after_path must end the completed page/, (c) => {
    c.request = c.request.replace('limit=1', 'limit=2&include_identical=true');
  }, 'range-lookahead-timeout');
  rejects('a lookahead interruption without a pending candidate', /no unchecked path/, (c) => {
    c.request = c.request.replace('path_prefix=src/', 'path_prefix=src/a');
  }, 'range-lookahead-timeout');
  rejects('a lookahead interruption when identical rows are included', /no unchecked path needs a lookahead retention check/, (c) => {
    c.request = c.request.replace('limit=1', 'limit=1&include_identical=true');
  }, 'range-lookahead-timeout');
  rejects('a lookahead interruption combined with a zero file budget', /cannot combine lookahead/, (c) => {
    c.history.harness.limits = { file_result_bytes: 0 };
  }, 'range-lookahead-timeout');
  rejects('a lookahead page claiming to be complete', /page.complete: must be false/, (c) => {
    c.expected.page.complete = true;
  }, 'range-lookahead-timeout');
  rejects('a lookahead page advancing past the last returned row', /page.next_after_path/, (c) => {
    c.expected.page.next_after_path = 'src/b.ts';
  }, 'range-lookahead-timeout');
  rejects('a lookahead page claiming a file timeout', /must be ready/, (c) => {
    c.expected.status = 'partial';
  }, 'range-lookahead-timeout');
  rejects('two pre-work conditions with undefined ordering', /one exclusive pre-work condition/, (c) => {
    c.history.harness.interrupt = { phase: 'resolve', reason: 'cancelled' };
  }, 'range-scan-limit-before-file');
  rejects('a pre-work scan with an unreachable file interrupt', /one exclusive pre-work condition/, (c) => {
    c.history.harness.interrupt = { at_path: 'never.ts', reason: 'timeout' };
  }, 'range-scan-limit-before-file');
  rejects('evaluated inventory on pre-first-file timeout', /not evaluated/, (c) => {
    c.expected.inventory = { scope: 'observed', baseline_completed_seq: '3', unknown_scopes: [],
      unknown_scopes_complete: true, policy_exclusions: ['store-directory', '.git', 'symlinks'] };
  }, 'range-deadline-before-file');
  rejects('a normal page under an admission rejection', /overloaded/, (c) => { c.history.harness = { admission: 'overloaded' }; });
  rejects('a ready file under an interrupt', /precedence gives skipped \/ cancelled/, (c) => { c.history.harness = { interrupt: { at_path: 'src/f.ts', reason: 'cancelled' } }; });
  rejects('a ready first file under a zero file-result budget', /precedence gives skipped \/ too-large/, (c) => { c.history.harness = { limits: { file_result_bytes: 0 } }; });
  rejects('a full gap list under a zero metadata budget', /empty under a zero metadata budget/, (c) => { c.history.harness = { limits: { metadata_bytes: 0 } }; }, 'range-gap-unchanged-hashes');
  rejects('a correspondence failure without both sides extracted', /precedence gives unavailable \/ before-blob-missing/, (c) => {
    file(c).status = 'incomplete';
    file(c).fallback_reason = 'ambiguous-correspondence';
  }, 'ts-missing-blob');
  rejects('a case with both expected files', /exactly one of/, (c) => { c.expectedError = { http_status: 500 }; });
  rejects('same-kind rows out of D8 order', /rows must be ordered by the D8 tuple/, (c) => {
    const [r] = file(c).changes;
    const later = { ...structuredClone(r), identity: { ...r.identity, name: 'z' }, before: { ...r.before, display_name: 'z' } };
    const earlier = { ...structuredClone(r), identity: { ...r.identity, name: 'a' }, before: { ...r.before, display_name: 'a' } };
    file(c).changes = [later, earlier];
  });
  rejects('an absolute path in a recorded event', /unsafe path/, (c) => { event(c, '2').data.path = '/etc/passwd'; });
  rejects('a parent-directory segment in a recorded event path', /unsafe path/, (c) => { event(c, '4').data.path = '../secret.ts'; });
  rejects('a language/version pair the client cannot decode', /not a known/, (c) => { file(c).language_version = 'typescript.v1'; });
  rejects('a swift file labelled with the typescript version', /not a known/, (c) => {
    file(c).language = 'swift';
  }, 'ts-parameter-change');
  rejects('an unknown field on the response envelope', /unexpected property 'extra'/, (c) => { (c.expected as Obj).extra = true; });
  rejects('an unknown field on a file result', /unexpected property 'extra'/, (c) => { file(c).extra = true; });
});

describe('interface.v2 contract validator accepts', () => {
  it('a lookahead interruption while checking an equal file whose blob is now missing', () => {
    assert.deepEqual(errorsAfter((c) => {
      const hash = event(c, '3').data.snapshot.sha256 as string;
      c.history.missing_blobs = [hash];
      delete c.history.blobs[hash];
    }, 'range-lookahead-timeout'), []);
  });

  it('an interrupt that leaves one side unevaluated while a parse error wins', () => {
    assert.deepEqual(errorsAfter((c) => {
      c.history.harness = { interrupt: { at_path: 'src/f.ts', reason: 'timeout' } };
      file(c).coverage.after = { state: 'notEvaluated' };
      c.expected.status = 'partial';
      c.expected.page = { complete: false, next_after_path: 'src/f.ts' };
    }, 'ts-parse-failure'), []);
  });

  it('a zero file-result budget that ends the page after a row-less first result', () => {
    assert.deepEqual(errorsAfter((c) => {
      c.history.harness = { limits: { file_result_bytes: 0 } };
      c.expected.files = c.expected.files.slice(0, 1);
      c.expected.page = { complete: false, next_after_path: c.expected.files[0].path };
    }, 'ts-shared-type-only'), []);
  });
});

describe('interface.v2 request grammar', () => {
  const sid = '11111111-1111-4111-8111-111111111111';
  const req = (q: string): ReturnType<typeof parseRequest> => parseRequest(`GET /v1/sessions/${sid}/interfaces?${q}\n`);

  it('decodes the query as URLSearchParams does', () => {
    const r = req('before_seq=1&after_seq=2&path_prefix=src%2Fa+b');
    assert.ok(typeof r !== 'string');
    assert.equal(r.pathPrefix, 'src/a b');
  });

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
