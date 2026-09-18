import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { startCapture, InvalidTitleError } from './session.ts';
import { createLog, type Log } from './log.ts';
import { StorageError } from './storage.ts';
import { CorruptLogError } from './recovery.ts';
import type { Health } from './health.ts';
import type { Platform } from './platform.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import {
  changesFor,
  readRecords,
  waitForRecords,
  withFakeSession,
  type LoggedRecord,
} from './test/helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// The deterministic tier: capture logic driven by the centralized FakePlatform.
// Every observation is delivered explicitly via `observe`, so nothing here
// depends on real FSEvents timing or permission enforcement. The genuinely
// platform-dependent claims live in session.os.test.ts (the real-OS tier).

/** The path a record refers to, across every event type that names one. */
function pathOf(r: LoggedRecord): string | undefined {
  if (r.type === 'slipstream.file.changed.v1' || r.type === 'slipstream.file.baselined.v1') {
    return r.data.path;
  }
  if (r.type === 'slipstream.capture.gap.v1' && 'path' in r.data.scope) return r.data.scope.path;
  return undefined;
}

async function withTempPair(fn: (root: string, store: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
  const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
  try {
    await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

async function waitForHealth(health: Health, predicate: (s: ReturnType<Health['snapshot']>) => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  for (;;) {
    if (predicate(health.snapshot())) return;
    if (Date.now() > deadline) throw new Error(`health never satisfied predicate; last=${JSON.stringify(health.snapshot())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('session', () => {
  it('releases the session lock when opening the log fails', async () => {
    await withTempPair(async (root, store) => {
      const seeded = await startCapture({ root, storeDir: store });
      const sessionId = seeded.sessionId;
      await seeded.stop();

      await assert.rejects(
        startCapture(
          { root, storeDir: store, resumeSessionId: sessionId },
          { createLog: async () => { throw new Error('open failed'); } },
        ),
        /open failed/,
      );

      const resumed = await startCapture({ root, storeDir: store, resumeSessionId: sessionId });
      await resumed.stop();
    });
  });

  it('installs the watcher before durably starting a new session', async () => {
    await withTempPair(async (root, store) => {
      const order: string[] = [];
      const fakeLog: Log = {
        append: async (input) => {
          order.push(input.type);
          return { seq: String(order.length) } as never;
        },
        durableSeq: () => BigInt(order.length),
        close: async () => {},
      };

      const session = await startCapture(
        { root, storeDir: store },
        {
          createLog: async () => fakeLog,
          platform: {
            watch: async () => {
              order.push('watcher.subscribed');
              return { close: async () => {} };
            },
          },
          enumerate: async () => {},
        },
      );
      try {
        assert.deepEqual(order.slice(0, 2), [
          'watcher.subscribed',
          'slipstream.session.started.v1',
        ]);
      } finally {
        await session.stop();
      }
    });
  });

  it('closes the watcher and log when baseline startup throws', async () => {
    await withTempPair(async (root, store) => {
      let watcherClosed = false;
      let logClosed = false;
      const fakeLog: Log = {
        append: async () => ({}) as never,
        durableSeq: () => 0n,
        close: async () => {
          logClosed = true;
        },
      };
      await assert.rejects(
        startCapture(
          { root, storeDir: store },
          {
            createLog: async () => fakeLog,
            platform: { watch: async () => ({ close: async () => { watcherClosed = true; } }) },
            enumerate: async () => { throw new Error('baseline failed'); },
          },
        ),
        /baseline failed/,
      );
      assert.equal(watcherClosed, true);
      assert.equal(logClosed, true);
    });
  });

  describe('caller-supplied sessionId', () => {
    const PRE = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

    it('starts a fresh session under the pre-generated id', async () => {
      await withTempPair(async (root, store) => {
        const session = await startCapture({ root, storeDir: store, sessionId: PRE });
        try {
          assert.equal(session.sessionId, PRE);
          assert.ok(session.logPath.includes(PRE));
          const recs = await waitForRecords(session.logPath, (r) =>
            r.some((e) => e.type === 'slipstream.session.started.v1'),
          );
          const started = recs.find((e) => e.type === 'slipstream.session.started.v1')!;
          assert.equal(started.source, `urn:slipstream:session:${PRE}`);
        } finally {
          await session.stop();
        }
      });
    });

    it('rejects a sessionId that is not a v4 UUID', async () => {
      await withTempPair(async (root, store) => {
        await assert.rejects(
          startCapture({ root, storeDir: store, sessionId: 'not-a-uuid' }),
          /sessionId/i,
        );
      });
    });

    it('rejects supplying both sessionId and resumeSessionId', async () => {
      await withTempPair(async (root, store) => {
        await assert.rejects(
          startCapture({ root, storeDir: store, sessionId: PRE, resumeSessionId: PRE }),
          /sessionId.*resumeSessionId|resumeSessionId.*sessionId/i,
        );
      });
    });

    it('rejects a fresh sessionId whose log already exists (would corrupt its sequence)', async () => {
      await withTempPair(async (root, store) => {
        const first = await startCapture({ root, storeDir: store, sessionId: PRE });
        await first.stop();
        // Re-using the same id as "fresh" must be refused: appending would restart
        // the sequence at zero over existing history. Resuming requires resumeSessionId.
        await assert.rejects(
          startCapture({ root, storeDir: store, sessionId: PRE }),
          /already exists|resumeSessionId/i,
        );
      });
    });
  });

  describe('baseline', () => {
    it('does not report pre-existing content in a dirty worktree as a new edit', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'existing.ts'), 'already here before attach');
        },
        async ({ root, observe, waitFor }) => {
          // Touch a different file to get a definite event, then assert the
          // pre-existing file produced no change record.
          await writeFile(join(root, 'trigger.ts'), 'new');
          observe('trigger.ts');
          const recs = await waitFor((r) => changesFor(r, 'trigger.ts').length >= 1);
          assert.equal(changesFor(recs, 'existing.ts').length, 0);
        },
      );
    });

    it('never fabricates absent for a file whose baseline directory was unreadable', async () => {
      await withFakeSession(
        async (root) => {
          await mkdir(join(root, 'locked'));
          await writeFile(join(root, 'locked', 'existing.ts'), 'pre-existing');
        },
        async ({ root, observe, waitFor }) => {
          const rel = join('locked', 'existing.ts');
          await writeFile(join(root, 'locked', 'existing.ts'), 'changed after restore');
          observe(rel);
          const recs = await waitFor((r) => changesFor(r, rel).length >= 1);
          // The incomplete baseline is disclosed as a gap...
          const isLockedGap = (x: LoggedRecord) =>
            x.type === 'slipstream.capture.gap.v1' &&
            x.data.reason === 'baseline-unreadable' &&
            'path' in x.data.scope &&
            x.data.scope.path === 'locked';
          assert.ok(
            recs.some(isLockedGap),
            'expected a baseline-unreadable gap for the locked directory',
          );
          // ...and the later change carries an honest unavailable/baseline-unknown
          // before-state, never a fabricated absent implying a brand-new file.
          const [c] = changesFor(recs, rel);
          assert.ok(c);
          assert.equal(c.data.before.kind, 'unavailable');
          if (c.data.before.kind === 'unavailable') assert.equal(c.data.before.reason, 'baseline-unknown');
          assert.equal(c.data.after.kind, 'content');
        },
        {
          // Simulate an unreadable 'locked' dir deterministically — no chmod, so
          // this holds even when the suite runs as root.
          enumerate: async (_root, _dir, _isExcluded, handlers) => {
            await handlers.onDirError('locked');
          },
        },
      );
    });
  });

  describe('capture', () => {
    it('emits absent -> content when a file is created', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'created.ts'), 'hello world');
          observe('created.ts');
          const recs = await waitFor((r) => changesFor(r, 'created.ts').length >= 1);
          const [c] = changesFor(recs, 'created.ts');
          assert.ok(c);
          assert.equal(c.data.before.kind, 'absent');
          assert.equal(c.data.after.kind, 'content');
        },
      );
    });

    it('emits content -> content with the new bytes when a baselined file is modified', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'f.ts'), 'v1');
        },
        async ({ root, session, observe, waitFor }) => {
          await writeFile(join(root, 'f.ts'), 'v2-changed');
          observe('f.ts');
          const recs = await waitFor((r) => changesFor(r, 'f.ts').length >= 1);
          const [c] = changesFor(recs, 'f.ts');
          if (c && c.data.after.kind === 'content') {
            const { sha256 } = c.data.after;
            const stored = await readFile(join(session.blobsDir, 'sha256', sha256.slice(0, 2), sha256), 'utf8');
            assert.equal(stored, 'v2-changed');
          } else {
            assert.fail('expected a content change');
          }
        },
      );
    });

    it('emits content -> absent when a file is deleted', async () => {
      await withFakeSession(
        async (root) => {
          await writeFile(join(root, 'doomed.ts'), 'bye');
        },
        async ({ root, observe, waitFor }) => {
          await rm(join(root, 'doomed.ts'));
          observe('doomed.ts');
          const recs = await waitFor((r) =>
            changesFor(r, 'doomed.ts').some((c) => c.data.after.kind === 'absent'),
          );
          const c = changesFor(recs, 'doomed.ts').at(-1);
          if (c) assert.equal(c.data.after.kind, 'absent');
          else assert.fail('expected a deletion');
        },
      );
    });

    it('captures an empty file as a zero-byte content snapshot, not absent', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'empty.ts'), '');
          observe('empty.ts');
          const recs = await waitFor((r) => changesFor(r, 'empty.ts').length >= 1);
          const [c] = changesFor(recs, 'empty.ts');
          assert.ok(c);
          assert.equal(c.data.after.kind, 'content');
          if (c.data.after.kind === 'content') assert.equal(c.data.after.size, 0);
        },
      );
    });

    it('emits an unavailable/oversize snapshot for a large file, never a fake blob', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, 'big.ts'), Buffer.alloc(64, 1));
          observe('big.ts');
          const recs = await waitFor((r) => changesFor(r, 'big.ts').length >= 1);
          const [c] = changesFor(recs, 'big.ts');
          if (c && c.data.after.kind === 'unavailable') {
            assert.equal(c.data.after.reason, 'oversize');
          } else {
            assert.fail('expected an oversize unavailable snapshot');
          }
        },
        { maxBytes: 16 },
      );
    });

    it('captures a binary file verbatim', async () => {
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128]);
      await withFakeSession(
        async () => {},
        async ({ root, session, observe, waitFor }) => {
          await writeFile(join(root, 'blob.bin'), bytes);
          observe('blob.bin');
          const recs = await waitFor((r) => changesFor(r, 'blob.bin').length >= 1);
          const [c] = changesFor(recs, 'blob.bin');
          if (c && c.data.after.kind === 'content') {
            const { sha256 } = c.data.after;
            const stored = await readFile(join(session.blobsDir, 'sha256', sha256.slice(0, 2), sha256));
            assert.deepEqual(stored, bytes);
          } else {
            assert.fail('expected binary content');
          }
        },
      );
    });

    it('captures a file whose name merely starts with ".." rather than dropping it as an escape', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, observe, waitFor }) => {
          await writeFile(join(root, '..notes.ts'), 'kept');
          observe('..notes.ts');
          const recs = await waitFor((r) => changesFor(r, '..notes.ts').length >= 1);
          assert.ok(changesFor(recs, '..notes.ts').length >= 1, 'a "..notes.ts" file must still be captured');
        },
      );
    });
  });

  describe('restart reconciliation', () => {
    it('preserves identity and seq across a restart, drops a torn tail, resumes, and reconciles', async () => {
      await withTempPair(async (root, store) => {
        await writeFile(join(root, 'keep.ts'), 'v1');
        const s1 = await startCapture({ root, storeDir: store });
        const sessionId = s1.sessionId;
        await writeFile(join(root, 'keep.ts'), 'v2');
        await waitForRecords(s1.logPath, (r) => changesFor(r, 'keep.ts').length >= 1);
        await s1.stop();
        // Count records only after stop() has drained the engine and closed the
        // log. A single write can yield two watcher notifications (Linux inotify
        // emits IN_MODIFY + IN_CLOSE_WRITE); the second coalesces into a trailing
        // capture.gap record that lands just after the file.changed. Measuring the
        // still-live log the instant the change appears races that gap and
        // undercounts, so recovery's high-water would then exceed this snapshot.
        const recoveredThroughSeq = (await readRecords(s1.logPath)).length;

        // Interrupted append: an unterminated trailing record left by a crash.
        const torn = '{"seq":"999","specversion":"1.0","partial":tru';
        await appendFile(s1.logPath, torn);
        // A change made while the daemon was down, so reconciliation has work.
        await writeFile(join(root, 'keep.ts'), 'v3-offline');

        const s2 = await startCapture({ root, storeDir: store, resumeSessionId: sessionId });
        try {
          assert.equal(s2.sessionId, sessionId);

          const recs = await readRecords(s2.logPath);
          assert.ok(!recs.some((r) => r.seq === '999'), 'torn trailing record must be discarded');

          const resumedIdx = recs.findIndex((r) => r.type === 'slipstream.session.resumed.v1');
          assert.ok(resumedIdx >= 0, 'expected a session.resumed record');
          const resumed = recs[resumedIdx]!;
          assert.equal(resumed.seq, String(recoveredThroughSeq + 1));
          if (resumed.type === 'slipstream.session.resumed.v1') {
            assert.equal(resumed.data.recovered_through_seq, String(recoveredThroughSeq));
            assert.equal(resumed.data.discarded_tail_bytes, Buffer.byteLength(torn));
          }

          const gap = recs[resumedIdx + 1]!;
          assert.equal(gap.type, 'slipstream.capture.gap.v1');
          if (gap.type === 'slipstream.capture.gap.v1') {
            assert.equal(gap.data.reason, 'restart');
            assert.equal(gap.data.scope.kind, 'session');
          }

          const reconciled = await waitForRecords(s2.logPath, (r) =>
            changesFor(r, 'keep.ts').some((c) => c.data.observation === 'reconciliation'),
          );
          const rc = changesFor(reconciled, 'keep.ts').find((c) => c.data.observation === 'reconciliation');
          assert.ok(rc, 'expected a reconciliation change for the offline edit');
          assert.equal(rc.data.gap_ref, gap.seq);
          if (rc.data.before.kind === 'content' && rc.data.after.kind === 'content') {
            assert.equal(rc.data.before.sha256, sha('v2'));
            assert.equal(rc.data.after.sha256, sha('v3-offline'));
          } else {
            assert.fail('expected content -> content reconciliation');
          }

          const seqs = (await readRecords(s2.logPath)).map((r) => Number(r.seq));
          assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq must stay contiguous with no reset');
        } finally {
          await s2.stop();
        }
      });
    });

    it('refuses to resume a session whose log is corrupt in the middle', async () => {
      await withTempPair(async (root, store) => {
        await writeFile(join(root, 'a.ts'), 'one');
        const s1 = await startCapture({ root, storeDir: store });
        const sessionId = s1.sessionId;
        await writeFile(join(root, 'a.ts'), 'two');
        await waitForRecords(s1.logPath, (r) => changesFor(r, 'a.ts').length >= 1);
        await s1.stop();

        // Corrupt a terminated record in the middle (not the trailing one).
        const lines = (await readFile(s1.logPath, 'utf8')).split('\n').filter((l) => l.length > 0);
        assert.ok(lines.length >= 3, 'need a genuine middle record to corrupt');
        lines[1] = 'GARBAGE not json';
        await writeFile(s1.logPath, lines.join('\n') + '\n');

        await assert.rejects(
          startCapture({ root, storeDir: store, resumeSessionId: sessionId }),
          CorruptLogError,
        );
      });
    });
  });

  describe('storage failure', () => {
    it('stops acknowledging on a full disk, reports failing, and records a gap once storage recovers', async () => {
      await withTempPair(async (root, store) => {
        let diskFull = false;
        const injectedCreateLog: typeof createLog = async (o) => {
          const real = await createLog(o);
          return {
            durableSeq: () => real.durableSeq(),
            close: () => real.close(),
            append: async (input) => {
              if (diskFull) {
                throw new StorageError('append', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
              }
              return real.append(input);
            },
          };
        };

        const session = await startCapture({ root, storeDir: store }, { createLog: injectedCreateLog });
        try {
          await writeFile(join(root, 'a.ts'), 'first');
          const acked = await waitForRecords(session.logPath, (r) => changesFor(r, 'a.ts').length >= 1);
          // Let health catch up to the last durable record before snapshotting the
          // baseline, so the "did not advance" check below is not racing the writer.
          await waitForHealth(
            session.health,
            (s) => s.state === 'healthy' && s.durable_seq === String(acked.length),
          );
          const durableBeforeOutage = session.health.snapshot().durable_seq;

          diskFull = true;
          await writeFile(join(root, 'a.ts'), 'second-during-outage');

          // Capture stops acknowledging: health goes failing with the storage fault.
          await waitForHealth(session.health, (s) => s.state === 'failing');
          assert.equal(session.health.snapshot().gap_pending, true);
          assert.equal(session.health.snapshot().failure?.code, 'ENOSPC');
          // The un-acked write did not advance the durable seq.
          assert.equal(session.health.snapshot().durable_seq, durableBeforeOutage);

          diskFull = false;

          // Once storage recovers, a single storage gap is disclosed and health returns.
          const recs = await waitForRecords(session.logPath, (r) =>
            r.some((x) => x.type === 'slipstream.capture.gap.v1' && x.data.reason === 'storage'),
          );
          await waitForHealth(session.health, (s) => s.state === 'healthy');
          const storageGaps = recs.filter(
            (x) => x.type === 'slipstream.capture.gap.v1' && x.data.reason === 'storage',
          );
          assert.equal(storageGaps.length, 1, 'exactly one storage gap should disclose the outage');
          // The change missed during the outage is re-baselined by reconciliation.
          const reconciled = await waitForRecords(session.logPath, (r) =>
            changesFor(r, 'a.ts').some((c) => c.data.observation === 'reconciliation'),
          );
          assert.ok(changesFor(reconciled, 'a.ts').some((c) => c.data.observation === 'reconciliation'));
        } finally {
          await session.stop();
        }
      });
    });
  });

  describe('exclusions', () => {
    it('rejects a store directory that equals the watched root', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
      try {
        await assert.rejects(startCapture({ root, storeDir: root }), /store directory.*watched root/i);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects a store directory that contains the watched root', async () => {
      const store = await mkdtemp(join(tmpdir(), 'slip-st-'));
      const root = join(store, 'worktree');
      await mkdir(root);
      try {
        await assert.rejects(startCapture({ root, storeDir: store }), /store directory.*watched root/i);
      } finally {
        await rm(store, { recursive: true, force: true });
      }
    });

    it('never captures the capture store even when it lives inside the watched root', async () => {
      // Store *inside* root is the case that matters: the exclusion is what stops
      // the watcher from observing its own log and blob writes. Verify both the
      // wiring (the store is handed to the observation source's ignore list) and
      // the behavior (a real file written inside the store is never captured,
      // while a real edit elsewhere in root is).
      const root = await mkdtemp(join(tmpdir(), 'slip-wt-'));
      const store = join(root, '.slipstream');
      const fake = createFakePlatform();
      let watchedIgnore: readonly string[] = [];
      const platform: Platform = {
        watch: async (o) => {
          watchedIgnore = o.ignore;
          return fake.watch(o);
        },
      };
      const session = await startCapture({ root, storeDir: store }, { platform });
      try {
        // session resolves symlinks in the store path (macOS /var -> /private/var),
        // so compare against the resolved form.
        const resolvedStore = await realpath(store);
        assert.ok(
          watchedIgnore.some((e) => e === resolvedStore || e.startsWith(resolvedStore + sep)),
          'the store directory must be handed to the watcher ignore list',
        );
        // A real blob inside the store: without the exclusion this would be read
        // and captured, so its absence from the log is a real signal, not a
        // vacuous one against a nonexistent path.
        const blobDir = join(store, 'blobs', 'sha256', 'ab');
        await mkdir(blobDir, { recursive: true });
        await writeFile(join(blobDir, 'deadbeef'), 'internal blob bytes');
        await writeFile(join(root, 'x.ts'), 'data');
        fake.observe(join('.slipstream', 'blobs', 'sha256', 'ab', 'deadbeef')); // store write: must be ignored
        fake.observe('x.ts');
        const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'x.ts').length >= 1);
        assert.ok(changesFor(recs, 'x.ts').length >= 1, 'a real edit inside root must be captured');
        assert.ok(
          recs.every((r) => {
            const p = pathOf(r);
            return p === undefined || !p.startsWith('.slipstream');
          }),
          'no record may reference a path inside the capture store',
        );
      } finally {
        await session.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('beginTask', () => {
    const declarations = (recs: LoggedRecord[]): LoggedRecord[] =>
      recs.filter((r) => r.type === 'slipstream.task.started.v1');

    it('declares a durable task boundary and stamps subject only on the declaration', async () => {
      await withFakeSession(
        async () => {},
        async ({ session }) => {
          const result = await session.beginTask({ title: 'Implement selection', requestId: 'req-1' });
          assert.equal(result.session_id, session.sessionId);
          assert.equal(result.event_id, result.seq, 'event_id equals seq by construction');
          assert.ok(/^[1-9][0-9]*$/.test(result.seq));

          const recs = await readRecords(session.logPath);
          const decl = recs.find((r) => r.seq === result.seq)!;
          assert.equal(decl.type, 'slipstream.task.started.v1');
          assert.equal(decl.subject, `task/${result.task_id}`);
          if (decl.type === 'slipstream.task.started.v1') {
            assert.equal(decl.data.task_id, result.task_id);
            assert.equal(decl.data.request_id, 'req-1');
            assert.equal(decl.data.title, 'Implement selection');
            assert.equal(decl.data.session_id, session.sessionId);
          }
          // Every other event omits subject entirely (absent, not empty).
          assert.ok(
            recs.every((r) => r.type === 'slipstream.task.started.v1' || r.subject === undefined),
            'only a task declaration carries a subject',
          );
        },
      );
    });

    it('replays the original result for a duplicate request_id without a second append', async () => {
      await withFakeSession(
        async () => {},
        async ({ session }) => {
          const first = await session.beginTask({ title: 'A', requestId: 'req-1' });
          const second = await session.beginTask({ title: 'A', requestId: 'req-1' });
          assert.deepEqual(second, first);
          assert.equal(declarations(await readRecords(session.logPath)).length, 1);
        },
      );
    });

    it('coalesces concurrent duplicate declarations onto a single commit', async () => {
      await withFakeSession(
        async () => {},
        async ({ session }) => {
          const [a, b, c] = await Promise.all([
            session.beginTask({ title: 'A', requestId: 'req-1' }),
            session.beginTask({ title: 'A', requestId: 'req-1' }),
            session.beginTask({ title: 'A', requestId: 'req-1' }),
          ]);
          assert.deepEqual(b, a);
          assert.deepEqual(c, a);
          assert.equal(declarations(await readRecords(session.logPath)).length, 1);
        },
      );
    });

    it('hands back a frozen result so a caller cannot corrupt the dedup cache', async () => {
      await withFakeSession(
        async () => {},
        async ({ session }) => {
          const first = await session.beginTask({ title: 'A', requestId: 'req-1' });
          assert.ok(Object.isFrozen(first));
          // A retry returns the original, uncorrupted identity — not a caller's edit.
          const replay = await session.beginTask({ title: 'A', requestId: 'req-1' });
          assert.equal(replay.task_id, first.task_id);
          assert.equal(replay.seq, first.seq);
        },
      );
    });

    it('rejects a reused request_id with a different title and appends nothing', async () => {
      await withFakeSession(
        async () => {},
        async ({ session }) => {
          await session.beginTask({ title: 'First', requestId: 'req-1' });
          await assert.rejects(
            session.beginTask({ title: 'Second', requestId: 'req-1' }),
            (err: unknown) => err instanceof InvalidTitleError && err.code === 'INVALID_TITLE',
          );
          assert.equal(declarations(await readRecords(session.logPath)).length, 1);
        },
      );
    });

    it('groups later changes under the declared task and never regroups earlier ones', async () => {
      await withFakeSession(
        async () => {},
        async ({ root, session, observe, waitFor }) => {
          // A change before any declaration is ungrouped, but still attributed.
          await writeFile(join(root, 'a.ts'), 'v1');
          observe('a.ts');
          const before = await waitFor((r) => changesFor(r, 'a.ts').length >= 1);
          const beforeChange = changesFor(before, 'a.ts')[0]!;
          assert.equal(beforeChange.data.task_hint_id, undefined);
          assert.deepEqual(beforeChange.data.attribution, { status: 'unknown' });

          const task = await session.beginTask({ title: 'Group me', requestId: 'req-1' });

          // A change after the declaration groups under it.
          await writeFile(join(root, 'b.ts'), 'v1');
          observe('b.ts');
          const after = await waitFor((r) => changesFor(r, 'b.ts').length >= 1);
          const afterChange = changesFor(after, 'b.ts')[0]!;
          assert.equal(afterChange.data.task_hint_id, task.task_id);
          assert.deepEqual(afterChange.data.attribution, { status: 'unknown' });

          // The declaration did not rewrite the change that preceded it.
          const recs = await readRecords(session.logPath);
          assert.equal(changesFor(recs, 'a.ts')[0]!.data.task_hint_id, undefined);
        },
      );
    });

    it('rebuilds the dedup index and current task across a resume', async () => {
      await withTempPair(async (root, store) => {
        const platform = createFakePlatform();
        const s1 = await startCapture({ root, storeDir: store }, { platform });
        const sessionId = s1.sessionId;
        const original = await s1.beginTask({ title: 'Persisted', requestId: 'req-1' });
        await s1.stop();

        const s2 = await startCapture({ root, storeDir: store, resumeSessionId: sessionId }, { platform });
        try {
          // Dedup index rebuilt: a replayed duplicate returns the original result
          // and appends nothing.
          const replay = await s2.beginTask({ title: 'Persisted', requestId: 'req-1' });
          assert.deepEqual(replay, original);
          assert.equal(
            declarations(await readRecords(s2.logPath)).length,
            1,
            'a replayed declaration must not re-append after resume',
          );

          // Current task pointer rebuilt: a change observed after resume groups
          // under the recovered task without a fresh declaration.
          await writeFile(join(root, 'c.ts'), 'v1');
          platform.observe('c.ts');
          const recs = await waitForRecords(s2.logPath, (r) => changesFor(r, 'c.ts').length >= 1);
          assert.equal(changesFor(recs, 'c.ts')[0]!.data.task_hint_id, original.task_id);
        } finally {
          await s2.stop();
        }
      });
    });
  });
});
