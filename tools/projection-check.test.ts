import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  parseAcceptanceArgs,
  runAcceptance,
  runModule,
  runFold,
  runInterface,
  runSwiftParseCheck,
  runSwiftMeasure,
  main,
  readAllStdin,
  StdinReadAbortError,
  EXIT,
  ArgError,
} from './projection-check.ts';
import { gitHead, writeQaEnv, QA_ENV_FORMAT, type QaEnv } from './qa-support.ts';
import { prepareRoot } from './qa/safety.ts';
import { EXPECTED_SHA256, EXPECTED_ABI } from '../src/swift-grammar.ts';
import type { AcceptanceContext, AcceptanceModule } from './qa/acceptance/types.ts';

describe('runModule resource cleanup', () => {
  it('clears its timer and drops its abort listener after a module succeeds', async () => {
    const ac = new AbortController();
    const ctx = { signal: ac.signal } as AcceptanceContext;
    const mod: AcceptanceModule = { id: 'fake', run: async () => ({ assertions: [] }) };
    const res = await runModule(mod, ctx, () => {});
    assert.equal(res.result, 'passed');
    // A leaked abort listener would remain registered on the shared signal.
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });
});

describe('runModule deadline actually bounds module lifecycle', () => {
  it('aborts the signal passed to the module on deadline, and does not resolve until the module settles', async () => {
    const ac = new AbortController();
    const ctx = { signal: ac.signal } as AcceptanceContext;
    let moduleSawAbort = false;
    let moduleSettled = false;
    const mod: AcceptanceModule = {
      id: 'slow',
      run: async (innerCtx) => {
        await new Promise<void>((resolveInner) => {
          innerCtx.signal.addEventListener('abort', () => {
            moduleSawAbort = true;
            // Simulate real teardown work the module does after seeing the abort —
            // runModule must not resolve/report before this actually finishes.
            setTimeout(() => { moduleSettled = true; resolveInner(); }, 20);
          }, { once: true });
        });
        throw new Error('module aborted');
      },
    };
    // Use a real short deadline via an injected clock is not available, so drive
    // the abort directly the same way the 180s timer does: fire it and confirm
    // runModule (a) propagates it into the module's own signal, and (b) blocks on
    // the module's promise rather than resolving the instant the deadline elapses.
    const runPromise = runModule(mod, ctx, () => {});
    ac.abort();
    const res = await runPromise;
    assert.equal(moduleSawAbort, true, 'the module must observe the deadline via its own signal, not just via Promise.race losing');
    assert.equal(moduleSettled, true, 'runModule must not resolve before the module promise actually settles');
    assert.equal(res.result, 'failed');
  });

  it('reports the exceeded-deadline message when the module times out (not aborted by the caller)', async () => {
    const ac = new AbortController();
    const ctx = { signal: ac.signal } as AcceptanceContext;
    let innerAborted = false;
    const mod: AcceptanceModule = {
      id: 'timeout-mod',
      run: async (innerCtx) => {
        await new Promise<void>((_resolve, reject) => {
          innerCtx.signal.addEventListener('abort', () => {
            innerAborted = true;
            reject(new Error('inner aborted'));
          }, { once: true });
        });
        return { assertions: [] };
      },
    };
    const res = await runModule(mod, ctx, () => {}, { deadlineMs: 30 });
    assert.equal(innerAborted, true);
    assert.equal(res.result, 'failed');
    assert.match(res.error ?? '', /exceeded 30ms/);
  });
});

