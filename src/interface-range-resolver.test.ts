import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveRecordedRange } from './interface-range-resolver.ts';
import type { RangeEndpoint, RangeFile } from './interface-range-resolver.ts';
import { parseRequest } from '../tools/interface-v2-contract.ts';

const casesDir = fileURLToPath(new URL('../contracts/interface/v2/cases/', import.meta.url));
const sessionId = '11111111-1111-4111-8111-111111111111';
type Event = { seq: string; type: string; data: Record<string, unknown> };

async function withLog(events: Event[], run: (logPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slipstream-fd3-'));
  try {
    const logPath = join(root, 'events.jsonl');
    await writeFile(logPath, events.map((e) => JSON.stringify(envelope(e))).join('\n') + '\n');
    await run(logPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withRawLog(records: Array<Record<string, unknown>>, run: (logPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slipstream-fd3-raw-'));
  try {
    const logPath = join(root, 'events.jsonl');
    await writeFile(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await run(logPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function event(seq: number, type: string, data: Record<string, unknown> = {}): Event {
  return { seq: String(seq), type: `slipstream.${type}.v1`, data: { session_id: sessionId, ...data } };
}

function envelope(e: Event): Record<string, unknown> {
  return { specversion: '1.0', id: e.seq, source: `urn:slipstream:session:${sessionId}`,
    type: e.type, datacontenttype: 'application/json', seq: e.seq, time: '2026-01-01T00:00:00.000Z', data: e.data };
}

const content = (sha256: string, size = 1) => ({ kind: 'content', sha256: sha256.repeat(64), size });
const absent = { kind: 'absent' };

function options(logPath: string, beforeSeq: bigint, afterSeq: bigint, extra = {}) {
  return { logPath, sessionId, durableSeq: afterSeq, beforeSeq, afterSeq,
    scanBudget: { records: 100_000, bytes: 16 * 1024 * 1024 }, ...extra };
}

test('records both endpoint identities and retains equal candidates for later blob checks', async () => {
  const events = [
    event(1, 'session.started'),
    event(2, 'file.baselined', { path: 'src/f.ts', snapshot: content('a') }),
    event(3, 'capture.baseline.completed', { unknown_scopes: [] }),
    event(4, 'file.changed', { path: 'src/f.ts', before: content('a'), after: content('b'), observation: 'watcher' }),
    event(5, 'file.changed', { path: 'src/f.ts', before: content('b'), after: content('a'), observation: 'watcher' }),
  ];
  await withLog(events, async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 3n, 5n));
    assert.equal(result.kind, 'resolved');
    if (result.kind !== 'resolved') return;
    assert.deepEqual(result.files, [{
      path: 'src/f.ts', endpointsEqual: true,
      before: { kind: 'recorded', record_seq: '2', field: 'snapshot', snapshot: content('a') },
      after: { kind: 'recorded', record_seq: '5', field: 'after', snapshot: content('a'), observation: 'watcher' },
    }]);
    assert.deepEqual(result.inventory, { scope: 'observed', baselineCompletedSeq: '3', unknownScopes: [],
      policyExclusions: ['store-directory', '.git', 'symlinks'] });
    assert.deepEqual(result.gaps, []);
  });
});

test('a first change supplies before only after completed baseline, with later provenance', async () => {
  const events = [event(1, 'session.started'), event(2, 'capture.baseline.completed', { unknown_scopes: [] }),
    event(3, 'file.changed', { path: 'src/new.ts', before: absent, after: content('a'), observation: 'watcher' })];
  await withLog(events, async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 2n, 3n));
    assert.equal(result.kind, 'resolved');
    if (result.kind !== 'resolved') return;
    assert.deepEqual(result.files[0]?.before, { kind: 'recorded', record_seq: '3', field: 'before', snapshot: absent, observation: 'watcher' });
    const zero = await resolveRecordedRange(options(logPath, 0n, 3n));
    assert.equal(zero.kind, 'resolved');
    if (zero.kind === 'resolved') assert.deepEqual(zero.files[0]?.before, { kind: 'unknownBoundary' });
  });
});

test('an unavailable observation remains the endpoint and never equals another unavailable', async () => {
  const unavailable = { kind: 'unavailable', reason: 'oversize' };
  const events = [event(1, 'session.started'), event(2, 'file.baselined', { path: 'f.ts', snapshot: content('a') }),
    event(3, 'capture.baseline.completed', { unknown_scopes: [] }),
    event(4, 'file.changed', { path: 'f.ts', before: content('a'), after: unavailable, observation: 'watcher' }),
    event(5, 'file.changed', { path: 'f.ts', before: unavailable, after: unavailable, observation: 'watcher' })];
  await withLog(events, async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 4n, 5n));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.deepEqual(result.files[0]?.before, { kind: 'recorded', record_seq: '4', field: 'after', snapshot: unavailable, observation: 'watcher' });
      assert.equal(result.files[0]?.endpointsEqual, false);
    }
  });
});

