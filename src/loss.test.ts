import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, type TraceStep, type ObservedState } from './loss.ts';

const c = (sha: string): ObservedState => ({ kind: 'content', sha256: sha });
const step = (path: string, state: ObservedState): TraceStep => ({ path, state });
const noLoss = { burstWithinFile: 0, wholeChangeLost: 0, endpointWrong: 0, phantom: 0, orderingWrong: 0 };

describe('loss', () => {
  describe('categorize', () => {
    it('reports no loss when every state is recorded in order', () => {
      const trace = [step('a', c('1')), step('a', c('2'))];
      const records = [
        { path: 'a', after: c('1') },
        { path: 'a', after: c('2') },
      ];
      assert.deepEqual(categorize(trace, records), noLoss);
    });

    it('counts intermediate states lost with the endpoint captured as burst-within-file', () => {
      const trace = [step('a', c('1')), step('a', c('2')), step('a', c('3'))];
      const r = categorize(trace, [{ path: 'a', after: c('3') }]);
      assert.equal(r.burstWithinFile, 2);
      assert.equal(r.wholeChangeLost, 0);
      assert.equal(r.endpointWrong, 0);
    });

    it('counts a changed file with no record at all as whole-change-lost', () => {
      const trace = [step('a', c('1')), step('a', c('2'))];
      const r = categorize(trace, []);
      assert.equal(r.wholeChangeLost, 1);
      assert.equal(r.burstWithinFile, 0);
    });

    it('counts a missing final endpoint (records exist but end elsewhere) as whole-change-lost', () => {
      const trace = [step('a', c('1')), step('a', c('2'))];
      const r = categorize(trace, [{ path: 'a', after: c('1') }]);
      assert.equal(r.wholeChangeLost, 1);
    });

    it('counts a recorded state that never existed on disk as endpoint-wrong', () => {
      const r = categorize([step('a', c('1'))], [{ path: 'a', after: c('ghost') }]);
      assert.equal(r.endpointWrong, 1);
    });

    it('counts a record for a path that never changed as a phantom', () => {
      const r = categorize([], [{ path: 'never', after: c('x') }]);
      assert.equal(r.phantom, 1);
      assert.equal(r.endpointWrong, 0);
    });

    it('counts records in an order the trace never produced as ordering-wrong', () => {
      const trace = [step('a', c('1')), step('a', c('2')), step('a', c('3'))];
      const records = [
        { path: 'a', after: c('2') },
        { path: 'a', after: c('1') }, // went backwards; the trace never did 2 -> 1
        { path: 'a', after: c('3') },
      ];
      assert.equal(categorize(trace, records).orderingWrong, 1);
    });

    it('reports a fully captured A -> B -> A cycle as clean, not deduplicated', () => {
      const trace = [step('a', c('A')), step('a', c('B')), step('a', c('A'))];
      const records = [
        { path: 'a', after: c('A') },
        { path: 'a', after: c('B') },
        { path: 'a', after: c('A') },
      ];
      assert.deepEqual(categorize(trace, records), noLoss);
    });
  });
});
