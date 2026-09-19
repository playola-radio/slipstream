import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { codexStep, initialCodexState, type CodexState } from './codex.ts';
import type { AdapterContext } from './types.ts';
import type { NormalizedEvidence } from '../evidence-ingest.ts';

const CTX: AdapterContext = {
  harness: 'codex',
  harnessSessionId: 'codex-thread-1',
  root: '/work/proj',
  cwd: '/work/proj',
  adapterVersion: 'codex/1',
};

async function runFixture(): Promise<{ evidence: NormalizedEvidence[] }> {
  const path = fileURLToPath(new URL('./fixtures/codex-sample.json', import.meta.url));
  const records = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  let state: CodexState = initialCodexState();
  const evidence: NormalizedEvidence[] = [];
  for (const record of records) {
    const out = codexStep(state, record, CTX);
    state = out.state;
    evidence.push(...out.evidence);
  }
  return { evidence };
}

describe('codex transcript adapter', () => {
  it('maps native call_id to record_id, namespaced by thread', async () => {
    const { evidence } = await runFixture();
    const starts = evidence.filter((e) => e.timestamp.basis === 'tool-start');
    assert.deepEqual(
      starts.map((e) => e.evidence_key.record_id),
      ['call_patch_1', 'call_shell_1'],
    );
    for (const e of evidence) {
      assert.equal(e.evidence_key.harness, 'codex');
      assert.equal(e.evidence_key.harness_session_id, 'codex-thread-1');
    }
  });

  it('scopes apply_patch to every named file, including both rename endpoints', async () => {
    const { evidence } = await runFixture();
    const patch = evidence.find(
      (e) => e.evidence_key.record_id === 'call_patch_1' && e.timestamp.basis === 'tool-start',
    )!;
    assert.equal(patch.tool_name, 'apply_patch');
    assert.deepEqual(patch.file_scope, {
      kind: 'paths',
      paths: ['src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts'],
    });
  });

  it('discloses a shell command as an unknown-scope possible writer', async () => {
    const { evidence } = await runFixture();
    const shell = evidence.filter((e) => e.evidence_key.record_id === 'call_shell_1');
    assert.equal(shell.length, 2);
    for (const e of shell) assert.equal(e.file_scope.kind, 'unknown');
    assert.equal(shell[0]!.tool_name, 'shell');
  });

  it('drops an apply_patch that only touches files outside the root', async () => {
    const { evidence } = await runFixture();
    assert.equal(
      evidence.some((e) => e.evidence_key.record_id === 'call_patch_outside'),
      false,
    );
  });

  it('joins each output to its start as a same-key tool-end span', async () => {
    const { evidence } = await runFixture();
    const patch = evidence.filter((e) => e.evidence_key.record_id === 'call_patch_1');
    assert.equal(patch.length, 2);
    assert.equal(patch[0]!.timestamp.basis, 'tool-start');
    assert.equal(patch[1]!.timestamp.basis, 'tool-end');
    assert.deepEqual(patch[0]!.file_scope, patch[1]!.file_scope);
    assert.ok(patch[1]!.timestamp.at_ms > patch[0]!.timestamp.at_ms);
  });

  it('resolves apply_patch paths against a subdirectory cwd', () => {
    const ctx: AdapterContext = { ...CTX, cwd: '/work/proj/pkg' };
    const record = {
      type: 'response_item',
      timestamp: '2026-09-19T12:00:05.000Z',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_sub',
        input: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\n',
      },
    };
    const out = codexStep(initialCodexState(), record, ctx);
    assert.deepEqual(out.evidence[0]!.file_scope, { kind: 'paths', paths: ['pkg/a.ts'] });
  });

  it('reports a tool call without a stable call_id as unsupported, not evidence', () => {
    const record = {
      type: 'response_item',
      timestamp: '2026-09-19T12:00:05.000Z',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\n',
      },
    };
    const out = codexStep(initialCodexState(), record, CTX);
    assert.equal(out.evidence.length, 0);
    assert.equal(out.diagnostics.length, 1);
    assert.equal(out.diagnostics[0]!.kind, 'unsupported');
  });

  it('reports a tool call with an empty call_id as unsupported', () => {
    const record = {
      type: 'response_item',
      timestamp: '2026-09-19T12:00:05.000Z',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: '',
        input: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\n',
      },
    };
    const out = codexStep(initialCodexState(), record, CTX);
    assert.equal(out.evidence.length, 0);
    assert.equal(out.diagnostics[0]!.kind, 'unsupported');
  });

  it('discloses a matched output with an unparseable timestamp as malformed', () => {
    // The call is clean; its output arrives with a garbage timestamp. Dropping the
    // end silently would hide a malformed record behind a clean read, so it is
    // disclosed malformed with no fabricated tool-end.
    let state = initialCodexState();
    const call = {
      type: 'response_item',
      timestamp: '2026-09-19T12:00:00.000Z',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_a',
        input: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\n',
      },
    };
    const s1 = codexStep(state, call, CTX);
    state = s1.state;
    assert.equal(s1.evidence.length, 1);
    const output = {
      type: 'response_item',
      timestamp: 'garbage',
      payload: { type: 'custom_tool_call_output', call_id: 'call_a' },
    };
    const s2 = codexStep(state, output, CTX);
    assert.equal(s2.evidence.length, 0, 'no tool-end without a real timestamp');
    assert.equal(s2.diagnostics.length, 1);
    assert.equal(s2.diagnostics[0]!.kind, 'malformed');
  });

  it('reports a malformed response_item payload, keeping it distinct from a clean read', () => {
    // A response_item always carries a typed payload; these do not, so each must
    // yield a malformed diagnostic rather than passing as a clean read with no match.
    const shapes: unknown[] = [
      { type: 'response_item', timestamp: '2026-09-19T12:00:00.000Z', payload: null },
      { type: 'response_item', timestamp: '2026-09-19T12:00:00.000Z' },
      { type: 'response_item', timestamp: '2026-09-19T12:00:00.000Z', payload: {} },
    ];
    for (const record of shapes) {
      const out = codexStep(initialCodexState(), record, CTX);
      assert.equal(out.evidence.length, 0);
      assert.equal(out.diagnostics.length, 1, `expected a diagnostic for ${JSON.stringify(record)}`);
      assert.equal(out.diagnostics[0]!.kind, 'malformed');
    }
  });
});