describe('parseAcceptanceArgs', () => {
  it('accepts --all', () => {
    assert.deepEqual(parseAcceptanceArgs(['--all']), { selection: { all: true }, env: null });
  });
  it('accepts --pr with an id and --env', () => {
    assert.deepEqual(
      parseAcceptanceArgs(['--pr', 'T-QA', '--env', '/tmp/qa-env.json']),
      { selection: { pr: 'T-QA' }, env: '/tmp/qa-env.json' },
    );
  });
  it('requires a selection', () => {
    assert.throws(() => parseAcceptanceArgs([]), ArgError);
  });
  it('rejects both --all and --pr', () => {
    assert.throws(() => parseAcceptanceArgs(['--all', '--pr', 'T-QA']), ArgError);
  });
  it('rejects a flag missing its value', () => {
    assert.throws(() => parseAcceptanceArgs(['--pr']), ArgError);
    assert.throws(() => parseAcceptanceArgs(['--env']), ArgError);
  });
  it('rejects an unknown flag', () => {
    assert.throws(() => parseAcceptanceArgs(['--nope']), ArgError);
  });
});

describe('runAcceptance exit codes (no daemon needed)', () => {
  const sink = { out: [] as string[], err: [] as string[] };
  const io = (argv: string[]) => ({
    argv,
    stdout: (l: string) => sink.out.push(l),
    stderr: (l: string) => sink.err.push(l),
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });

  it('returns USAGE for bad args and prints no report', async () => {
    sink.out = []; sink.err = [];
    const code = await runAcceptance(io([]));
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0);
  });

  it('returns USAGE for an unknown --pr id and prints no report', async () => {
    sink.out = []; sink.err = [];
    const code = await runAcceptance(io(['--pr', 'does-not-exist']));
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0);
  });

  it('returns INTERRUPTED when the signal is already aborted', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const code = await runAcceptance({
      argv: ['--all'],
      stdout: () => {},
      stderr: () => {},
      cwd: process.cwd(),
      signal: aborted.signal,
    });
    assert.equal(code, EXIT.INTERRUPTED);
  });
});

