import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sha256Hex,
  parseNdjson,
  createSseDecoder,
  createSseByteDecoder,
  snapshotMatches,
  buildReport,
  writeQaEnv,
  readQaEnv,
  awaitEventType,
  DurabilityTimeoutError,
  QA_ENV_FORMAT,
  QA_REPORT_FORMAT,
  mkdtempRoot,
  rmMkdtempRoot,
  type QaEnv,
  type FiniteEvents,
  type ReaderClient,
} from './qa-support.ts';
import type { Snapshot } from '../src/snapshot.ts';

describe('qa-support', () => {
  describe('sha256Hex', () => {
    it('is the plain SHA-256 of the bytes', () => {
      // Independently known digest of the empty string.
      assert.equal(sha256Hex(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      assert.equal(
        sha256Hex(Buffer.from('abc', 'utf8')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('parseNdjson', () => {
    it('parses non-empty lines and ignores blank ones', () => {
      const rows = parseNdjson('{"seq":"1"}\n{"seq":"2"}\n\n');
      assert.deepEqual(rows.map((r) => r.seq), ['1', '2']);
    });
    it('returns [] for an empty body', () => {
      assert.deepEqual(parseNdjson(''), []);
    });
  });

  describe('createSseDecoder', () => {
    it('emits a frame per blank-line-terminated block, carrying id and data', () => {
      const dec = createSseDecoder();
      const frames = dec.push('id: 5\nevent: message\ndata: {"seq":"5"}\n\n');
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.id, '5');
      assert.equal(frames[0]!.event, 'message');
      assert.equal(frames[0]!.data, '{"seq":"5"}');
    });
    it('handles a frame split across pushes', () => {
      const dec = createSseDecoder();
      assert.deepEqual(dec.push('data: hel'), []);
      assert.deepEqual(dec.push('lo\n'), []); // no blank line yet
      const frames = dec.push('\n');
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.data, 'hello');
    });
    it('ignores heartbeat comment lines and dataless frames', () => {
      const dec = createSseDecoder();
      const frames = dec.push(': keep-alive\n\nid: 9\n\n');
      assert.deepEqual(frames, []);
    });
    it('joins multi-line data with newlines', () => {
      const dec = createSseDecoder();
      const frames = dec.push('data: a\ndata: b\n\n');
      assert.equal(frames[0]!.data, 'a\nb');
    });
  });

  describe('createSseByteDecoder', () => {
    it('decodes a multibyte character split across byte chunks without corruption', () => {
      const dec = createSseByteDecoder();
      // "data: é\n\n" where é is 0xC3 0xA9, split between the two UTF-8 bytes.
      const full = Buffer.from('data: é\n\n', 'utf8');
      const cut = full.indexOf(0xa9); // split mid-character
      assert.deepEqual(dec.push(full.subarray(0, cut)), []);
      const frames = dec.push(full.subarray(cut));
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.data, 'é');
    });
  });

  describe('snapshotMatches', () => {
    const content = (bytes: Buffer): Snapshot => ({ kind: 'content', sha256: sha256Hex(bytes), size: bytes.length });
    it('matches absent to absent only', () => {
      assert.equal(snapshotMatches({ kind: 'absent' }, { kind: 'absent' }), true);
      assert.equal(snapshotMatches(content(Buffer.from('x')), { kind: 'absent' }), false);
    });
    it('matches content on identical sha256 and size', () => {
      const bytes = Buffer.from('hello world', 'utf8');
      assert.equal(snapshotMatches(content(bytes), { kind: 'content', bytes }), true);
    });
    it('rejects a wrong hash (the negative control)', () => {
      const bytes = Buffer.from('hello world', 'utf8');
      const wrong: Snapshot = { kind: 'content', sha256: sha256Hex(Buffer.from('different')), size: bytes.length };
      assert.equal(snapshotMatches(wrong, { kind: 'content', bytes }), false);
    });
    it('rejects unavailable content', () => {
      assert.equal(snapshotMatches({ kind: 'unavailable', reason: 'unreadable' }, { kind: 'content', bytes: Buffer.from('x') }), false);
    });
  });

  describe('buildReport', () => {
    it('is passed only when every check passed', () => {
      const passed = buildReport('abc', [{ id: 'A', result: 'passed', assertions: [] }]);
      assert.equal(passed.format, QA_REPORT_FORMAT);
      assert.equal(passed.result, 'passed');
      const mixed = buildReport('abc', [
        { id: 'A', result: 'passed', assertions: [] },
        { id: 'B', result: 'failed', assertions: [] },
      ]);
      assert.equal(mixed.result, 'failed');
    });
  });

  describe('qa-env round-trip', () => {
    let base: string;
    before(async () => { base = await mkdtemp(join(tmpdir(), 'slipstream-qa-env-')); });
    after(async () => { await rm(base, { recursive: true, force: true }); });

    it('writes owner-only and reads back the same env', async () => {
      const env: QaEnv = {
        format: QA_ENV_FORMAT,
        state: 'ready',
        run_id: 'run-1',
        daemon_commit: 'deadbeef',
        store: '/x/store',
        worktree: '/x/worktree',
        descriptor_path: '/x/store/runtime/abc.json',
        url: 'http://127.0.0.1:1234',
        token: 'secret',
        session_id: 'qa:run-1',
        ready_through_seq: '7',
        scenario: null,
      };
      const path = join(base, 'qa-env.json');
      await writeQaEnv(path, env);
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600);
      assert.deepEqual(await readQaEnv(path), env);
    });

    it('rejects a file with the wrong format', async () => {
      const path = join(base, 'bad.json');
      await writeQaEnv(path, { format: 'nope' as typeof QA_ENV_FORMAT, state: 'ready', run_id: '', daemon_commit: '', store: '', worktree: '', descriptor_path: '', url: '', token: '', session_id: '', ready_through_seq: '0', scenario: null });
      await assert.rejects(() => readQaEnv(path), /not a slipstream-qa\.v1/);
    });

    it('rejects malformed JSON without echoing the file bytes (which may hold the token)', async () => {
      const path = join(base, 'malformed.json');
      // A garbled env whose unquoted token sits right at the syntax error. V8's
      // JSON.parse SyntaxError message quotes a snippet of the input, so a naive
      // parse would splice these secret bytes into stderr and the JSON report.
      await writeFile(path, '{"format":"slipstream-qa.v1","token":sup3r-s3cr3t-t0ken}');
      await assert.rejects(
        () => readQaEnv(path),
        (err: Error) => /malformed/i.test(err.message) && !/sup3r/.test(err.message),
      );
    });

    it('rejects an env whose token carries a header-injecting newline', async () => {
      const path = join(base, 'evil-token.json');
      const env: QaEnv = {
        format: QA_ENV_FORMAT, state: 'ready', run_id: 'r', daemon_commit: 'c',
        store: '/x/store', worktree: '/x/worktree', descriptor_path: '/x/store/runtime/a.json',
        url: 'http://127.0.0.1:1', token: 'Bearer sentinel\nX-Secret: leak', session_id: 'qa:r',
        ready_through_seq: '0', scenario: null,
      };
      await writeQaEnv(path, env);
      // The rejection must NOT reflect the secret token back in its message.
      await assert.rejects(() => readQaEnv(path), (err: Error) => /token/.test(err.message) && !/sentinel/.test(err.message));
    });
  });

  describe('awaitEventType deadline bounding', () => {
    it('hits the durability deadline even when each request hangs (bounded per-request)', async () => {
      // A reader whose finite() never resolves unless its request signal aborts.
      // Without a per-request bound a hung request would prevent the deadline from
      // ever being checked; with one, the poll loop reaches its deadline and fails.
      const reader = {
        finite(_sessionId: string, _after: bigint, signal?: AbortSignal): Promise<FiniteEvents> {
          return new Promise<FiniteEvents>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
          });
        },
      } as unknown as ReaderClient;
      const start = Date.now();
      await assert.rejects(
        () => awaitEventType(reader, 'qa:1', 'never.happens', 0n, { deadlineMs: 300, pollMs: 10 }),
        DurabilityTimeoutError,
      );
      assert.ok(Date.now() - start < 5_000, 'must fail near the deadline, not hang');
    });
  });

  describe('mkdtempRoot / rmMkdtempRoot', () => {
    it('returns a not-yet-existing root nested one level under a fresh mkdtemp parent', async () => {
      const root = await mkdtempRoot('slipstream-qa-support-test-');
      const parent = join(root, '..');
      try {
        await assert.rejects(() => stat(root), 'the nested root must not pre-exist (callers create it)');
        assert.ok((await stat(parent)).isDirectory());
      } finally {
        await rmMkdtempRoot(root);
      }
    });

    it('removes the mkdtemp PARENT, not just the nested root', async () => {
      const root = await mkdtempRoot('slipstream-qa-support-test-');
      const parent = join(root, '..');
      await writeFile(join(parent, 'marker'), 'x'); // simulate the daemon having created `root` + siblings
      await rmMkdtempRoot(root);
      await assert.rejects(() => stat(root));
      await assert.rejects(() => stat(parent), 'the mkdtemp parent directory must also be removed, not left behind');
    });
  });
});
