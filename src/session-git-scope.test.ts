import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapture, type CaptureSession } from './session.ts';
import { createLog } from './log.ts';
import { StorageError } from './storage.ts';
import { GIT_TIMEOUT_MS, gitCaptureScope, type CaptureScope, type DetectCaptureScope } from './capture-scope.ts';
import { createFakePlatform } from './test/fake-platform.ts';
import { changesFor, readRecords, waitForRecords, type LoggedRecord } from './test/helpers.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UNKNOWN = { kind: 'unavailable', reason: 'baseline-unknown' };

type GitScope = Extract<CaptureScope, { policy: 'git' }>;

async function put(root: string, rel: string, body = 'x'): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), body);
}

const scopeEvents = (recs: LoggedRecord[]) => recs.filter((r) => r.type === 'slipstream.capture.scope.v1');
const baselined = (recs: LoggedRecord[]) =>
  recs.flatMap((r) => (r.type === 'slipstream.file.baselined.v1' ? [r.data.path] : []));

interface Harness {
  root: string;
  store: string;
  platform: ReturnType<typeof createFakePlatform>;
  start: (opts?: {
    resumeSessionId?: string;
    wrap?: (real: GitScope) => GitScope;
    createLog?: typeof createLog;
  }) => Promise<CaptureSession>;
}

/** A real git repository watched through the fake platform. `wrap` lets a test
 * delay or fail git's answers while keeping its real ignore semantics. */