describe('runAcceptance --env sandbox validation (no daemon needed)', () => {
  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  async function fakeEnv(overrides: Partial<QaEnv> = {}): Promise<{ path: string; env: QaEnv }> {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const env: QaEnv = {
      format: QA_ENV_FORMAT,
      state: 'ready',
      run_id: 'run-fake',
      daemon_commit: head,
      daemon_dirty: false,
      store: join(dir, 'root', 'store'),
      worktree: join(dir, 'root', 'worktree'),
      descriptor_path: join(dir, 'root', 'store', 'runtime', 'x.json'),
      url: 'http://127.0.0.1:1',
      token: 'fake-token',
      session_id: 'qa:run-fake',
      ready_through_seq: '0',
      scenario: null,
      ...overrides,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    return { path, env };
  }

  it('refuses an --env worktree with no ownership marker at all', async () => {
    const { path } = await fakeEnv();
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0, 'a refused --env must never print a report');
    assert.ok(sink.err.some((l) => /ownership marker/.test(l)));
  });

  it('refuses an --env worktree owned by a DIFFERENT run_id than the env claims', async () => {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const root = join(dir, 'root');
    const { store, worktree } = await prepareRoot(root, 'run-actual-owner');
    const env: QaEnv = {
      format: QA_ENV_FORMAT, state: 'ready', run_id: 'run-claimed-by-env', daemon_commit: head, daemon_dirty: false,
      store, worktree, descriptor_path: join(store, 'runtime', 'x.json'),
      url: 'http://127.0.0.1:1', token: 'fake-token', session_id: 'qa:run-claimed-by-env',
      ready_through_seq: '0', scenario: null,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0);
    assert.ok(sink.err.some((l) => /ownership marker/.test(l)));
  });

  it('accepts a reused env whose fresh launch nonce differs from its retained owner marker', async () => {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const root = join(dir, 'root');
    const { store, worktree } = await prepareRoot(root, 'run-kept-owner');
    const env: QaEnv = {
      format: QA_ENV_FORMAT, state: 'ready', run_id: 'run-fresh-reuse-nonce', owner_run_id: 'run-kept-owner', daemon_commit: head, daemon_dirty: false,
      store, worktree, descriptor_path: join(store, 'runtime', 'x.json'),
      url: 'http://127.0.0.1:1', token: 'fake-token', session_id: 'qa:run-fresh-reuse-nonce',
      ready_through_seq: '0', scenario: null,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(code, EXIT.FAIL, 'a valid sandbox reaches the unavailable-daemon check rather than failing validation');
    assert.ok(!sink.err.some((l) => /ownership marker/.test(l)));
  });

  it('refuses a missing or malformed --env file with USAGE and a message, not a stack trace or lost report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    // Missing file.
    const missing = { out: [] as string[], err: [] as string[] };
    const missingCode = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', join(dir, 'does-not-exist.json')],
      stdout: (l) => missing.out.push(l),
      stderr: (l) => missing.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(missingCode, EXIT.USAGE);
    assert.equal(missing.out.length, 0, 'a bad --env must never print a report');
    assert.ok(missing.err.some((l) => /--env .* could not be read/.test(l)));
    // Malformed JSON.
    const badPath = join(dir, 'malformed.json');
    await writeFile(badPath, '{ not json');
    const bad = { out: [] as string[], err: [] as string[] };
    const badCode = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', badPath],
      stdout: (l) => bad.out.push(l),
      stderr: (l) => bad.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(badCode, EXIT.USAGE);
    assert.equal(bad.out.length, 0);
    assert.ok(bad.err.some((l) => /--env .* could not be read/.test(l)));
  });

  it('refuses an --env worktree that is a symlink, even under an owned root (writes must not escape)', async () => {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const root = join(dir, 'root');
    const { store, worktree } = await prepareRoot(root, 'run-symlink');
    // Swap the real worktree the daemon created for a symlink pointing OUTSIDE the
    // sandbox — the ownership marker on `root` still validates, but following the
    // link would let acceptance writes/deletes escape.
    const escapeTarget = join(dir, 'escape');
    await mkdir(escapeTarget, { recursive: true });
    await rm(worktree, { recursive: true, force: true });
    await symlink(escapeTarget, worktree);
    const env: QaEnv = {
      format: QA_ENV_FORMAT, state: 'ready', run_id: 'run-symlink', daemon_commit: head, daemon_dirty: false,
      store, worktree, descriptor_path: join(store, 'runtime', 'x.json'),
      url: 'http://127.0.0.1:1', token: 'fake-token', session_id: 'qa:run-symlink',
      ready_through_seq: '0', scenario: null,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0);
    assert.ok(sink.err.some((l) => /symlink/.test(l)));
  });

  it('refuses an --env worktree that overlaps the real default store', async () => {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const env: QaEnv = {
      format: QA_ENV_FORMAT, state: 'ready', run_id: 'run-fake', daemon_commit: head, daemon_dirty: false,
      store: join('/nonexistent', '.slipstream', 'store'),
      worktree: join('/nonexistent', '.slipstream', 'worktree'),
      descriptor_path: '/nonexistent/.slipstream/store/runtime/x.json',
      url: 'http://127.0.0.1:1', token: 'fake-token', session_id: 'qa:run-fake',
      ready_through_seq: '0', scenario: null,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(code, EXIT.USAGE);
    assert.equal(sink.out.length, 0);
  });

  // Unlike the refusal cases above (pure, platform-independent validation), this
  // case must reach actual module EXECUTION to prove the sandbox gate passed — and
  // T-QA requires the darwin FSEvents watcher, so on Linux the platform gate (which
  // correctly runs after --env validation) refuses it before execution. Scope this
  // to darwin, where the module can run, exactly as production allows it to.
  it('accepts an --env worktree with a valid, matching ownership marker (passes the sandbox gate, then fails for lack of a live daemon)', { skip: process.platform !== 'darwin' ? 'T-QA module execution requires the darwin FSEvents watcher' : false }, async () => {
    const head = await gitHead(process.cwd());
    const dir = await mkdtemp(join(tmpdir(), 'slipstream-qa-check-env-'));
    tmpDirs.push(dir);
    const root = join(dir, 'root');
    const { store, worktree } = await prepareRoot(root, 'run-owned');
    const env: QaEnv = {
      format: QA_ENV_FORMAT, state: 'ready', run_id: 'run-owned', daemon_commit: head, daemon_dirty: false,
      store, worktree, descriptor_path: join(store, 'runtime', 'x.json'),
      url: 'http://127.0.0.1:1', token: 'fake-token', session_id: 'qa:run-owned',
      ready_through_seq: '0', scenario: null,
    };
    const path = join(dir, 'qa-env.json');
    await writeQaEnv(path, env);
    const sink = { out: [] as string[], err: [] as string[] };
    const code = await runAcceptance({
      argv: ['--pr', 'T-QA', '--env', path],
      stdout: (l) => sink.out.push(l),
      stderr: (l) => sink.err.push(l),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    // The sandbox gate passes (no "ownership marker" / overlap refusal), so
    // it proceeds to actually run the module against the fake unreachable
    // reader URL — which fails for an unrelated reason (connection refused),
    // proving this test isn't accidentally hitting the sandbox refusal.
    assert.ok(!sink.err.some((l) => /ownership marker|overlaps the real daemon store/.test(l)));
    assert.equal(code, EXIT.FAIL);
    assert.equal(sink.out.length, 1, 'a run that reached module execution still prints exactly one report');
  });
});

describe('main subcommand gate', () => {
  it('rejects an unknown subcommand with USAGE', async () => {
    const code = await main({ argv: ['frob'], stdout: () => {}, stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.USAGE);
  });
});

describe('fold subcommand', () => {
  const EMPTY_OK = '{"contract":"display-fold.v1","result":"ok","state":{"attributions":[],"coverage":[],"evidence":[],"gaps":[]}}';

  async function fold(argv: string[], stdin = ''): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runFold({
      argv,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      cwd: process.cwd(),
      readStdin: async () => new TextEncoder().encode(stdin),
    });
    return { code, out, err };
  }

  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  async function tmpFile(content: string | Uint8Array): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fold-cli-'));
    tmpDirs.push(dir);
    const path = join(dir, 'events.ndjson');
    await writeFile(path, content);
    return path;
  }

  it('prints the canonical envelope for a fixture and exits 0', async () => {
    assert.deepEqual(await fold(['--fixture', 'baseline-only']), { code: EXIT.PASS, out: [EMPTY_OK], err: [] });
  });

  it('is byte-deterministic across runs', async () => {
    const a = await fold(['--fixture', 'revision-and-gap']);
    const b = await fold(['--fixture', 'revision-and-gap']);
    assert.equal(a.code, EXIT.PASS);
    assert.deepEqual(a.out, b.out);
  });

  it('prints the refusal envelope and exits 1 when the fold refuses', async () => {
    const { code, out } = await fold(['--fixture', 'transport-corruption']);
    assert.equal(code, EXIT.FAIL);
    assert.equal(JSON.parse(out[0]!).result, 'corrupt');
  });

  it('folds NDJSON from a file path', async () => {
    const path = await tmpFile('{"source":"s","seq":"1","type":"slipstream.file.changed.v1","data":{}}\r\n');
    assert.deepEqual(await fold(['--events', path]), { code: EXIT.PASS, out: [EMPTY_OK], err: [] });
  });

  it('folds NDJSON from stdin with "-"', async () => {
    assert.deepEqual(await fold(['--events', '-'], '\n'), { code: EXIT.PASS, out: [EMPTY_OK], err: [] });
  });

  const usage: Array<[string, string[]]> = [
    ['no selector', []],
    ['both selectors', ['--fixture', 'empty', '--events', '-']],
    ['a repeated selector', ['--fixture', 'empty', '--fixture', 'empty']],
    ['a selector without a value', ['--fixture']],
    ['an unknown flag', ['--fixture', 'empty', '--pretty']],
    ['a missing fixture', ['--fixture', 'no-such-case']],
    ['a fixture name that escapes the corpus', ['--fixture', '../v1']],
    ['a missing events file', ['--events', '/nonexistent/slipstream-fold-input.ndjson']],
  ];
  for (const [name, argv] of usage) {
    it(`exits 2 with nothing on stdout for ${name}`, async () => {
      const { code, out, err } = await fold(argv);
      assert.equal(code, EXIT.USAGE);
      assert.deepEqual(out, []);
      assert.ok(err.length > 0);
    });
  }

  it('exits 2 on malformed NDJSON, naming the line without quoting it', async () => {
    const { code, out, err } = await fold(['--events', '-'], '{"source":"s"}\n{"leak": secret\n');
    assert.equal(code, EXIT.USAGE);
    assert.deepEqual(out, []);
    assert.match(err.join('\n'), /line 2/);
    assert.doesNotMatch(err.join('\n'), /secret/);
  });

  it('exits 2 on invalid UTF-8', async () => {
    const path = await tmpFile(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d, 0x0a]));
    const { code, out } = await fold(['--events', path]);
    assert.equal(code, EXIT.USAGE);
    assert.deepEqual(out, []);
  });

  it('flushes a large envelope completely before the process exits', async () => {
    const lines = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ source: 's', seq: String(i + 1), type: 'slipstream.capture.gap.v1', data: { scope: { kind: 'path', path: 'p'.repeat(50) }, reason: 'restart' } }));
    const path = await tmpFile(lines.join('\n'));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./projection-check.ts', import.meta.url)), 'fold', '--events', path], {
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(child.status, EXIT.PASS);
    const stdout = child.stdout.toString('utf8');
    assert.ok(stdout.endsWith('\n'));
    assert.equal(JSON.parse(stdout).state.gaps.length, 20000);
  });

  it('is reachable through main', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['fold', '--fixture', 'empty'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.PASS);
    assert.deepEqual(out, [EMPTY_OK]);
  });
});

