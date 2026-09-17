import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './cli.ts';

describe('cli', () => {
  describe('parseArgs', () => {
    it('rejects --store without a following value', () => {
      assert.equal(parseArgs(['watch', '--store']), null);
    });
  });
});
