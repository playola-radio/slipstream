import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CappedWorkDidNotSettleError, Journal, monitorHost, preflight, runCapped, type HostLimits } from './fd5-host.ts';

const host: HostLimits = { preflightQuietSeconds: 0, maxFiveMinuteLoadFractionOfPhysicalCores: 0.5,
  maxSwapGrowthBytes: 0, requireAcPower: true, requireNormalThermal: true, requireNoMemoryPressureWarning: true,
  sampleIntervalSeconds: 1 };

test('a host fault is reported the moment it is observed, not only when the monitor stops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slip-fd5-host-'));
  const journal = new Journal(await open(join(dir, 'journal.txt'), 'ax'));
  try {
    const observed: string[] = [];
    const monitor = monitorHost(host, '2000-01-01T00:00:00Z', journal, fault => observed.push(fault));
    const deadline = Date.now() + 5_000;
    while (!observed.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(observed.includes('approved measurement window ended'), observed.join(', '));
    assert.ok((await monitor.stop()).includes('approved measurement window ended'));
  } finally {
    await journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a capped run signals its work and waits for that work to clean up before failing', async () => {
  let observedAbort = false, cleanedUp = false;
  await assert.rejects(runCapped(0.02, 1_000, async signal => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    observedAbort = true;
    await new Promise(resolve => setTimeout(resolve, 50));
    cleanedUp = true;
  }), /wall-time cap/);
  assert.equal(observedAbort, true);
  assert.equal(cleanedUp, true);
});

test('a veto stops a capped run, and cleanup that never settles is abandoned after its bound', async () => {
  const started = Date.now();
  await assert.rejects(runCapped(60, 50, async (_signal, veto) => {
    veto(new Error('host veto'));
    await new Promise(() => {});
  }), CappedWorkDidNotSettleError);
  assert.ok(Date.now() - started < 1_000);
});

test('capped work that ignores abort fails distinctly after settle so callers can preserve live state', async () => {
  await assert.rejects(runCapped(0.001, 25, async signal => {
    await new Promise<void>(() => signal.addEventListener('abort', () => {}, { once: true }));
    return 'never';
  }), (error: unknown) => error instanceof CappedWorkDidNotSettleError && /did not settle/.test(String(error)));
});

test('a capped run that finishes in time returns its result', async () => {
  assert.equal(await runCapped(60, 50, async () => 'done'), 'done');
});

const brokenJournal = (): Journal => new Journal({ appendFile: async () => { throw new Error('ENOSPC'); },
  sync: async () => {}, close: async () => {} } as unknown as ConstructorParameters<typeof Journal>[0]);

test('a journal that cannot record host evidence is a host fault while the run is active', async () => {
  const observed: string[] = [];
  const monitor = monitorHost(host, '2999-01-01T00:00:00Z', brokenJournal(), fault => observed.push(fault));
  const deadline = Date.now() + 5_000;
  while (!observed.some(fault => /journal/.test(fault)) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  await monitor.stop().catch(() => {});
  assert.ok(observed.some(fault => /journal.*ENOSPC/.test(fault)), observed.join(', '));
});

test('preflight stops at the first sample the journal cannot record', async () => {
  await assert.rejects(preflight({ ...host, preflightQuietSeconds: 5, requireAcPower: false, requireNormalThermal: false,
    requireNoMemoryPressureWarning: false, maxFiveMinuteLoadFractionOfPhysicalCores: 1e6 },
  '2999-01-01T00:00:00Z', brokenJournal()), /ENOSPC/);
});
