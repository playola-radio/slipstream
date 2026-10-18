import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCpuTime, summarize, countLifecycle, type Sample } from './real-use-sample.ts';

describe('real-use sampler', () => {
  it('reads ps cpu time in every form ps prints', () => {
    assert.equal(parseCpuTime('0:01.50'), 1.5);
    assert.equal(parseCpuTime('61:02.25'), 3662.25);
    assert.equal(parseCpuTime('1:01:02.25'), 3662.25);
    assert.equal(parseCpuTime('2-01:00:00'), 2 * 86400 + 3600);
  });

  it('averages cpu over the whole day and over intervals where no capture wrote anything', () => {
    const samples: Sample[] = [
      { at_ms: 0, pid: 7, cpu_s: 0, rss_kib: 100 * 1024, log_bytes: 10 },
      { at_ms: 60_000, pid: 7, cpu_s: 0.3, rss_kib: 100 * 1024, log_bytes: 10 },
      { at_ms: 120_000, pid: 7, cpu_s: 6.3, rss_kib: 120 * 1024, log_bytes: 500 },
      { at_ms: 180_000, pid: 7, cpu_s: 6.9, rss_kib: 110 * 1024, log_bytes: 500 },
    ];
    const s = summarize(samples);
    assert.equal(s.hours, 0.05);
    assert.equal(s.cpu_pct_all, 3.833);
    assert.equal(s.cpu_pct_idle, 0.75);
    assert.equal(s.idle_intervals, 2);
    assert.equal(s.rss_max_mib, 120);
    assert.equal(s.daemon_restarts, 0);
  });

  it('skips the interval across a daemon restart and counts the restart', () => {
    const s = summarize([
      { at_ms: 0, pid: 7, cpu_s: 50, rss_kib: 1024, log_bytes: 0 },
      { at_ms: 60_000, pid: 8, cpu_s: 1, rss_kib: 1024, log_bytes: 0 },
      { at_ms: 120_000, pid: 8, cpu_s: 1.6, rss_kib: 1024, log_bytes: 0 },
    ]);
    assert.equal(s.daemon_restarts, 1);
    assert.equal(s.cpu_pct_idle, 1);
  });

  it('compares the first and last quarter of memory samples', () => {
    const rss = [100, 100, 100, 100, 150, 150, 200, 200];
    const s = summarize(rss.map((mib, i) => ({ at_ms: i * 60_000, pid: 1, cpu_s: 0, rss_kib: mib * 1024, log_bytes: 0 })));
    assert.equal(s.rss_first_quarter_mib, 100);
    assert.equal(s.rss_last_quarter_mib, 200);
  });

  it('counts gaps and stops by reason inside the sampled window only', async () => {
    const store = await mkdtemp(join(tmpdir(), 'slip-real-use-'));
    const at = (iso: string, type: string, reason: string) =>
      JSON.stringify({ type: `slipstream.${type}.v1`, time: iso, data: { reason } });
    await mkdir(join(store, 'sessions', 'a'), { recursive: true });
    await mkdir(join(store, 'sessions', 'b'), { recursive: true });
    await writeFile(join(store, 'sessions', 'a', 'events.jsonl'), [
      at('2026-10-18T08:00:00.000Z', 'capture.gap', 'restart'),
      at('2026-10-18T10:00:00.000Z', 'capture.gap', 'restart'),
      at('2026-10-18T10:05:00.000Z', 'capture.stopped', 'maintenance'),
      at('2026-10-18T11:00:00.000Z', 'file.changed', 'n/a'),
    ].join('\n') + '\n');
    await writeFile(join(store, 'sessions', 'b', 'events.jsonl'),
      at('2026-10-18T12:00:00.000Z', 'capture.gap', 'watcher-error') + '\n'
      + at('2026-10-18T12:00:01.000Z', 'capture.stopped', 'watcher-failed') + '\n');
    const counts = await countLifecycle(store, Date.parse('2026-10-18T09:00:00Z'), Date.parse('2026-10-18T13:00:00Z'));
    assert.deepEqual(counts, {
      gaps: { restart: 1, 'watcher-error': 1 },
      stops: { maintenance: 1, 'watcher-failed': 1 },
    });
  });
});
