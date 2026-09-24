import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAdmissionArgs,
  checkAdmissionInvariants,
  runSaturation,
  runAdmission,
  AdmissionArgError,
  type AdmissionTrace,
} from './projection-admission-check.ts';
import { main, EXIT } from './projection-check.ts';

const tmpDirs: string[] = [];
after(async () => { for (const d of tmpDirs) await rm(d, { recursive: true, force: true }); });
async function tmpTrace(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'admission-cli-'));
  tmpDirs.push(dir);
  const path = join(dir, 'trace.json');
  await writeFile(path, content);
  return path;
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: (argv: string[]) => ({ argv, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), cwd: process.cwd() }) };
}

describe('parseAdmissionArgs', () => {
  it('defaults the saturate load', () => {
    assert.deepEqual(parseAdmissionArgs(['--saturate']), { mode: 'saturate', opts: { clip: 6, synthetic: 6, jobMs: 200 } });
  });
  it('reads load overrides', () => {
    assert.deepEqual(
      parseAdmissionArgs(['--saturate', '--clip', '3', '--synthetic', '9', '--job-ms', '40']),
      { mode: 'saturate', opts: { clip: 3, synthetic: 9, jobMs: 40 } },
    );
  });
  it('reads a check-trace path', () => {
    assert.deepEqual(parseAdmissionArgs(['--check-trace', '/tmp/t.json']), { mode: 'check-trace', path: '/tmp/t.json' });
  });
  it('requires a mode', () => {
    assert.throws(() => parseAdmissionArgs([]), AdmissionArgError);
  });
  it('rejects both modes at once', () => {
    assert.throws(() => parseAdmissionArgs(['--saturate', '--check-trace', 'x']), AdmissionArgError);
  });
  it('rejects a non-integer / negative count', () => {
    assert.throws(() => parseAdmissionArgs(['--saturate', '--clip', 'x']), AdmissionArgError);
    assert.throws(() => parseAdmissionArgs(['--saturate', '--clip', '-1']), AdmissionArgError);
  });
  it('rejects a zero job duration', () => {
    assert.throws(() => parseAdmissionArgs(['--saturate', '--job-ms', '0']), AdmissionArgError);
  });
  it('rejects an unknown flag and a valueless flag', () => {
    assert.throws(() => parseAdmissionArgs(['--saturate', '--nope']), AdmissionArgError);
    assert.throws(() => parseAdmissionArgs(['--check-trace']), AdmissionArgError);
  });
});

describe('checkAdmissionInvariants', () => {
  const base: AdmissionTrace = {
    config: { C: 2, Q: 8, W: 8, D: 100 },
    submitted: 10, admitted: 10, overloaded: 0, ok: 4, timeouts: 6, errors: 0,
    activeMax: 2, queueMax: 8,
  };
  it('accepts a trace that respects C and Q', () => {
    assert.deepEqual(checkAdmissionInvariants(base), { ok: true, violations: [] });
  });
  it('rejects a trace where active work exceeded C', () => {
    const r = checkAdmissionInvariants({ ...base, activeMax: 3 });
    assert.equal(r.ok, false);
    assert.match(r.violations.join('\n'), /active work peaked at 3.*C=2/);
  });
  it('rejects a trace where waiting work exceeded Q', () => {
    const r = checkAdmissionInvariants({ ...base, queueMax: 9 });
    assert.equal(r.ok, false);
    assert.match(r.violations.join('\n'), /waiting work peaked at 9.*Q=8/);
  });
  it('rejects a trace whose settled counts do not sum to submitted', () => {
    const r = checkAdmissionInvariants({ ...base, ok: 3 });
    assert.equal(r.ok, false);
  });
});

