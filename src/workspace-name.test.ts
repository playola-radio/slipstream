import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateName, type NameReason } from './workspace-name.ts';

type Case = { input: unknown; stored: string } | { input: unknown; reason: NameReason };

const CASES: Case[] = [
  { input: 42, reason: 'not_string' },
  { input: null, reason: 'not_string' },
  { input: '\ud800', reason: 'ill_formed' },
  { input: 'Fix\tlogin', reason: 'control_character' },
  { input: 'Fix login\n', reason: 'control_character' },
  { input: 'Fix\u0085login', reason: 'control_character' },
  { input: 'Fix\u2028login', reason: 'control_character' },
  { input: '  Fix login  ', stored: 'Fix login' },
  { input: '\u3000Fix\u3000', stored: 'Fix' },
  { input: '', reason: 'empty' },
  { input: '   ', reason: 'empty' },
  { input: 'a'.repeat(64), stored: 'a'.repeat(64) },
  { input: 'a'.repeat(65), reason: 'too_long' },
  { input: '🙂'.repeat(16), stored: '🙂'.repeat(16) },
  { input: '🙂'.repeat(17), reason: 'too_long' },
];

test('validateName: every case matches', () => {
  for (const c of CASES) {
    const result = validateName(c.input);
    if ('stored' in c) {
      assert.deepEqual(result, { ok: true, name: c.stored }, JSON.stringify(c.input));
    } else {
      assert.equal(result.ok, false, JSON.stringify(c.input));
      if (!result.ok) {
        assert.equal(result.reason, c.reason, JSON.stringify(c.input));
        assert.ok(result.message.length > 0);
      }
    }
  }
});