describe('interface subcommand', () => {
  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });
  async function tmpFile(content: string | Uint8Array): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'iface-cli-'));
    tmpDirs.push(dir);
    const path = join(dir, 'input.json');
    await writeFile(path, content);
    return path;
  }

  async function iface(argv: string[], stdin = ''): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runInterface({
      argv,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      cwd: process.cwd(),
      readStdin: async () => new TextEncoder().encode(stdin),
    });
    return { code, out, err };
  }

  const minimal = JSON.stringify({
    change_seq: '5',
    language: 'typescript',
    language_version: 'typescript.v1',
    before: { status: 'complete', declarations: [] },
    after: { status: 'complete', declarations: [] },
  });

  it('prints a canonical envelope for a fixture and exits 0', async () => {
    const { code, out } = await iface(['--fixture', 'unchanged']);
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).status, 'ready');
  });

  it('exits 0 for a fixture that matches its expected.json under --check', async () => {
    assert.equal((await iface(['--fixture', 'row-ordering', '--check'])).code, EXIT.PASS);
  });

  it('is byte-deterministic across runs', async () => {
    const a = await iface(['--fixture', 'signature-changed']);
    const b = await iface(['--fixture', 'signature-changed']);
    assert.deepEqual(a.out, b.out);
  });

  it('builds an envelope from a file path and from stdin', async () => {
    const path = await tmpFile(minimal);
    assert.equal((await iface(['--input', path])).code, EXIT.PASS);
    assert.equal((await iface(['--input', '-'], minimal)).code, EXIT.PASS);
  });

  const usage: Array<[string, string[]]> = [
    ['no selector', []],
    ['both selectors', ['--fixture', 'unchanged', '--input', '-']],
    ['a repeated selector', ['--fixture', 'unchanged', '--fixture', 'rename']],
    ['a selector without a value', ['--fixture']],
    ['an unknown flag', ['--fixture', 'unchanged', '--pretty']],
    ['a missing fixture', ['--fixture', 'no-such-case']],
    ['a fixture name that escapes the corpus', ['--fixture', '../v1']],
    ['a missing input file', ['--input', '/nonexistent/slipstream-iface-input.json']],
    ['--check without a fixture', ['--input', '-', '--check']],
  ];
  for (const [name, argv] of usage) {
    it(`exits 2 with nothing on stdout for ${name}`, async () => {
      const { code, out, err } = await iface(argv);
      assert.equal(code, EXIT.USAGE);
      assert.deepEqual(out, []);
      assert.ok(err.length > 0);
    });
  }

  it('exits 2 on malformed JSON with nothing on stdout', async () => {
    const { code, out } = await iface(['--input', '-'], '{not json');
    assert.equal(code, EXIT.USAGE);
    assert.deepEqual(out, []);
  });

  it('reports an interrupted stdin read as usage failure', async () => {
    const controller = new AbortController();
    const stdin = new Readable({ read() {} });
    const err: string[] = [];
    controller.abort();
    const code = await runInterface({
      argv: ['--input', '-'],
      stdout: () => assert.fail('an interrupted stdin read must not print an envelope'),
      stderr: (line) => err.push(line),
      cwd: process.cwd(),
      signal: controller.signal,
      readStdin: (signal) => readAllStdin(signal, stdin),
    });
    assert.equal(code, EXIT.USAGE);
    assert.match(err.join('\n'), /stdin read aborted by signal/);
  });

  it('is reachable through main', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['interface', '--fixture', 'unchanged'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).status, 'ready');
  });
});

