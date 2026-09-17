import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './cli.ts';

describe('cli', () => {
  describe('parseArgs', () => {
    it('rejects --store without a following value', () => {
      assert.equal(parseArgs(['watch', '--store']), null);
    });

    it('parses watch with dir and store', () => {
      assert.deepEqual(parseArgs(['watch', '/w', '--store', '/s']),
        { command: 'watch', dir: '/w', store: '/s' });
    });
  });
});

describe('cli parseArgs (reader commands)', () => {
  it('parses serve with a store override', () => {
    assert.deepEqual(parseArgs(['serve', '/w', '--store', '/s']),
      { command: 'serve', dir: '/w', store: '/s' });
  });
  it('parses view passing through remaining args', () => {
    const parsed = parseArgs(['view', '--store', '/s', '--session', 'abc', '--disk']);
    assert.equal(parsed?.command, 'view');
  });
});
