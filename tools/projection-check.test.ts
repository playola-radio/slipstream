import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  parseAcceptanceArgs,
  runAcceptance,
  runModule,
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
    const code = await main({ argv: ['fold'], stdout: () => {}, stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.USAGE);
  });
});