describe('runSaturation against the real budget', () => {
  it('keeps active work within C while producing overload and timeouts', async () => {
    const trace = await runSaturation({ clip: 6, synthetic: 6, jobMs: 200 });
    assert.ok(trace.activeMax <= trace.config.C, `activeMax=${trace.activeMax} C=${trace.config.C}`);
    assert.ok(trace.queueMax <= trace.config.Q, `queueMax=${trace.queueMax} Q=${trace.config.Q}`);
    assert.ok(trace.overloaded > 0, 'a burst past C+Q must reject some as overloaded');
    assert.ok(trace.timeouts > 0, 'work held past the admission deadline must time out');
    assert.equal(trace.overloaded + trace.ok + trace.timeouts + trace.errors, trace.submitted);
    assert.deepEqual(checkAdmissionInvariants(trace), { ok: true, violations: [] });
  });
});

describe('runAdmission CLI', () => {
  it('saturates and exits PASS with one JSON line', async () => {
    const s = sink();
    const code = await runAdmission(s.io(['--saturate', '--clip', '4', '--synthetic', '4', '--job-ms', '80']));
    assert.equal(code, EXIT.PASS);
    assert.equal(s.out.length, 1);
    const report = JSON.parse(s.out[0]!);
    assert.equal(report.invariantsHeld, true);
    assert.ok(report.activeMax <= report.config.C);
  });

  it('accepts a hand-written trace that holds the invariants', async () => {
    const path = await tmpTrace(JSON.stringify({
      config: { C: 2, Q: 8, W: 8, D: 100 },
      submitted: 2, admitted: 2, overloaded: 0, ok: 2, timeouts: 0, errors: 0, activeMax: 2, queueMax: 0,
    }));
    const s = sink();
    assert.equal(await runAdmission(s.io(['--check-trace', path])), EXIT.PASS);
  });

  it('negative control: rejects a fabricated trace where active work exceeds C (exit 1)', async () => {
    const path = await tmpTrace(JSON.stringify({
      config: { C: 2, Q: 8, W: 8, D: 100 },
      submitted: 3, admitted: 3, overloaded: 0, ok: 3, timeouts: 0, errors: 0, activeMax: 3, queueMax: 0,
    }));
    const s = sink();
    assert.equal(await runAdmission(s.io(['--check-trace', path])), EXIT.FAIL);
    const report = JSON.parse(s.out[0]!);
    assert.equal(report.invariantsHeld, false);
    assert.match(s.err.join('\n'), /INVARIANT VIOLATED/);
  });

  it('exits USAGE on bad args', async () => {
    const s = sink();
    assert.equal(await runAdmission(s.io(['--nope'])), EXIT.USAGE);
    assert.equal(s.out.length, 0);
  });

  it('exits USAGE on an unreadable trace and on invalid JSON', async () => {
    const s1 = sink();
    assert.equal(await runAdmission(s1.io(['--check-trace', '/nonexistent/slipstream-admission.json'])), EXIT.USAGE);
    const bad = await tmpTrace('{ not json');
    const s2 = sink();
    assert.equal(await runAdmission(s2.io(['--check-trace', bad])), EXIT.USAGE);
  });

  it('exits USAGE on a trace missing required fields', async () => {
    const path = await tmpTrace(JSON.stringify({ hello: 'world' }));
    const s = sink();
    assert.equal(await runAdmission(s.io(['--check-trace', path])), EXIT.USAGE);
  });

  it('rejects a partial trace instead of skipping an unchecked bound', async () => {
    // config.Q is absent, so the queue bound could not be enforced; a permissive
    // validator would let queueMax=999 pass. It must be USAGE, never PASS.
    const path = await tmpTrace(JSON.stringify({
      config: { C: 2, W: 8, D: 100 },
      submitted: 1, admitted: 1, overloaded: 0, ok: 1, timeouts: 0, errors: 0, activeMax: 1, queueMax: 999,
    }));
    const s = sink();
    assert.equal(await runAdmission(s.io(['--check-trace', path])), EXIT.USAGE);
    assert.equal(s.out.length, 0);
  });

  it('is reachable through main', async () => {
    const out: string[] = [];
    const code = await main({ argv: ['admission', '--saturate', '--clip', '2', '--synthetic', '2', '--job-ms', '60'], stdout: (l) => out.push(l), stderr: () => {}, cwd: process.cwd() });
    assert.equal(code, EXIT.PASS);
    assert.equal(JSON.parse(out[0]!).invariantsHeld, true);
  });
});