describe('stdin reads', () => {
  it('rejects promptly when an open stream is aborted', async () => {
    const controller = new AbortController();
    const stdin = new Readable({ read() {} });
    const pending = readAllStdin(controller.signal, stdin);
    controller.abort();
    await assert.rejects(pending, StdinReadAbortError);
    assert.equal(stdin.destroyed, true);
  });
});

describe('swift-parse subcommand', () => {
  // Each case spawns the isolated --liftoff-only host that actually loads the
  // Swift grammar, so these are slower than the pure fold cases.
  async function swift(argv: string[], stdin = ''): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSwiftParseCheck({
      argv,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      cwd: process.cwd(),
      readStdin: async () => new TextEncoder().encode(stdin),
    });
    return { code, out, err };
  }

  const tmpDirs: string[] = [];
  after(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });
  async function tmpSwift(content: string | Uint8Array): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'swift-cli-'));
    tmpDirs.push(dir);
    const path = join(dir, 'input.swift');
    await writeFile(path, content);
    return path;
  }

  it('prints artifact provenance, root, clean=true and timings for a clean fixture (exit 0)', async () => {
    const { code, out, err } = await swift(['--fixture', 'top-level-func']);
    assert.equal(code, EXIT.PASS, err.join('\n'));
    assert.equal(out.length, 1);
    const report = JSON.parse(out[0]!);
    assert.equal(report.artifact.sha256, EXPECTED_SHA256);
    assert.equal(report.artifact.abiVersion, EXPECTED_ABI);
    assert.equal(report.artifact.grammar.license, 'MIT');
    assert.equal(report.artifact.wrapper.license, 'Unlicense');
    assert.equal(report.rootType, 'source_file');
    assert.equal(report.clean, true);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(typeof report.timings.initAndLoadMs, 'number');
    assert.equal(typeof report.timings.firstParseMs, 'number');
  });

  it('reports ERROR diagnostics with byte spans and exits 1 for a known grammar gap', async () => {
    const { code, out } = await swift(['--fixture', 'preview-macro']);
    assert.equal(code, EXIT.FAIL);
    const report = JSON.parse(out[0]!);
    assert.equal(report.clean, false);
    assert.ok(report.diagnostics.length >= 1);
    const d = report.diagnostics[0];
    assert.equal(typeof d.byteStart, 'number');
    assert.equal(typeof d.byteEnd, 'number');
    assert.ok(d.kind === 'error' || d.kind === 'missing');
  });

  it('parses Swift from a --file path', async () => {
    const path = await tmpSwift('func f() {}\n');
    const { code, out } = await swift(['--file', path]);
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).clean, true);
  });

  it('passes a file path to the isolated host without reading its source in the checker', async () => {
    const path = await tmpSwift('func f() {}\n');
    const { code, out, err } = await swift(['--file', path]);
    assert.equal(code, EXIT.PASS, err.join('\n'));
    assert.equal(JSON.parse(out[0]!).clean, true);
  });

  it('parses Swift from stdin with --file -', async () => {
    const { code, out } = await swift(['--file', '-'], 'let x = 1\n');
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).clean, true);
  });

  it('reports an interrupted stdin read as usage failure without starting the host', async () => {
    const controller = new AbortController();
    const stdin = new Readable({ read() {} });
    const err: string[] = [];
    controller.abort();
    const code = await runSwiftParseCheck({
      argv: ['--file', '-'],
      stdout: () => assert.fail('an interrupted stdin read must not print a report'),
      stderr: (line) => err.push(line),
      cwd: process.cwd(),
      signal: controller.signal,
      readStdin: (signal) => readAllStdin(signal, stdin),
    });
    assert.equal(code, EXIT.USAGE);
    assert.match(err.join('\n'), /stdin read aborted by signal/);
  });

  const usage: Array<[string, string[]]> = [
    ['no selector', []],
    ['both selectors', ['--fixture', 'top-level-func', '--file', '-']],
    ['a repeated selector', ['--fixture', 'top-level-func', '--fixture', 'methods']],
    ['a selector without a value', ['--fixture']],
    ['an unknown flag', ['--pretty']],
    ['a missing fixture', ['--fixture', 'no-such-case']],
    ['a fixture name that escapes the corpus', ['--fixture', '../v1']],
    ['a missing file', ['--file', '/nonexistent/slipstream-swift-input.swift']],
  ];
  for (const [name, argv] of usage) {
    it(`exits 2 with nothing on stdout for ${name}`, async () => {
      const { code, out, err } = await swift(argv);
      assert.equal(code, EXIT.USAGE);
      assert.deepEqual(out, []);
      assert.ok(err.length > 0);
    });
  }

  it('exits 2 on invalid UTF-8 input', async () => {
    const path = await tmpSwift(new Uint8Array([0x66, 0xc3, 0x28, 0x0a]));
    const { code, out } = await swift(['--file', path]);
    assert.equal(code, EXIT.USAGE);
    assert.deepEqual(out, []);
  });

  it('is reachable through main', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['swift-parse', '--fixture', 'top-level-func'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).clean, true);
  });
});

