import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWLISTED_ENV_KEYS,
  homeRelativize,
  collectAllowlistedEnv,
  discoverEnvKeys,
} from './redact.ts';

test('homeRelativize replaces the home prefix with ~ and leaves other paths', () => {
  assert.equal(homeRelativize('/Users/x/conductor/w', '/Users/x'), '~/conductor/w');
  assert.equal(homeRelativize('/Users/x', '/Users/x'), '~');
  assert.equal(homeRelativize('/opt/tool', '/Users/x'), '/opt/tool');
});

test('homeRelativize normalizes a trailing slash on the home argument', () => {
  assert.equal(homeRelativize('/Users/alice/work', '/Users/alice/'), '~/work');
});

test('homeRelativize leaves an embedded home path in a flag argument unchanged (anchored, not global)', () => {
  assert.equal(
    homeRelativize('--log=/Users/alice/private', '/Users/alice'),
    '--log=/Users/alice/private',
  );
});

test('homeRelativize does not corrupt a path that merely starts with the home prefix as a substring', () => {
  assert.equal(homeRelativize('/Users/alice-backup/x', '/Users/alice'), '/Users/alice-backup/x');
});

test('homeRelativize does not corrupt a non-home path that contains the home path as a nested substring', () => {
  assert.equal(
    homeRelativize('/backup/Users/alice/work', '/Users/alice'),
    '/backup/Users/alice/work',
  );
});

test('homeRelativize leaves an unrelated absolute path unchanged', () => {
  assert.equal(homeRelativize('/Volumes/other/x', '/Users/alice'), '/Volumes/other/x');
});

test('collectAllowlistedEnv records allowlisted values, home-relativizing paths', () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'sess-123',
    CLAUDE_PROJECT_DIR: '/Users/x/conductor/w',
    AWS_SECRET_ACCESS_KEY: 'super-secret',
  };
  const out = collectAllowlistedEnv(env, '/Users/x');
  assert.deepEqual(out.CLAUDE_CODE_SESSION_ID, { present: true, value: 'sess-123' });
  assert.deepEqual(out.CLAUDE_PROJECT_DIR, { present: true, value: '~/conductor/w' });
  // A non-allowlisted key gets no entry at all in the allowlisted map.
  assert.equal('AWS_SECRET_ACCESS_KEY' in out, false);
});

test('collectAllowlistedEnv marks absent allowlisted keys explicitly', () => {
  const out = collectAllowlistedEnv({}, '/Users/x');
  for (const k of ALLOWLISTED_ENV_KEYS) assert.deepEqual(out[k], { present: false });
});

test('discoverEnvKeys returns sorted matching names only, never values, never allowlisted', () => {
  const env = {
    CLAUDE_CONFIG_DIR: '/Users/x/.claude',   // matches CLAUDE prefix, not allowlisted
    CODEX_HOME: '/Users/x/.codex',            // matches CODEX prefix, not allowlisted
    CONDUCTOR_WORKSPACE: 'ws',                // matches CONDUCTOR prefix, not allowlisted
    AWS_SECRET_ACCESS_KEY: 'super-secret',    // no discovery prefix -> excluded
    CLAUDE_CODE_SESSION_ID: 'sess-123',       // allowlisted -> excluded from discovery
  };
  const keys = discoverEnvKeys(env);
  assert.deepEqual(keys, ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CONDUCTOR_WORKSPACE']);
  // Adversarial: no value string ever appears in the discovery output.
  assert.equal(JSON.stringify(keys).includes('super-secret'), false);
});