test('all 67 successful fixture histories replay through the production resolver', async () => {
  let resolvedCases = 0;
  let errorCases = 0;
  for (const name of (await readdir(casesDir)).sort()) {
    const dir = join(casesDir, name);
    const entries = await readdir(dir);
    if (!entries.includes('expected.json')) {
      assert.ok(entries.includes('expected-error.json'), `${name}: no expected outcome`);
      errorCases++;
      continue;
    }
    resolvedCases++;
    const expectedText = await readFile(join(dir, 'expected.json'), 'utf8');
    const history = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')) as {
      session_id: string; durable_seq: string; events: Event[]; blobs: Record<string, string>;
      harness?: { limits?: { metadata_bytes?: number } };
    };
    const expected = JSON.parse(expectedText) as {
      files: Array<{ path: string; before: unknown; after: unknown; status: string }>;
      inventory: { baseline_completed_seq: string | null; unknown_scopes: string[]; policy_exclusions: string[] } | null;
      gaps: unknown[] | null;
    };
    const request = parseRequest(await readFile(join(dir, 'request.txt'), 'utf8'));
    assert.notEqual(typeof request, 'string', name);
    if (typeof request === 'string') continue;
    await withRawLog(history.events as unknown as Array<Record<string, unknown>>, async (logPath) => {
      const root = join(logPath, '..');
      for (const [hash, bytes] of Object.entries(history.blobs)) {
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${name}: blob hash`);
        const path = join(root, 'blobs', 'sha256', hash.slice(0, 2), hash);
        await mkdir(join(root, 'blobs', 'sha256', hash.slice(0, 2)), { recursive: true });
        await writeFile(path, bytes);
      }
      const result = await resolveRecordedRange(options(logPath, request.before, request.after, {
        durableSeq: BigInt(history.durable_seq), pathPrefix: request.pathPrefix, afterPath: request.afterPath,
      }));
      assert.equal(result.kind, 'resolved', name);
      if (result.kind !== 'resolved') return;
      // Admission-first skipped pages have no envelope metadata. FD3 still
      // resolves that history independently, so compare its raw recorded facts.
      const completed = history.events.find((e) => e.type === 'slipstream.capture.baseline.completed.v1'
        && BigInt(e.seq) <= request.after);
      assert.equal(result.inventory.baselineCompletedSeq,
        expected.inventory?.baseline_completed_seq ?? completed?.seq ?? null, name);
      assert.deepEqual(result.inventory.policyExclusions,
        expected.inventory?.policy_exclusions ?? ['store-directory', '.git', 'symlinks'], name);
      const eligible = [...new Set(history.events.filter((e) =>
        (e.type === 'slipstream.file.baselined.v1' || e.type === 'slipstream.file.changed.v1')
        && BigInt(e.seq) <= request.after && typeof e.data.path === 'string'
        && e.data.path.startsWith(request.pathPrefix)
        && (request.afterPath === null || e.data.path > request.afterPath),
      ).map((e) => e.data.path as string))].sort();
      assert.deepEqual(result.files.map((f) => f.path), eligible, `${name}: eligible paths`);
      // The resolver has no knowledge of metadata_bytes — that budget only trims
      // the public envelope (FD4). Its raw unknownScopes/gaps must still match
      // the fixture's recorded history even when the harness zeroes that budget
      // and expected.json's envelope-level fields go empty for a separate reason.
      if (history.harness?.limits?.metadata_bytes === 0 || expected.inventory === null) {
        const rawUnknownScopes = [...new Set(history.events
          .filter((e) => e.type === 'slipstream.capture.baseline.completed.v1')
          .flatMap((e) => (e.data.unknown_scopes as string[]) ?? []))].sort();
        const rawGapCount = history.events.filter((e) => e.type === 'slipstream.capture.gap.v1').length;
        assert.deepEqual(result.inventory.unknownScopes, rawUnknownScopes, `${name}: raw unknown scopes`);
        assert.equal(result.gaps.length, rawGapCount, `${name}: raw gap count`);
      } else {
        assert.deepEqual(result.inventory.unknownScopes, expected.inventory.unknown_scopes, name);
        assert.deepEqual(result.gaps, expected.gaps, `${name}: gaps`);
      }
      for (const file of expected.files) {
        const actual: RangeFile | undefined = result.files.find((candidate: RangeFile) => candidate.path === file.path);
        assert.ok(actual, `${name}: missing ${file.path}`);
        assert.deepEqual(actual.before, file.before, `${name}: before ${file.path}`);
        assert.deepEqual(actual.after, file.after, `${name}: after ${file.path}`);
        if (file.status === 'identical') assert.equal(actual.endpointsEqual, true, `${name}: equal tags`);
        for (const endpoint of [actual.before, actual.after] as RangeEndpoint[]) {
          if (endpoint.kind !== 'recorded' || endpoint.snapshot.kind !== 'content') continue;
          const hash: string = endpoint.snapshot.sha256;
          if (!Object.hasOwn(history.blobs, hash)) continue; // declared missing blobs belong to FD4
          const blob = await readFile(join(root, 'blobs', 'sha256', hash.slice(0, 2), hash));
          assert.equal(createHash('sha256').update(blob).digest('hex'), hash, `${name}: endpoint blob`);
          assert.equal(blob.length, endpoint.snapshot.size, `${name}: endpoint size`);
        }
      }
      assert.deepEqual(result.files.filter((f) => expected.files.some((e) => e.path === f.path)).map((f) => f.path),
        expected.files.map((f) => f.path), `${name}: expected row order`);
    });
  }
  assert.equal(resolvedCases, 67);
  assert.equal(errorCases, 4);
});

test('a contradictory predecessor anywhere through A is corruption, even outside the filter', async () => {
  const events = [event(1, 'session.started'),
    event(2, 'file.baselined', { path: 'hidden.ts', snapshot: content('a') }),
    event(3, 'capture.baseline.completed', { unknown_scopes: [] }),
    event(4, 'file.changed', { path: 'hidden.ts', before: content('a', 2), after: content('b'), observation: 'watcher' })];
  await withLog(events, async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 3n, 4n, { pathPrefix: 'visible/' })), /contradictory predecessor/);
    const valid = await resolveRecordedRange(options(logPath, 2n, 3n));
    assert.equal(valid.kind, 'resolved');
  });
});

test('the first post-B baseline cannot establish a prior absence', async () => {
  const events = [event(1, 'session.started'), event(2, 'capture.baseline.completed', { unknown_scopes: [] }),
    event(3, 'file.baselined', { path: 'src/later.ts', snapshot: content('a') })];
  await withLog(events, async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 2n, 3n));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.deepEqual(result.files[0]?.before, { kind: 'unknownBoundary' });
  });
});

test('filters use exact prefix, exclusive cursor and UTF-16 order', async () => {
  const events = [event(1, 'session.started'),
    event(2, 'file.baselined', { path: 'src/\uE000.ts', snapshot: absent }),
    event(3, 'file.baselined', { path: 'src/😀.ts', snapshot: absent }),
    event(4, 'file.baselined', { path: 'other/a.ts', snapshot: absent })];
  await withLog(events, async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 0n, 4n, { pathPrefix: 'src/' }));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.deepEqual(result.files.map((f) => f.path), ['src/😀.ts', 'src/\uE000.ts']);
    const page = await resolveRecordedRange(options(logPath, 0n, 4n, { pathPrefix: 'src/', afterPath: 'src/😀.ts' }));
    assert.equal(page.kind, 'resolved');
    if (page.kind === 'resolved') assert.deepEqual(page.files.map((f) => f.path), ['src/\uE000.ts']);
  });
});

test('the durable high-water is caller supplied and arbitrary-size bigint', async () => {
  await withLog([event(1, 'session.started')], async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 0n, 18_446_744_073_709_551_616n, { durableSeq: 1n }));
    assert.deepEqual(result, { kind: 'beyondDurable' });
  });
});

test('A=0 resolves the empty recorded prefix even when no log file exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slipstream-fd3-empty-'));
  try {
    const result = await resolveRecordedRange(options(join(root, 'missing.jsonl'), 0n, 0n));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.gaps, []);
      assert.deepEqual(result.inventory, { scope: 'observed', baselineCompletedSeq: null, unknownScopes: [],
        policyExclusions: ['store-directory', '.git', 'symlinks'] });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('record and byte scan ceilings produce explicit outcomes', async () => {
  const events = [event(1, 'session.started'), event(2, 'file.baselined', { path: 'f.ts', snapshot: absent })];
  await withLog(events, async (logPath) => {
    const count = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 1, bytes: 10000 } }));
    assert.equal(count.kind, 'scanLimit');
    const bytes = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 10, bytes: 0 } }));
    assert.equal(bytes.kind, 'scanLimit');
    const exact = events.reduce((total, e) => total + Buffer.byteLength(JSON.stringify(envelope(e))) + 1, 0);
    const pass = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 2, bytes: exact } }));
    assert.equal(pass.kind, 'resolved');
  });
});

test('scan.bytes counts a stripped BOM on the first record as bytes actually read', async () => {
  const events = [event(1, 'session.started'), event(2, 'file.baselined', { path: 'f.ts', snapshot: absent })];
  await withRawLog(events.map((e) => envelope(e)), async (logPath) => {
    const exact = events.reduce((total, e) => total + Buffer.byteLength(JSON.stringify(envelope(e))) + 1, 0);
    const withoutBom = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 2, bytes: exact } }));
    assert.equal(withoutBom.kind, 'resolved');
  });

  const root = await mkdtemp(join(tmpdir(), 'slipstream-fd3-bom-'));
  try {
    const logPath = join(root, 'events.jsonl');
    const lines = events.map((e) => JSON.stringify(envelope(e)));
    await writeFile(logPath, '﻿' + lines[0] + '\n' + lines[1] + '\n');
    const bomBytes = Buffer.byteLength('﻿', 'utf8');
    const exact = events.reduce((total, e) => total + Buffer.byteLength(JSON.stringify(envelope(e))) + 1, 0) + bomBytes;
    // One byte short of the true on-disk total (including the BOM) must still hit the ceiling.
    const short = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 2, bytes: exact - 1 } }));
    assert.equal(short.kind, 'scanLimit');
    const exactPass = await resolveRecordedRange(options(logPath, 0n, 2n, { scanBudget: { records: 2, bytes: exact } }));
    assert.equal(exactPass.kind, 'resolved');
    if (exactPass.kind === 'resolved') assert.equal(exactPass.scan.bytes, exact);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation stops a scan and short log is corruption', async () => {
  const events = [event(1, 'session.started'), event(2, 'file.baselined', { path: 'f.ts', snapshot: absent })];
  await withLog(events, async (logPath) => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await resolveRecordedRange(options(logPath, 0n, 2n, { signal: controller.signal }));
    assert.equal(aborted.kind, 'aborted');
    let reads = 0;
    const changingSignal = { get aborted() { return ++reads > 3; } } as AbortSignal;
    const during = await resolveRecordedRange(options(logPath, 0n, 2n, { signal: changingSignal }));
    assert.equal(during.kind, 'aborted');
    if (during.kind === 'aborted') assert.equal(during.scan.records, 1);
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 3n)), /disk short/);
  });
});

test('malformed snapshots and unknown scopes are corrupt, not coverage guesses', async () => {
  await withLog([event(1, 'session.started'), event(2, 'file.baselined', {
    path: 'f.ts', snapshot: { kind: 'content', sha256: 'a'.repeat(64) },
  })], async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 2n)), /bad snapshot/);
  });
  await withLog([event(1, 'session.started'), event(2, 'capture.baseline.completed', {
    unknown_scopes: ['../outside'],
  })], async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 2n)), /bad unknown scopes/);
  });
});

test('a matching session_id with a forged envelope id or source is corrupt', async () => {
  await withRawLog([
    envelope(event(1, 'session.started')),
    { ...envelope(event(2, 'file.baselined', { path: 'f.ts', snapshot: absent })), id: '99' },
  ], async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 2n)), /envelope id/);
  });
  await withRawLog([
    envelope(event(1, 'session.started')),
    { ...envelope(event(2, 'file.baselined', { path: 'f.ts', snapshot: absent })), source: 'urn:slipstream:session:forged' },
  ], async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 2n)), /envelope source/);
  });
});

test('a path-scoped gap cannot claim the root as a file path', async () => {
  await withLog([event(1, 'session.started'), event(2, 'capture.gap', {
    reason: 'watcher-error', scope: { kind: 'path', path: '' },
  })], async (logPath) => {
    await assert.rejects(resolveRecordedRange(options(logPath, 0n, 2n)), /bad gap scope/);
  });
});

test('forward-compatible extra event fields do not invalidate a recorded snapshot', async () => {
  await withLog([event(1, 'session.started'), event(2, 'file.baselined', {
    path: 'f.ts', snapshot: { kind: 'content', sha256: 'a'.repeat(64), size: 1, future: 'data' },
  })], async (logPath) => {
    const result = await resolveRecordedRange(options(logPath, 0n, 2n));
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') {
      assert.deepEqual(result.files[0]?.after.snapshot, content('a'));
    }
  });
});

test('the corrupt-chain fixture throws and the durable-ahead fixture returns 409 input', async () => {
  for (const name of ['range-corrupt-chain-500', 'range-durable-ahead-409']) {
    const dir = join(casesDir, name);
    const history = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8')) as { events: Event[]; durable_seq: string };
    const request = parseRequest(await readFile(join(dir, 'request.txt'), 'utf8'));
    assert.notEqual(typeof request, 'string');
    if (typeof request === 'string') continue;
    await withLog(history.events, async (logPath) => {
      const call = resolveRecordedRange(options(logPath, request.before, request.after, { durableSeq: BigInt(history.durable_seq) }));
      if (name === 'range-corrupt-chain-500') await assert.rejects(call, /contradictory predecessor/);
      else assert.deepEqual(await call, { kind: 'beyondDurable' });
    });
  }
});
