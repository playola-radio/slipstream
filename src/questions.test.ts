import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAsk, selectSource, questionBody, normalizeExchange, exchangeBody } from './questions.ts';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './test/helpers.ts';
import { createLog } from './log.ts';
import { blobPath } from './store-reader.ts';
import { readQuestionContext } from './questions.ts';
const request = () => ({
  session_id: '11111111-1111-4111-8111-111111111111',
  request_id: '22222222-2222-4222-8222-222222222222',
  text: ' Why? ',
  context: { change_seq: '9007199254740993', path: 'src/a.ts', snapshot_sha256: 'a'.repeat(64), line_start: 1, line_end: 1 },
});
const code = (value: string) => (err: unknown) => (err as { code?: string }).code === value;

describe('question normalization', () => {
  it('trims ECMAScript whitespace and canonicalizes only the declared body fields', () => {
    const input = request();
    input.text = '\uFEFF\u2003 Why? \r\n';
    const result = normalizeAsk(input);
    assert.equal(result.text, 'Why?');
    assert.equal(result.context.change_seq, '9007199254740993');
    assert.equal(questionBody(result), questionBody(normalizeAsk({ ...input, ignored: 'future' })));
    input.context.path = 'mutated';
    assert.equal(result.context.path, 'src/a.ts');
  });
  it('passes a canonical reply_to_question_id through and counts it in the request body', () => {
    const reply = '33333333-3333-4333-8333-333333333333';
    const result = normalizeAsk({ ...request(), reply_to_question_id: reply });
    assert.equal(result.reply_to_question_id, reply);
    assert.equal('reply_to_question_id' in normalizeAsk(request()), false);
    assert.notEqual(questionBody(result), questionBody(normalizeAsk(request())));
    for (const bad of ['', 'ABCDEFAB-1111-4111-8111-111111111111', '../x', 7, null]) {
      assert.throws(() => normalizeAsk({ ...request(), reply_to_question_id: bad }), code('INVALID_CONTEXT'));
    }
  });
  it('requires canonical IDs and decimal string seq', () => {
    for (const field of ['session_id', 'request_id']) {
      for (const bad of ['', 'ABCDEFAB-1111-4111-8111-111111111111', '../x', 7]) {
        assert.throws(() => normalizeAsk({ ...request(), [field]: bad }), code('PROTOCOL'));
      }
    }
    for (const change_seq of [0, 1, '', '01', '+1', '0', '-1', '1.0', '1e2']) {
      assert.throws(() => normalizeAsk({ ...request(), context: { ...request().context, change_seq } }), code('INVALID_CONTEXT'));
    }
  });
  it('enforces question UTF-8 bytes after trim', () => {
    assert.equal(normalizeAsk({ ...request(), text: ' '+ '😀'.repeat(2048)+' ' }).text.length, 4096);
    for (const text of ['', ' \uFEFF\u2003', '😀'.repeat(2049), null]) {
      assert.throws(() => normalizeAsk({ ...request(), text }), code('INVALID_QUESTION'));
    }
  });
  it('validates path/hash/range without coercion', () => {
    for (const fields of [
      { path: '' }, { path: '😀'.repeat(1025) },
      { snapshot_sha256: 'A'.repeat(64) }, { snapshot_sha256: 'a' },
      { line_start: 0 }, { line_start: 1.5 }, { line_end: '1' }, { line_start: 2 }, { line_end: 201 },
    ]) assert.throws(() => normalizeAsk({ ...request(), context: { ...request().context, ...fields } }), code('INVALID_CONTEXT'));
    assert.equal(normalizeAsk({ ...request(), context: { ...request().context, path: '😀'.repeat(1024) } }).context.path.length, 2048);
  });
});