async function withGitRepo(
  setup: (root: string) => Promise<void>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slip-gwt-')));
  const store = await mkdtemp(join(tmpdir(), 'slip-gst-'));
  const sessions: CaptureSession[] = [];
  try {
    git(root, 'init', '-q');
    await setup(root);
    const platform = createFakePlatform();
    const start: Harness['start'] = async (opts = {}) => {
      const detectScope: DetectCaptureScope = async (r, slipExcludesFile) => {
        const real = gitCaptureScope(r, GIT_TIMEOUT_MS, slipExcludesFile) as GitScope;
        return opts.wrap ? opts.wrap(real) : real;
      };
      const s = await startCapture(
        { root, storeDir: store, resumeSessionId: opts.resumeSessionId },
        { platform, detectScope, ...(opts.createLog ? { createLog: opts.createLog } : {}) },
      );
      sessions.push(s);
      return s;
    };
    await fn({ root, store, platform, start });
  } finally {
    for (const s of sessions) await s.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

const blobExists = (store: string, body: string): Promise<boolean> => {
  const h = sha(body);
  return access(join(store, 'blobs', 'sha256', h.slice(0, 2), h)).then(() => true, () => false);
};

/** A promise resolved from outside, to hold git's answer mid-flight. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

describe('session under the git capture scope', () => {
  describe('baseline', () => {
    it('discloses the git policy and never baselines or stores ignored files', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', 'node_modules/\n*.log\n');
          await put(root, 'node_modules/pkg/index.js', 'ignored dependency');
          await put(root, 'debug.log', 'ignored log');
          await put(root, 'src/a.ts', 'kept');
        },
        async ({ store, start }) => {
          const session = await start();
          const recs = await readRecords(session.logPath);
          const scope = scopeEvents(recs);
          assert.equal(scope.length, 1);
          assert.deepEqual({ ...scope[0]!.data, session_id: undefined }, { session_id: undefined, policy: 'git', status: 'active' });
          const scopeIdx = recs.indexOf(scope[0]!);
          assert.ok(recs.findIndex((r) => r.type === 'slipstream.file.baselined.v1') > scopeIdx);
          assert.deepEqual(new Set(baselined(recs)), new Set(['.gitignore', 'src/a.ts']));
          assert.equal(await blobExists(store, 'ignored dependency'), false);
          assert.equal(await blobExists(store, 'ignored log'), false);
        },
      );
    });

    it('never baselines an ignored file created while the baseline walk runs', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', '*.log\n');
          await put(root, 'src/a.ts', 'kept');
        },
        async ({ root, store, start }) => {
          const session = await start({
            wrap: (real) => ({
              ...real,
              ignoredEntries: async () => {
                const entries = await real.ignoredEntries();
                await put(root, 'secret.log', 'created mid-walk');
                return entries;
              },
            }),
          });
          const recs = await readRecords(session.logPath);
          assert.deepEqual(new Set(baselined(recs)), new Set(['.gitignore', 'src/a.ts']));
          assert.equal(await blobExists(store, 'created mid-walk'), false);
        },
      );
    });

    it('still baselines a tracked file inside an ignored pattern', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', 'build/\n');
          await put(root, 'build/kept.txt', 'tracked');
          git(root, 'add', '-f', 'build/kept.txt');
          await put(root, 'build/out.js', 'generated');
        },
        async ({ start }) => {
          const session = await start();
          const paths = baselined(await readRecords(session.logPath));
          assert.ok(paths.includes('build/kept.txt'));
          assert.ok(!paths.includes('build/out.js'));
        },
      );
    });
  });

  describe('live capture', () => {
    it('drops ignored observations and captures the rest', async () => {
      await withGitRepo(
        async (root) => { await put(root, '.gitignore', '.gstack/\n*.tmp\n'); },
        async ({ root, platform, start }) => {
          const session = await start();
          await put(root, '.gstack/state.json', 'tool noise');
          await put(root, 'notes.tmp', 'temp noise');
          await put(root, 'src/new.ts', 'real work');
          platform.observe('.gstack/state.json');
          platform.observe('notes.tmp');
          platform.observe('src/new.ts');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'src/new.ts').length >= 1);
          assert.deepEqual(changesFor(recs, 'src/new.ts')[0]!.data.before, { kind: 'absent' });
          assert.equal(changesFor(recs, '.gstack/state.json').length, 0);
          assert.equal(changesFor(recs, 'notes.tmp').length, 0);
        },
      );
    });

    it('reports an unknown prior state for a file that comes into scope after being ignored', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', '*.log\n');
          await put(root, 'existing.log', 'there at attach');
        },
        async ({ root, platform, start }) => {
          const session = await start();
          await put(root, 'later.log', 'created while ignored');
          platform.observe('later.log');
          await put(root, 'marker.ts', 'm');
          platform.observe('marker.ts');
          await waitForRecords(session.logPath, (r) => changesFor(r, 'marker.ts').length >= 1);

          await writeFile(join(root, '.gitignore'), '');
          platform.observe('.gitignore');
          await writeFile(join(root, 'existing.log'), 'edited once in scope');
          await writeFile(join(root, 'later.log'), 'edited once in scope too');
          platform.observe('existing.log');
          platform.observe('later.log');
          const recs = await waitForRecords(
            session.logPath,
            (r) => changesFor(r, 'existing.log').length >= 1 && changesFor(r, 'later.log').length >= 1,
          );
          assert.deepEqual(changesFor(recs, 'existing.log')[0]!.data.before, UNKNOWN);
          assert.deepEqual(changesFor(recs, 'later.log')[0]!.data.before, UNKNOWN);
        },
      );
    });

    it('records the deletion of a file captured after it stopped being ignored', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', '*.log\n');
          await put(root, 'existing.log', 'there at attach');
        },
        async ({ root, platform, start }) => {
          const session = await start();
          await writeFile(join(root, '.gitignore'), '');
          platform.observe('.gitignore');
          await writeFile(join(root, 'existing.log'), 'edited once in scope');
          platform.observe('existing.log');
          await waitForRecords(session.logPath, (r) => changesFor(r, 'existing.log').length >= 1);

          await rm(join(root, 'existing.log'));
          platform.observe('existing.log');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'existing.log').length >= 2);
          assert.deepEqual(changesFor(recs, 'existing.log')[1]!.data.after, { kind: 'absent' });
        },
      );
    });

    it('records the deletion of a captured file after a rule briefly ignored it', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, 'a.txt', 'v1');
        },
        async ({ root, platform, start }) => {
          const session = await start();
          await writeFile(join(root, '.gitignore'), 'a.txt\n');
          await writeFile(join(root, 'a.txt'), 'edited while ignored');
          platform.observe('a.txt');
          await put(root, 'marker1.ts', 'm');
          platform.observe('marker1.ts');
          await waitForRecords(session.logPath, (r) => changesFor(r, 'marker1.ts').length >= 1);

          await writeFile(join(root, '.gitignore'), '');
          await rm(join(root, 'a.txt'));
          platform.observe('a.txt');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'a.txt').length >= 1);
          const change = changesFor(recs, 'a.txt')[0]!;
          assert.equal(change.data.before.kind, 'content');
          assert.deepEqual(change.data.after, { kind: 'absent' });
        },
      );
    });

    it('records nothing when an ignored directory is deleted', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', 'dist/\n');
          await put(root, 'dist/old.js', 'old build');
        },
        async ({ root, platform, start }) => {
          const session = await start();
          // Rebuild: delete the baseline output, create it again, delete again.
          await rm(join(root, 'dist'), { recursive: true });
          platform.observe('dist/old.js');
          platform.observe('dist');
          await put(root, 'dist/new.js', 'new build');
          platform.observe('dist');
          platform.observe('dist/new.js');
          await rm(join(root, 'dist'), { recursive: true });
          platform.observe('dist/new.js');
          platform.observe('dist');
          await put(root, 'marker.ts', 'm');
          platform.observe('marker.ts');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'marker.ts').length >= 1);
          const noise = recs.filter((r) => r.type === 'slipstream.file.changed.v1' && r.data.path.startsWith('dist'));
          assert.deepEqual(noise, []);
        },
      );
    });

    it('classifies observations buffered during the baseline once live', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', '*.log\n');
          await put(root, 'seed.ts', 'seed');
        },
        async ({ root, platform, start }) => {
          const session = await start({
            wrap: (real) => ({
              ...real,
              ignoredEntries: async () => {
                // Edits land while the baseline walk is under way.
                await put(root, 'during.ts', 'during baseline');
                await put(root, 'during.log', 'ignored during baseline');
                platform.observe('during.ts');
                platform.observe('during.log');
                return real.ignoredEntries();
              },
            }),
          });
          const recs = await waitForRecords(session.logPath, (r) =>
            changesFor(r, 'during.ts').length >= 1 || baselined(r).includes('during.ts'));
          await session.stop();
          const all = await readRecords(session.logPath);
          assert.equal(changesFor(all, 'during.log').length, 0);
          assert.ok(!baselined(recs).includes('during.log'));
        },
      );
    });
  });

  describe('when git cannot answer', () => {
    it('drops the batch, discloses the outage once, and recovers', async () => {
      await withGitRepo(
        async () => {},
        async ({ root, platform, start }) => {
          let failing = false;
          const session = await start({
            wrap: (real) => ({
              ...real,
              ignored: async (paths) => {
                if (failing) throw new Error('git exploded');
                return real.ignored(paths);
              },
            }),
          });
          failing = true;
          await put(root, 'lost.ts', 'created during the outage');
          platform.observe('lost.ts');
          await waitForRecords(session.logPath, (r) => scopeEvents(r).some((e) => e.data.status === 'unavailable'));
          await put(root, 'also-lost.ts', 'second batch');
          platform.observe('also-lost.ts');
          await new Promise((r) => setTimeout(r, 100));

          failing = false;
          await writeFile(join(root, 'lost.ts'), 'edited after the outage');
          platform.observe('lost.ts');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'lost.ts').length >= 1);
          const statuses = scopeEvents(recs).map((e) => e.data.status);
          assert.deepEqual(statuses, ['active', 'unavailable', 'active']);
          const [change] = changesFor(recs, 'lost.ts');
          assert.deepEqual(change!.data.before, UNKNOWN);
          assert.equal(change!.data.after.kind === 'content' && change!.data.after.sha256, sha('edited after the outage'));
          const activeAgain = recs.lastIndexOf(scopeEvents(recs).at(-1)!);
          assert.ok(recs.indexOf(change!) > activeAgain, 'capture resumes only after the recovery is disclosed');
          assert.equal(changesFor(recs, 'also-lost.ts').length, 0);
        },
      );
    });

    it('refuses to start when git fails on a repository', async () => {
      await withGitRepo(
        async () => {},
        async ({ root, store }) => {
          await assert.rejects(
            startCapture({ root, storeDir: store }, {
              platform: createFakePlatform(),
              detectScope: async () => { throw new Error('dubious ownership'); },
            }),
            /dubious ownership/,
          );
        },
      );
    });

    it('fails the start when git cannot list ignored entries for the baseline', async () => {
      await withGitRepo(
        async () => {},
        async ({ start }) => {
          await assert.rejects(
            start({ wrap: (real) => ({ ...real, ignoredEntries: async () => { throw new Error('ls-files died'); } }) }),
            /ls-files died/,
          );
        },
      );
    });
  });

  describe('stop', () => {
    it('waits for an in-flight classification so an observed edit is not lost', async () => {
      await withGitRepo(
        async () => {},
        async ({ root, platform, start }) => {
          const held = gate();
          let armed = false;
          let calls = 0;
          const session = await start({
            wrap: (real) => ({
              ...real,
              ignored: async (paths) => {
                if (!armed) return real.ignored(paths);
                calls += 1;
                await held.wait;
                return real.ignored(paths);
              },
            }),
          });
          armed = true;
          await put(root, 'last.ts', 'final edit');
          platform.observe('last.ts');
          while (calls === 0) await new Promise((r) => setTimeout(r, 5));
          const stopping = session.stop();
          held.open();
          await stopping;
          assert.equal(changesFor(await readRecords(session.logPath), 'last.ts').length, 1);
        },
      );
    });
  });

  describe('storage recovery', () => {
    it('keeps the log consistent when git answers while capture is suspended', async () => {
      await withGitRepo(
        async (root) => { await put(root, 'a.ts', 'v1'); },
        async ({ root, platform, start }) => {
          let diskFull = false;
          const failingLog: typeof createLog = async (o) => {
            const real = await createLog(o);
            return {
              durableSeq: () => real.durableSeq(),
              close: () => real.close(),
              append: async (input) => {
                if (diskFull) throw new StorageError('append', Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
                return real.append(input);
              },
            };
          };
          const held = gate();
          let armed = false;
          let firstCall = true;
          const session = await start({
            createLog: failingLog,
            wrap: (real) => ({
              ...real,
              ignored: async (paths) => {
                if (armed && firstCall) {
                  firstCall = false;
                  await held.wait;
                }
                return real.ignored(paths);
              },
            }),
          });
          armed = true;
          await writeFile(join(root, 'a.ts'), 'v2');
          platform.observe('a.ts');
          diskFull = true;
          await session.beginTask({ title: 't', requestId: 'r' }).catch(() => {});
          while (session.health.snapshot().state !== 'failing') await new Promise((r) => setTimeout(r, 5));
          await new Promise((r) => setTimeout(r, 100)); // past the first recovery attempt, which suspends capture
          held.open(); // git answers while capture is suspended
          await new Promise((r) => setTimeout(r, 50));
          diskFull = false;
          await waitForRecords(session.logPath, (r) =>
            r.some((x) => x.type === 'slipstream.capture.gap.v1' && x.data.reason === 'storage'));
          while (session.health.snapshot().state !== 'healthy') await new Promise((r) => setTimeout(r, 5));
          await session.stop();

          const recs = await readRecords(session.logPath);
          const last = changesFor(recs, 'a.ts').at(-1);
          assert.ok(last && last.data.after.kind === 'content' && last.data.after.sha256 === sha('v2'));
          // Replaying the log checks every change against its predecessor.
          const resumed = await start({ resumeSessionId: session.sessionId });
          await resumed.stop();
        },
      );
    });
  });

  describe('very large batches', () => {
    it('puts a huge batch back intact when capture is suspended mid-classification', async (t) => {
      await withGitRepo(
        async (root) => { await put(root, 'a.ts', 'v1'); },
        async ({ root, platform, start }) => {
          let diskFull = false;
          const failingLog: typeof createLog = async (o) => {
            const real = await createLog(o);
            return {
              durableSeq: () => real.durableSeq(),
              close: () => real.close(),
              append: async (input) => {
                if (diskFull) throw new StorageError('append', Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
                return real.append(input);
              },
            };
          };
          const first = gate();
          const second = gate();
          const secondAsked = gate();
          let armed = false;
          let calls = 0;
          const session = await start({
            createLog: failingLog,
            wrap: (real) => ({
              ...real,
              ignored: async (paths) => {
                if (!armed) return real.ignored(paths);
                calls += 1;
                if (calls === 1) await first.wait;
                if (calls === 2) {
                  secondAsked.open();
                  await second.wait;
                }
                return real.ignored(paths);
              },
            }),
          });
          const errors: string[] = [];
          const consoleError = console.error;
          console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
          t.after(() => { console.error = consoleError; });
          armed = true;
          platform.observe('a.ts');
          await writeFile(join(root, 'a.ts'), 'v2');
          for (let i = 0; i < 200_000; i += 1) platform.observe('a.ts');
          first.open();
          await secondAsked.wait;
          diskFull = true;
          await session.beginTask({ title: 't', requestId: 'r' }).catch(() => {});
          while (session.health.snapshot().state !== 'failing') await new Promise((r) => setTimeout(r, 5));
          await new Promise((r) => setTimeout(r, 100)); // past the first recovery attempt, which suspends capture
          second.open();
          await new Promise((r) => setTimeout(r, 50));
          diskFull = false;
          while (session.health.snapshot().state !== 'healthy') await new Promise((r) => setTimeout(r, 5));
          await session.stop();

          const last = changesFor(await readRecords(session.logPath), 'a.ts').at(-1);
          assert.ok(last && last.data.after.kind === 'content' && last.data.after.sha256 === sha('v2'));
          assert.deepEqual(errors.filter((m) => m.includes('classification failed')), []);
        },
      );
    });
  });

  describe('restart reconciliation', () => {
    it('discloses the scope again and never reads a recorded path that became ignored', async () => {
      await withGitRepo(
        async (root) => { await put(root, 'gen.txt', 'v1'); },
        async ({ root, store, start }) => {
          const first = await start();
          const sessionId = first.sessionId;
          await first.stop();

          await put(root, '.gitignore', 'gen.txt\n');
          await writeFile(join(root, 'gen.txt'), 'v2 while ignored');
          const resumed = await start({ resumeSessionId: sessionId });
          const recs = await readRecords(resumed.logPath);
          assert.equal(scopeEvents(recs).length, 2);
          assert.equal(changesFor(recs, 'gen.txt').length, 0);
          assert.equal(await blobExists(store, 'v2 while ignored'), false);
        },
      );
    });

    it('reports an unknown prior state for paths first seen at reconciliation', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.gitignore', '*.log\n');
          await put(root, 'was-ignored.log', 'ignored at attach');
        },
        async ({ root, start }) => {
          const first = await start();
          const sessionId = first.sessionId;
          await first.stop();

          await writeFile(join(root, '.gitignore'), '');
          await put(root, 'brand-new.ts', 'created while down');
          const resumed = await start({ resumeSessionId: sessionId });
          const recs = await readRecords(resumed.logPath);
          assert.deepEqual(changesFor(recs, 'was-ignored.log')[0]!.data.before, UNKNOWN);
          assert.deepEqual(changesFor(recs, 'brand-new.ts')[0]!.data.before, UNKNOWN);
        },
      );
    });
  });

  describe('outside a repository', () => {
    it('captures everything and says why', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      const store = await mkdtemp(join(tmpdir(), 'slip-gst-'));
      try {
        await put(root, 'debug.log', 'kept: no git here');
        const session = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
        try {
          const recs = await readRecords(session.logPath);
          const [scope] = scopeEvents(recs);
          assert.equal(scope!.data.policy, 'filesystem');
          assert.ok(baselined(recs).includes('debug.log'));
        } finally {
          await session.stop();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(store, { recursive: true, force: true });
      }
    });

    it('does not honor a .slipstreamignore without git', async () => {
      const root = await mkdtemp(join(tmpdir(), 'slip-nogit-'));
      const store = await mkdtemp(join(tmpdir(), 'slip-gst-'));
      try {
        await put(root, '.slipstreamignore', 'scratch.bin\n');
        await put(root, 'scratch.bin', 'kept: a non-git root ignores the file');
        const session = await startCapture({ root, storeDir: store }, { platform: createFakePlatform() });
        try {
          const recs = await readRecords(session.logPath);
          const [scope] = scopeEvents(recs);
          assert.equal(scope!.data.policy, 'filesystem');
          assert.equal('slipstream_ignore' in scope!.data, false);
          assert.ok(baselined(recs).includes('scratch.bin'));
        } finally {
          await session.stop();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(store, { recursive: true, force: true });
      }
    });
  });

  describe('the slipstream ignore layer', () => {
    it('excludes extra paths it names, including a tracked file, and discloses the layer', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, 'tracked-secret.txt', 'committed secret');
          git(root, 'config', 'user.email', 'test@example.com');
          git(root, 'config', 'user.name', 'Test');
          git(root, 'add', 'tracked-secret.txt');
          git(root, 'commit', '-qm', 'init');
          await put(root, 'notes.ts', 'kept');
          await put(root, 'scratch.bin', 'slip-excluded');
          await put(root, '.slipstreamignore', 'tracked-secret.txt\nscratch.bin\n');
        },
        async ({ store, start }) => {
          const session = await start();
          const recs = await readRecords(session.logPath);
          const scope = scopeEvents(recs);
          assert.equal(scope.length, 1);
          assert.deepEqual(
            { ...scope[0]!.data, session_id: undefined },
            { session_id: undefined, policy: 'git', status: 'active', slipstream_ignore: 'active' },
          );
          const b = new Set(baselined(recs));
          assert.equal(b.has('tracked-secret.txt'), false);
          assert.equal(b.has('scratch.bin'), false);
          assert.ok(b.has('notes.ts'));
          assert.ok(b.has('.slipstreamignore'));
          assert.equal(await blobExists(store, 'committed secret'), false);
          assert.equal(await blobExists(store, 'slip-excluded'), false);
        },
      );
    });

    it('refuses to start when .slipstreamignore is not a regular file', async () => {
      await withGitRepo(
        async (root) => { await mkdir(join(root, '.slipstreamignore')); },
        async ({ start }) => {
          await assert.rejects(start(), /not a regular file/);
        },
      );
    });

    it('freezes the rules so deleting .slipstreamignore mid-capture does not widen scope', async () => {
      await withGitRepo(
        async (root) => {
          await put(root, '.slipstreamignore', 'scratch.bin\n');
          await put(root, 'notes.ts', 'kept');
        },
        async ({ root, platform, start }) => {
          const session = await start();
          // The frozen copy still applies even after the source file is gone.
          await rm(join(root, '.slipstreamignore'), { force: true });
          await put(root, 'scratch.bin', 'created live');
          await put(root, 'marker.ts', 'kept');
          platform.observe('scratch.bin');
          platform.observe('marker.ts');
          const recs = await waitForRecords(session.logPath, (r) => changesFor(r, 'marker.ts').length >= 1);
          assert.equal(changesFor(recs, 'scratch.bin').length, 0);
        },
      );
    });
  });
});
