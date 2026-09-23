import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptanceArgs,
  runAcceptance,
  main,
  EXIT,
  ArgError,
} from './projection-check.ts';

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
