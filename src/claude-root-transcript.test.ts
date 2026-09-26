import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClaudeRootTranscript } from './claude-root-transcript.ts';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const preamble = (type = 'queue-operation', id = sessionId) => ({ type, sessionId: id });
const identity = (cwd: string, version = '2.1.283', entrypoint = 'sdk-cli') => ({
  type: 'user', sessionId, cwd, version, entrypoint, userType: 'external', isSidechain: false,
});

async function withFixture(run: (fixture: { dir: string; root: string; path: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'slip-claude-root-'));
  const rootPath = join(dir, 'work');
  const path = join(dir, 'root.jsonl');
  await mkdir(rootPath);
  const root = await realpath(rootPath);
  try { await run({ dir, root, path }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

it('verifies the explicitly selected Terminal root after bounded preamble records', async () => {
  await withFixture(async ({ root, path }) => {
    await writeFile(path, line(preamble('ai-title')) + line(preamble()) + line(preamble())
      + line(identity(root)) + line({ ...identity(root), type: 'attachment' }));
    assert.deepEqual(await verifyClaudeRootTranscript(path, sessionId, root), { ok: true });
  });
});

it('verifies the measured Conductor attachment as the first complete identity record', async () => {
  await withFixture(async ({ root, path }) => {
    await writeFile(path, line(preamble()) + line(preamble())
      + line({ ...identity(root, '2.1.280', 'sdk-ts'), type: 'attachment' }));
    assert.deepEqual(await verifyClaudeRootTranscript(path, sessionId, root), { ok: true });
  });
});

it('fails closed on unavailable, incomplete, malformed, and contradictory bounded evidence', async () => {
  await withFixture(async ({ dir, root, path }) => {
    const check = async (body: string | Buffer, reason: string) => {
      await writeFile(path, body);
      assert.deepEqual(await verifyClaudeRootTranscript(path, sessionId, root), { ok: false, reason });
    };
    assert.deepEqual(await verifyClaudeRootTranscript(path, sessionId, root), { ok: false, reason: 'unavailable' });
    await check('', 'not-yet');
    await check(line(preamble()), 'not-yet');
    await check(line(preamble()) + JSON.stringify(identity(root)), 'not-yet');
    await check(line(preamble('queue-operation', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')) + line(identity(root)), 'mismatch');
    await check(line(preamble()) + '{bad}\n' + line(identity(root)), 'gap');
    await check(Buffer.concat([Buffer.from(line(preamble())), Buffer.from([0xff, 0x0a]), Buffer.from(line(identity(root)))]), 'gap');
    await check(line(preamble()) + line(identity(root)) + line({ ...identity(root), version: '2.1.999' }), 'mismatch');
    await check(line(preamble()) + line(identity(root)) + line({ ...identity(root), userType: 'internal' }), 'mismatch');
    await check(line(preamble()) + line(identity(root)) + line({ ...identity(root), sessionId: 'other' }), 'mismatch');
    await check(line(preamble()) + line({ ...identity(root), version: '2.1.999' }), 'unsupported-version');
    await check(line(preamble()) + line({ ...identity(root), cwd: dir }), 'mismatch');
    await check(line(preamble()) + line({ ...identity(root), isSidechain: true }), 'mismatch');
    await check(line(preamble()) + line({ ...identity(root), entrypoint: 'sdk-ts' }), 'mismatch');
    await check(line(preamble()) + line({ ...identity(root), version: undefined }), 'mismatch');
    await check(line(preamble()) + 'x'.repeat(256 * 1024 + 1) + '\n' + line(identity(root)), 'gap');
    await check(Array.from({ length: 65 }, () => line(preamble())).join('') + line(identity(root)), 'gap');
    await check(line(preamble()) + 'x'.repeat(4 * 1024 * 1024) + line(identity(root)), 'gap');
    const link = join(dir, 'link.jsonl');
    await symlink(path, link);
    assert.deepEqual(await verifyClaudeRootTranscript(link, sessionId, root), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await verifyClaudeRootTranscript(root, sessionId, root), { ok: false, reason: 'unavailable' });
  });
});
