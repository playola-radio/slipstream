import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectionTraceCollector } from './fd5-trace.ts';

test('bounded collector retains admission evidence, folds phases and marks overflow invalid', () => {
  const collector = createProjectionTraceCollector(1);
  collector.observe({ kind: 'admission', unitId: 1, routeKey: '/x', workload: 'interface',
    disposition: 'running', atNs: 1n });
  collector.observe({ kind: 'phase', phase: 'range-scan', durationNs: 8n, atNs: 2n });
  collector.observe({ kind: 'phase', phase: 'range-scan', durationNs: 9n, atNs: 3n });
  collector.observe({ kind: 'dispatch', unitId: 1, atNs: 4n });
  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.events.map(event => event.kind), ['admission']);
  assert.equal(snapshot.phases['range-scan']?.count, 2);
  assert.deepEqual(snapshot.faults, ['projection trace overflow']);
});
