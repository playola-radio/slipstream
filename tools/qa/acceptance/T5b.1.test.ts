import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { intervalsOverlap } from './T5b.1.ts';

describe('T5b.1 intervalsOverlap', () => {
  it('is true when one span starts inside the other', () => {
    assert.equal(intervalsOverlap({ start: 0, end: 10 }, { start: 5, end: 15 }), true);
  });

  it('is true when one span fully contains the other', () => {
    assert.equal(intervalsOverlap({ start: 0, end: 100 }, { start: 10, end: 20 }), true);
  });

  it('is true when the spans touch at a single instant', () => {
    assert.equal(intervalsOverlap({ start: 0, end: 10 }, { start: 10, end: 20 }), true);
  });

  it('is false when one span finishes strictly before the other starts', () => {
    assert.equal(intervalsOverlap({ start: 0, end: 9 }, { start: 10, end: 20 }), false);
  });

  it('is false for a read that completed well before the capture write began', () => {
    // The exact shape of the bug this guards against: a computed read that
    // finished long before capture started proves no contention occurred.
    const read = { start: 0, end: 5 };
    const captureSpan = { start: 1000, end: 1010 };
    assert.equal(intervalsOverlap(read, captureSpan), false);
  });

  it('is order-independent', () => {
    const a = { start: 3, end: 8 };
    const b = { start: 1, end: 4 };
    assert.equal(intervalsOverlap(a, b), intervalsOverlap(b, a));
  });
});