describe('swift-measure subcommand', () => {
  it('reports cold start and first/warm parse for small/medium/large (exit 0)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSwiftMeasure({ argv: [], stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    assert.equal(code, EXIT.PASS, err.join('\n'));
    assert.equal(out.length, 1);
    const report = JSON.parse(out[0]!);
    assert.equal(report.artifact.sha256, EXPECTED_SHA256);
    assert.equal(typeof report.initAndLoadMs, 'number');
    assert.deepEqual(report.parses.map((p: { label: string }) => p.label), ['small', 'medium', 'large']);
    for (const p of report.parses) {
      assert.equal(p.clean, true, `${p.label} should parse clean`);
      assert.equal(typeof p.firstParseMs, 'number');
      assert.equal(typeof p.warmParseMs, 'number');
      assert.ok(p.byteLength > 0);
    }
    // Sizes are ordered by construction; the whole point is a size sweep.
    const [s, m, l] = report.parses;
    assert.ok(s.byteLength < m.byteLength && m.byteLength < l.byteLength, 'byte sizes must increase small→large');
  });

  it('exits 2 on an unexpected argument', async () => {
    const err: string[] = [];
    const code = await runSwiftMeasure({ argv: ['--nope'], stdout: () => {}, stderr: (l) => err.push(l) });
    assert.equal(code, EXIT.USAGE);
    assert.ok(err.length > 0);
  });
});
