import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLineDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
  ProtocolError,
} from './control-protocol.ts';

describe('control-protocol line framing', () => {
  it('encodes a message as one newline-terminated JSON line', () => {
    const buf = encodeMessage({ v: 1, verb: 'status' });
    assert.equal(buf.at(-1), 0x0a);
    assert.equal(buf.toString('utf8').split('\n').length, 2); // body + trailing ''
    assert.deepEqual(JSON.parse(buf.toString('utf8')), { v: 1, verb: 'status' });
  });

  it('decodes a single complete line', () => {
    const dec = createLineDecoder();
    const out = dec.push(encodeMessage({ a: 1 }));
    assert.deepEqual(out, [{ a: 1 }]);
    dec.end();
  });

  it('decodes multiple frames delivered in one chunk', () => {
    const dec = createLineDecoder();
    const chunk = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
    assert.deepEqual(dec.push(chunk), [{ a: 1 }, { b: 2 }]);
  });

  it('holds a partial line until its newline arrives', () => {
    const dec = createLineDecoder();
    const full = encodeMessage({ hello: 'world' });
    const half = Math.floor(full.length / 2);
    assert.deepEqual(dec.push(full.subarray(0, half)), []);
    assert.deepEqual(dec.push(full.subarray(half)), [{ hello: 'world' }]);
  });

  it('reassembles a UTF-8 character split across chunk boundaries', () => {
    const dec = createLineDecoder();
    // U+1F600 encodes to 4 bytes; split it mid-character.
    const full = encodeMessage({ emoji: '😀 é ✓' });
    for (let i = 0; i < full.length; i++) {
      const got = dec.push(full.subarray(i, i + 1));
      if (i < full.length - 1) assert.deepEqual(got, []);
      else assert.deepEqual(got, [{ emoji: '😀 é ✓' }]);
    }
  });

  it('skips blank lines between frames', () => {
    const dec = createLineDecoder();
    assert.deepEqual(dec.push(Buffer.from('\n\n{"a":1}\n\n')), [{ a: 1 }]);
  });

  it('throws ProtocolError on invalid JSON in a complete line', () => {
    const dec = createLineDecoder();
    assert.throws(() => dec.push(Buffer.from('{not json}\n')), ProtocolError);
  });

  it('throws ProtocolError when an unterminated line exceeds the byte cap', () => {
    const dec = createLineDecoder(16);
    assert.throws(() => dec.push(Buffer.from('x'.repeat(64))), ProtocolError);
  });

  it('bounds buffering: a huge line never silently accumulates', () => {
    const dec = createLineDecoder();
    assert.throws(
      () => dec.push(Buffer.from('a'.repeat(MAX_MESSAGE_BYTES + 1))),
      ProtocolError,
    );
  });

  it('end() throws ProtocolError on a trailing partial (incomplete at EOF)', () => {
    const dec = createLineDecoder();
    dec.push(Buffer.from('{"a":1'));
    assert.throws(() => dec.end(), ProtocolError);
  });

  it('end() is clean when the stream ended on a frame boundary', () => {
    const dec = createLineDecoder();
    dec.push(encodeMessage({ a: 1 }));
    assert.doesNotThrow(() => dec.end());
  });
});
