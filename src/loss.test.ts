import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, type TraceStep, type ObservedState } from './loss.ts';

const c = (sha: string): ObservedState => ({ kind: 'content', sha256: sha });
const absent: ObservedState = { kind: 'absent' };
const step = (path: string, state: ObservedState): TraceStep => ({ path, state });

test('a clean capture (every state recorded in order) reports no loss', () => {
  const trace = [step('a', c('1')), step('a', c('2'))];
  const records = [
    { path: 'a', after: c('1') },
    { path: 'a', after: c('2') },
  ];
  assert.deepEqual(categorize(trace, records), {
    burstWithinFile: 0,
    wholeChangeLost: 0,
    endpointWrong: 0,
    phantom: 0,
    orderingWrong: 0,
  });
});

test('intermediate states lost with the endpoint captured counts as burst-within-file', () => {
  const trace = [step('a', c('1')), step('a', c('2')), step('a', c('3'))];
  const records = [{ path: 'a', after: c('3') }];
  const r = categorize(trace, records);
  assert.equal(r.burstWithinFile, 2);
  assert.equal(r.wholeChangeLost, 0);
  assert.equal(r.endpointWrong, 0);
});

test('a changed file with no record at all is whole-change-lost', () => {
  const trace = [step('a', c('1')), step('a', c('2'))];
  const r = categorize(trace, []);
  assert.equal(r.wholeChangeLost, 1);
  assert.equal(r.burstWithinFile, 0);
});

test('missing the final endpoint (records exist but end elsewhere) is whole-change-lost', () => {
  const trace = [step('a', c('1')), step('a', c('2'))];
  const records = [{ path: 'a', after: c('1') }]; // never captured the endpoint c2
  const r = categorize(trace, records);
  assert.equal(r.wholeChangeLost, 1);
});

test('a recorded state that never existed on disk is endpoint-wrong (fatal)', () => {
  const trace = [step('a', c('1'))];
  const records = [{ path: 'a', after: c('ghost') }];
  const r = categorize(trace, records);
  assert.equal(r.endpointWrong, 1);
});

test('a record for a path that never changed is a phantom', () => {
  const r = categorize([], [{ path: 'never', after: c('x') }]);
  assert.equal(r.phantom, 1);
});

test('records in an order the trace never produced are ordering-wrong', () => {
  const trace = [step('a', c('1')), step('a', c('2')), step('a', c('3'))];
  const records = [
    { path: 'a', after: c('2') },
    { path: 'a', after: c('1') }, // went backwards; trace never did 2 -> 1
    { path: 'a', after: c('3') },
  ];
  const r = categorize(trace, records);
  assert.equal(r.orderingWrong, 1);
});

test('an A -> B -> A cycle fully captured is clean, not deduplicated', () => {
  const trace = [step('a', c('A')), step('a', c('B')), step('a', c('A'))];
  const records = [
    { path: 'a', after: c('A') },
    { path: 'a', after: c('B') },
    { path: 'a', after: c('A') },
  ];
  const r = categorize(trace, records);
  assert.deepEqual(r, { burstWithinFile: 0, wholeChangeLost: 0, endpointWrong: 0, phantom: 0, orderingWrong: 0 });
});
