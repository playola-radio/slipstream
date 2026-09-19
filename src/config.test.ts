import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CODEX_SCAN_LIMIT,
  defaultConfig,
  loadConfig,
  parseConfigFile,
  resolveConfig,
  type ConfigIO,
} from './config.ts';

const HOME = '/home/u';

describe('default config', () => {
  it('derives per-harness transcript homes from the home dir', () => {
    const c = defaultConfig(HOME);
    assert.equal(c.transcript.homes['claude-code'], '/home/u/.claude');
    assert.equal(c.transcript.homes.codex, '/home/u/.codex');
    assert.equal(c.transcript.codexScanLimit, DEFAULT_CODEX_SCAN_LIMIT);
    assert.equal(c.policy.sources['claude-code'], 'unconfigured');
    assert.equal(c.policy.sources.codex, 'unconfigured');
  });
});

describe('parseConfigFile', () => {
  it('reads enrichment timing, declared sources, homes, and scan limit', () => {
    const { overrides, warnings } = parseConfigFile(
      JSON.stringify({
        enrichment: { window_ms: 3000, grace_ms: 6000, sources: { 'claude-code': 'configured' } },
        transcripts: { homes: { codex: '/custom/codex' }, codex_scan_limit: 50 },
      }),
    );
    assert.equal(warnings.length, 0);
    assert.equal(overrides.windowMs, 3000);
    assert.equal(overrides.graceMs, 6000);
    assert.equal(overrides.sources!['claude-code'], 'configured');
    assert.equal(overrides.homes!.codex, '/custom/codex');
    assert.equal(overrides.codexScanLimit, 50);
  });

  it('warns and yields nothing on malformed JSON rather than throwing', () => {
    const { overrides, warnings } = parseConfigFile('{not json');
    assert.deepEqual(overrides, {});
    assert.equal(warnings.length, 1);
  });

  it('warns and skips fields of the wrong type or bad value', () => {
    const { overrides, warnings } = parseConfigFile(
      JSON.stringify({
        enrichment: { window_ms: -5, sources: { 'claude-code': 'bogus', unknown: 'configured' } },
        transcripts: { codex_scan_limit: 0 },
      }),
    );
    assert.equal(overrides.windowMs, undefined);
    assert.equal(overrides.codexScanLimit, undefined);
    assert.equal(overrides.sources, undefined);
    assert.ok(warnings.length >= 1);
  });
});

describe('resolveConfig', () => {
  it('layers CLI over file over defaults', () => {
    const file = { windowMs: 3000, graceMs: 6000, codexScanLimit: 100 };
    const cli = { windowMs: 9000, sources: { codex: 'configured' as const } };
    const config = resolveConfig(file, cli, HOME);
    assert.equal(config.policy.window_ms, 9000, 'CLI wins');
    assert.equal(config.policy.grace_ms, 6000, 'file kept where CLI is silent');
    assert.equal(config.transcript.codexScanLimit, 100);
    assert.equal(config.policy.sources.codex, 'configured');
    assert.equal(config.policy.sources['claude-code'], 'unconfigured', 'default kept');
  });

  it('resolves relative home overrides to absolute paths', () => {
    const config = resolveConfig({}, { homes: { codex: 'rel/codex' } }, HOME);
    assert.equal(config.transcript.homes.codex.startsWith('/'), true);
  });
});

describe('loadConfig', () => {
  const io = (files: Record<string, string>): ConfigIO => ({
    readFile: async (p) => (p in files ? files[p] : undefined),
  });

  it('returns defaults when no config path is given', async () => {
    const { config, warnings } = await loadConfig({ io: io({}), homeDir: HOME });
    assert.equal(config.policy.window_ms, 2000);
    assert.equal(warnings.length, 0);
  });

  it('warns when an explicit config path is missing', async () => {
    const { warnings } = await loadConfig({ path: '/etc/x.json', io: io({}), homeDir: HOME });
    assert.equal(warnings.length, 1);
  });

  it('applies a config file and CLI overrides together', async () => {
    const files = { '/etc/x.json': JSON.stringify({ enrichment: { window_ms: 4000 } }) };
    const { config } = await loadConfig({
      path: '/etc/x.json',
      io: io(files),
      cli: { graceMs: 7000 },
      homeDir: HOME,
    });
    assert.equal(config.policy.window_ms, 4000);
    assert.equal(config.policy.grace_ms, 7000);
  });
});
