import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { claudeStep, initialClaudeState, type ClaudeState } from './claude.ts';
import type { AdapterContext, Diagnostic } from './types.ts';
import type { NormalizedEvidence } from '../evidence-ingest.ts';

const CTX: AdapterContext = {
  harness: 'claude-code',
  harnessSessionId: 'claude-sess-1',
  root: '/work/proj',
  cwd: '/work/proj',
  adapterVersion: 'claude-code/1',
};

async function runFixture(): Promise<{ evidence: NormalizedEvidence[]; diagnostics: Diagnostic[] }> {
  const path = fileURLToPath(new URL('./fixtures/claude-sample.json', import.meta.url));
  const records = JSON.parse(await readFile(path, 'utf8')) as unknown[];
  let state: ClaudeState = initialClaudeState();
  const evidence: NormalizedEvidence[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const record of records) {
    const out = claudeStep(state, record, CTX);
    state = out.state;
    evidence.push(...out.evidence);
    diagnostics.push(...out.diagnostics);
  }
  return { evidence, diagnostics };
}

describe('claude transcript adapter', () => {
  it('maps native tool_use ids to record_id, namespaced by session', async () => {
    const { evidence } = await runFixture();
    const starts = evidence.filter((e) => e.timestamp.basis === 'tool-start');
    assert.deepEqual(
      starts.map((e) => e.evidence_key.record_id),
      ['toolu_write_a', 'toolu_edit_notebook', 'toolu_bash_1'],
    );
    for (const e of evidence) {
      assert.equal(e.evidence_key.harness, 'claude-code');
      assert.equal(e.evidence_key.harness_session_id, 'claude-sess-1');
    }
  });

  it('scopes write tools to root-relative paths matching capture format', async () => {
    const { evidence } = await runFixture();
    const write = evidence.find((e) => e.evidence_key.record_id === 'toolu_write_a')!;
    assert.deepEqual(write.file_scope, { kind: 'paths', paths: ['src/a.ts'] });
    const notebook = evidence.find((e) => e.evidence_key.record_id === 'toolu_edit_notebook')!;
    assert.deepEqual(notebook.file_scope, { kind: 'paths', paths: ['notes/run.ipynb'] });
  });

  it('emits nothing for read-only tools', async () => {
    const { evidence } = await runFixture();
    assert.equal(
      evidence.some((e) => e.evidence_key.record_id === 'toolu_read_b'),
      false,
    );
  });

  it('discloses Bash as an unknown-scope possible writer', async () => {
    const { evidence } = await runFixture();
    const bash = evidence.filter((e) => e.evidence_key.record_id === 'toolu_bash_1');
    assert.equal(bash.length, 2, 'a start and an end');
    for (const e of bash) assert.equal(e.file_scope.kind, 'unknown');
    assert.equal(bash[0]!.tool_name, 'Bash');
  });

  it('drops a write outside the capture root', async () => {
    const { evidence } = await runFixture();
    assert.equal(
      evidence.some((e) => e.evidence_key.record_id === 'toolu_write_outside'),
      false,
    );
  });

  it('joins a result to its start as a same-key tool-end record, not a conflict', async () => {
    const { evidence } = await runFixture();
    const write = evidence.filter((e) => e.evidence_key.record_id === 'toolu_write_a');
    assert.equal(write.length, 2);
    const [start, end] = write;
    assert.equal(start!.timestamp.basis, 'tool-start');
    assert.equal(end!.timestamp.basis, 'tool-end');
    assert.deepEqual(start!.file_scope, end!.file_scope);
    assert.equal(start!.tool_name, end!.tool_name);
    assert.ok(end!.timestamp.at_ms > start!.timestamp.at_ms);
  });

  it('ignores an orphan tool_result whose start was never seen', async () => {
    const { evidence } = await runFixture();
    assert.equal(
      evidence.some((e) => e.evidence_key.record_id === 'toolu_never_started'),
      false,
    );
  });

  it('namespaces record_id by the record own sessionId, not the bound file name', () => {
    // The context's harnessSessionId (from the file name) differs from the
    // record's native sessionId; the native id wins so a copied transcript keeps
    // one identity.
    const ctx: AdapterContext = { ...CTX, harnessSessionId: 'file-name-slug' };
    const record = {
      type: 'assistant',
      sessionId: 'native-sess-9',
      timestamp: '2026-09-19T12:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Write', input: { file_path: '/work/proj/x.ts' } }] },
    };
    const out = claudeStep(initialClaudeState(), record, ctx);
    assert.equal(out.evidence[0]!.evidence_key.harness_session_id, 'native-sess-9');
  });

  it('falls back to the bound session id when the record omits sessionId', () => {
    const ctx: AdapterContext = { ...CTX, harnessSessionId: 'file-name-slug' };
    const record = {
      type: 'assistant',
      timestamp: '2026-09-19T12:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Write', input: { file_path: '/work/proj/x.ts' } }] },
    };
    const out = claudeStep(initialClaudeState(), record, ctx);
    assert.equal(out.evidence[0]!.evidence_key.harness_session_id, 'file-name-slug');
  });

  it('reports a tool_use with a missing id as unsupported, not evidence', () => {
    const record = {
      type: 'assistant',
      timestamp: '2026-09-19T12:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/work/proj/x.ts' } }] },
    };
    const out = claudeStep(initialClaudeState(), record, CTX);
    assert.equal(out.evidence.length, 0);
    assert.equal(out.diagnostics.length, 1);
    assert.equal(out.diagnostics[0]!.kind, 'unsupported');
  });

  it('reports a tool_use with an empty id as unsupported', () => {
    const record = {
      type: 'assistant',
      timestamp: '2026-09-19T12:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: '', name: 'Write', input: { file_path: '/work/proj/x.ts' } }] },
    };
    const out = claudeStep(initialClaudeState(), record, CTX);
    assert.equal(out.evidence.length, 0);
    assert.equal(out.diagnostics[0]!.kind, 'unsupported');
  });

  it('reports a malformed assistant envelope, keeping it distinct from a clean read', () => {
    // Every shape here is a complete, parseable assistant record whose content is
    // not a block array. None yields evidence, and each must yield a malformed
    // diagnostic so coverage degrades rather than reporting a clean read.
    const shapes: unknown[] = [
      { type: 'assistant', message: { content: 'invalid' } },
      { type: 'assistant', message: {} },
      { type: 'assistant', message: null },
      { type: 'assistant' },
    ];
    for (const record of shapes) {
      const out = claudeStep(initialClaudeState(), record, CTX);
      assert.equal(out.evidence.length, 0);
      assert.equal(out.diagnostics.length, 1, `expected a diagnostic for ${JSON.stringify(record)}`);
      assert.equal(out.diagnostics[0]!.kind, 'malformed');
    }
  });

  it('accepts plain string user content as a clean read, not a malformed one', () => {
    // A user turn is typically typed text, not tool results; string content is
    // legitimate and must produce neither evidence nor a diagnostic.
    const record = { type: 'user', message: { role: 'user', content: 'hello there' } };
    const out = claudeStep(initialClaudeState(), record, CTX);
    assert.equal(out.evidence.length, 0);
    assert.equal(out.diagnostics.length, 0);
  });

  it('reports a malformed user envelope, keeping it distinct from a clean read', () => {
    // Content that is neither typed text nor a block array (and a null/absent
    // message) is malformed, so coverage degrades rather than reporting a clean read.
    const shapes: unknown[] = [
      { type: 'user', message: null },
      { type: 'user', message: { content: 42 } },
      { type: 'user', message: {} },
      { type: 'user' },
    ];
    for (const record of shapes) {
      const out = claudeStep(initialClaudeState(), record, CTX);
      assert.equal(out.evidence.length, 0);
      assert.equal(out.diagnostics.length, 1, `expected a diagnostic for ${JSON.stringify(record)}`);
      assert.equal(out.diagnostics[0]!.kind, 'malformed');
    }
  });
});
