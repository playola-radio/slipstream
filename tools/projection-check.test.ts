import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAcceptanceArgs,
  runAcceptance,
  runModule,
  runFold,
  main,
  EXIT,
  ArgError,
} from './projection-check.ts';
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