describe('immutable source line selection', () => {
  it('preserves BOM, CRLF, tabs and internal blank lines without a synthetic final LF', () => {
    assert.equal(selectSource(Buffer.from('\uFEFFa\r\n\t😀\r\n\nlast\n'), { line_start: 1, line_end: 4 }), '\uFEFFa\r\n\t😀\r\n\nlast');
    assert.equal(selectSource(Buffer.from('\n'), { line_start: 1, line_end: 1 }), '');
    assert.equal(selectSource(Buffer.from('a\n\n'), { line_start: 2, line_end: 2 }), '');
  });
  it('rejects empty, invalid UTF-8, NUL, out-of-range and oversized input', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('a\0b'), Buffer.alloc(1024*1024+1, 65)]) {
      assert.throws(() => selectSource(bytes, { line_start: 1, line_end: 1 }), code('INVALID_CONTEXT'));
    }
    assert.throws(() => selectSource(Buffer.from('a\n'), { line_start: 2, line_end: 2 }), code('INVALID_CONTEXT'));
    assert.equal(selectSource(Buffer.from('😀'.repeat(4096)), { line_start: 1, line_end: 1 }).length, 8192);
    assert.throws(() => selectSource(Buffer.from('😀'.repeat(4097)), { line_start: 1, line_end: 1 }), code('INVALID_CONTEXT'));
  });
});


it('resolves only the durable named change and verifies actual bounded CAS bytes', async () => {
  await withTempDir(async (store) => {
    const input = request();
    const bytes = Buffer.from('\uFEFFa\r\n\tb\n');
    input.context.snapshot_sha256 = createHash('sha256').update(bytes).digest('hex');
    input.context.change_seq = '1';
    input.context.line_end = 2;
    const logPath = join(store, 'events.jsonl');
    const log = await createLog({ filePath: logPath, sessionId: input.session_id });
    const path = blobPath(store, input.context.snapshot_sha256);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    try {
      await log.append({ type: 'slipstream.file.changed.v1', occurred_at_ms: 1, data: {
        path: input.context.path, before: { kind: 'absent' }, after: { kind: 'content', sha256: input.context.snapshot_sha256, size: bytes.length }, observation: 'watcher',
      } });
      const read = (context = input.context, boundary = 1n, sessionId = input.session_id) => readQuestionContext({ storeDir: store, logPath, sessionId, boundary, context });
      assert.equal(await read(), '\uFEFFa\r\n\tb');
      await assert.rejects(read(input.context, 0n), code('INVALID_CONTEXT'));
      await assert.rejects(read({ ...input.context, path: 'wrong' }), code('INVALID_CONTEXT'));
      await assert.rejects(read({ ...input.context, snapshot_sha256: 'b'.repeat(64) }), code('INVALID_CONTEXT'));
      await assert.rejects(read(input.context, 1n, '33333333-3333-4333-8333-333333333333'), code('INVALID_CONTEXT'));
      await writeFile(path, 'corrupt');
      await assert.rejects(read(), code('STORAGE_UNAVAILABLE'));
      await writeFile(path, Buffer.alloc(1024*1024+1, 65));
      await assert.rejects(read(), code('STORAGE_UNAVAILABLE'));
      await rm(path);
      await assert.rejects(read(), code('STORAGE_UNAVAILABLE'));
      await symlink(logPath, path);
      await assert.rejects(read(), code('STORAGE_UNAVAILABLE'));
      for (const after of [{ kind: 'absent' }, { kind: 'unavailable', reason: 'unreadable' }] as const) {
        const event = await log.append({ type: 'slipstream.file.changed.v1', occurred_at_ms: 2, data: { path: input.context.path, before: { kind: 'absent' }, after, observation: 'watcher' } });
        await assert.rejects(read({ ...input.context, change_seq: event.seq }, BigInt(event.seq)), code('INVALID_CONTEXT'));
      }
      const baseline = await log.append({ type: 'slipstream.file.baselined.v1', occurred_at_ms: 2, data: { path: input.context.path, snapshot: { kind: 'absent' } } });
      await assert.rejects(read({ ...input.context, change_seq: baseline.seq }, BigInt(baseline.seq)), code('INVALID_CONTEXT'));
    } finally { await log.close(); }
  });
});

it('rejects unpaired surrogates instead of persisting strings strict clients cannot decode', () => {
  for (const text of ['\ud800', 'why\udfff']) {
    assert.throws(() => normalizeAsk({ ...request(), text }), code('INVALID_QUESTION'));
  }
  assert.throws(() => normalizeAsk({ ...request(), context: { ...request().context, path: 'a\ud800' } }), code('INVALID_CONTEXT'));
});

