import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, monitorHost, runCapped, type HostLimits } from './fd5-host.ts';

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
  }), /host veto/);
  assert.ok(Date.now() - started < 1_000);
});

test('a capped run that finishes in time returns its result', async () => {
  assert.equal(await runCapped(60, 50, async () => 'done'), 'done');
});
