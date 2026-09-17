import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, discoverLog, followLog } from './cli.ts';

const ENV = { cwd: '/work', defaultColor: false };

describe('parseArgs', () => {
  it('defaults the store dir to <cwd>/.slipstream', () => {
    const r = parseArgs([], ENV);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.options.storeDir, '/work/.slipstream');
    assert.equal(r.options.logPath, null);
  });

  it('derives the store dir from a positional directory', () => {
    const r = parseArgs(['project'], ENV);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.options.storeDir, '/work/project/.slipstream');
  });

  it('honors an explicit --store and --log', () => {
    const r = parseArgs(['--store', 'store', '--log', 'a/events.jsonl'], ENV);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.options.storeDir, '/work/store');
    assert.equal(r.options.logPath, '/work/a/events.jsonl');
  });

  it('lets --color / --no-color override the default', () => {
    assert.equal((parseArgs(['--color'], ENV) as { options: { color: boolean } }).options.color, true);
    assert.equal(
      (parseArgs([], { cwd: '/work', defaultColor: true }) as { options: { color: boolean } }).options.color,
      true,
    );
    assert.equal((parseArgs(['--no-color'], { cwd: '/work', defaultColor: true }) as { options: { color: boolean } }).options.color, false);
  });

  it('rejects an unknown option', () => {
    const r = parseArgs(['--wat'], ENV);
    assert.equal(r.ok, false);
  });

  it('rejects a flag missing its value', () => {
    const r = parseArgs(['--log'], ENV);
    assert.equal(r.ok, false);
  });
});

describe('discoverLog', () => {
  it('returns null when the store has no sessions', async () => {
    const store = await mkdtemp(join(tmpdir(), 'lf-'));
    assert.equal(await discoverLog(store), null);
  });

  it('returns the most recently modified events.jsonl', async () => {
    const store = await mkdtemp(join(tmpdir(), 'lf-'));
    const older = join(store, 'sessions', 'old');
    const newer = join(store, 'sessions', 'new');
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, 'events.jsonl'), '');
    await writeFile(join(newer, 'events.jsonl'), '');
    const past = new Date(Date.now() - 60_000);
    await utimes(join(older, 'events.jsonl'), past, past);

    assert.equal(await discoverLog(store), join(newer, 'events.jsonl'));
  });
});

describe('followLog', () => {
  it('reads existing lines then picks up appended ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-'));
    const log = join(dir, 'events.jsonl');
    await writeFile(log, 'one\ntwo\n');

    const seen: string[] = [];
    const controller = new AbortController();
    const done = followLog(log, (line) => seen.push(line), {
      signal: controller.signal,
      intervalMs: 20,
    });

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(seen, ['one', 'two']);

    await appendFile(log, 'three\n');
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await done;

    assert.deepEqual(seen, ['one', 'two', 'three']);
  });

  it('does not corrupt a multibyte character split across reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lf-'));
    const log = join(dir, 'events.jsonl');
    await writeFile(log, '');

    const seen: string[] = [];
    const controller = new AbortController();
    const done = followLog(log, (line) => seen.push(line), {
      signal: controller.signal,
      intervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));

    // "café\n" with the two bytes of é (0xC3 0xA9) delivered in separate reads.
    await appendFile(log, Buffer.from([0x63, 0x61, 0x66, 0xc3]));
    await new Promise((r) => setTimeout(r, 60));
    await appendFile(log, Buffer.from([0xa9, 0x0a]));
    await new Promise((r) => setTimeout(r, 60));

    controller.abort();
    await done;

    assert.deepEqual(seen, ['café']);
  });
});