const exchange = () => ({
  ...request(),
  answer_text: 'Because it is.',
  conversation: { harness: 'claude-code', parent_session_id: 'parent-1', fork_session_id: 'fork-1' },
});

describe('question exchange normalization', () => {
  it('normalizeExchange accepts a valid request and copies only contract fields', () => {
    const result = normalizeExchange({ ...exchange(), selected_text: 'x', question_id: 'q', reported_by: 'me' });
    assert.deepEqual(Object.keys(result).sort(), ['answer_text', 'context', 'conversation', 'request_id', 'session_id', 'text']);
    assert.deepEqual(result.conversation, { harness: 'claude-code', parent_session_id: 'parent-1', fork_session_id: 'fork-1' });
    assert.equal(result.text, 'Why?');
    assert.equal(result.answer_text, 'Because it is.');
  });
  it('normalizeExchange keeps a 200 KiB multi-byte answer byte-identical', () => {
    const answer = 'é'.repeat(100 * 1024);
    assert.equal(Buffer.byteLength(answer), 200 * 1024);
    assert.equal(normalizeExchange({ ...exchange(), answer_text: answer }).answer_text, answer);
    const padded = '  keep me \n';
    assert.equal(normalizeExchange({ ...exchange(), answer_text: padded }).answer_text, padded);
  });
  it('normalizeExchange rejects answer_text that is missing, non-string, whitespace-only, or has a lone surrogate', () => {
    const { answer_text: _omit, ...missing } = exchange();
    assert.throws(() => normalizeExchange(missing), code('INVALID_ANSWER'));
    for (const answer_text of [7, null, '', ' \n\t', '\uD800']) {
      assert.throws(() => normalizeExchange({ ...exchange(), answer_text }), code('INVALID_ANSWER'));
    }
  });
  it('normalizeExchange rejects bad conversation', () => {
    const { conversation: _omit, ...missing } = exchange();
    assert.throws(() => normalizeExchange(missing), code('PROTOCOL'));
    const good = exchange().conversation;
    const bad: unknown[] = [
      null, [], 'x',
      { ...good, harness: 'cursor' },
      { ...good, parent_session_id: '' },
      { ...good, fork_session_id: '' },
      { ...good, parent_session_id: 'a'.repeat(257) },
      { ...good, fork_session_id: 'a\nb' },
      { ...good, parent_session_id: 'a\u0085b' },
      { ...good, parent_session_id: 'a\u007Fb' },
      { ...good, parent_session_id: 7 },
      { ...good, fork_session_id: undefined },
      { ...good, fork_session_id: good.parent_session_id },
    ];
    for (const conversation of bad) {
      assert.throws(() => normalizeExchange({ ...exchange(), conversation }), code('PROTOCOL'));
    }
    const edge = { harness: 'codex', parent_session_id: 'a'.repeat(256), fork_session_id: 'b' };
    assert.equal(normalizeExchange({ ...exchange(), conversation: edge }).conversation.harness, 'codex');
  });
  it('normalizeExchange inherits ask validation', () => {
    assert.throws(() => normalizeExchange({ ...exchange(), request_id: 'nope' }), code('PROTOCOL'));
    assert.throws(() => normalizeExchange({ ...exchange(), text: '   ' }), code('INVALID_QUESTION'));
    assert.throws(() => normalizeExchange({ ...exchange(), context: { ...request().context, line_start: 5, line_end: 4 } }), code('INVALID_CONTEXT'));
  });
  it('exchangeBody differs when answer_text, conversation, or reply_to differs and is equal for identical requests', () => {
    const base = exchangeBody(normalizeExchange(exchange()));
    assert.equal(exchangeBody(normalizeExchange(exchange())), base);
    assert.notEqual(exchangeBody(normalizeExchange({ ...exchange(), answer_text: 'Other.' })), base);
    const conv = exchange().conversation;
    for (const conversation of [{ ...conv, harness: 'codex' }, { ...conv, parent_session_id: 'p2' }, { ...conv, fork_session_id: 'f2' }]) {
      assert.notEqual(exchangeBody(normalizeExchange({ ...exchange(), conversation })), base);
    }
    const reply = '33333333-3333-4333-8333-333333333333';
    assert.notEqual(exchangeBody(normalizeExchange({ ...exchange(), reply_to_question_id: reply })), base);
  });
});
