import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChange,
  sizeLabel,
  formatClock,
  parseLine,
  formatEvent,
  type FeedEvent,
} from './feed.ts';

/** A real CloudEvents `file.changed` record as written to events.jsonl. */
function changedRecord(): string {
  return JSON.stringify({
    specversion: '1.0',
    id: '4',
    source: 'urn:slipstream:session:abc',
    type: 'slipstream.file.changed.v1',
    seq: '4',
    time: '2026-09-17T12:00:00.000Z',
    data: {
      session_id: 'abc',
      path: 'greeting.txt',
      before: { kind: 'content', sha256: 'aaa', size: 6 },
      after: { kind: 'content', sha256: 'bbb', size: 12 },
      observation: 'watcher',
      observed_at_ms: 1789667803962,
      coalesced: false,
    },
  });
}

describe('classifyChange', () => {
  it('is "new" when the file was absent before and present after', () => {
    assert.equal(classifyChange({ kind: 'absent' }, { kind: 'content' }), 'new');
  });

  it('is "deleted" when the file was present before and absent after', () => {
    assert.equal(classifyChange({ kind: 'content' }, { kind: 'absent' }), 'deleted');
  });

  it('is "modified" when content changes on both sides', () => {
    assert.equal(classifyChange({ kind: 'content' }, { kind: 'content' }), 'modified');
  });

  it('does not fabricate "new" when the prior state is unavailable', () => {
    assert.equal(classifyChange({ kind: 'unavailable' }, { kind: 'content' }), 'modified');
  });
});

describe('sizeLabel', () => {
  it('shows byte size for content', () => {
    assert.equal(sizeLabel({ kind: 'content', size: 12 }), '12B');
  });

  it('shows 0B for an absent side', () => {
    assert.equal(sizeLabel({ kind: 'absent' }), '0B');
  });

  it('shows ?B for content with a missing size rather than a fabricated 0B', () => {
    assert.equal(sizeLabel({ kind: 'content', size: null }), '?B');
  });

  it('exposes the reason for unavailable content instead of a fake size', () => {
    assert.equal(sizeLabel({ kind: 'unavailable', reason: 'oversize' }), '⟨oversize⟩');
    assert.equal(sizeLabel({ kind: 'unavailable', reason: null }), '⟨unavailable⟩');
  });
});

describe('formatClock', () => {
  it('renders epoch ms as HH:MM:SS', () => {
    assert.match(formatClock(1789667803962), /^\d{2}:\d{2}:\d{2}$/);
  });

  it('renders a placeholder when the timestamp is unknown or out of range', () => {
    assert.equal(formatClock(null), '--:--:--');
    assert.equal(formatClock(1e20), '--:--:--');
  });
});

describe('parseLine', () => {
  it('normalizes a real CloudEvents file.changed record', () => {
    const ev = parseLine(changedRecord());
    assert.equal(ev.kind, 'change');
    if (ev.kind !== 'change') return;
    assert.equal(ev.path, 'greeting.txt');
    assert.equal(ev.before.kind, 'content');
    assert.equal(ev.after.kind, 'content');
    assert.equal(ev.atMs, 1789667803962);
  });

  it('accepts the flat record shape too (fields at top level)', () => {
    const line = JSON.stringify({
      type: 'file.changed',
      path: 'a.txt',
      before: { kind: 'absent' },
      after: { kind: 'content', size: 3 },
      observed_at_ms: 100,
    });
    const ev = parseLine(line);
    assert.equal(ev.kind, 'change');
    if (ev.kind !== 'change') return;
    assert.equal(ev.path, 'a.txt');
    assert.equal(ev.atMs, 100);
  });

  it('falls back to the envelope time when observed_at_ms is out of range', () => {
    const line = JSON.stringify({
      type: 'slipstream.file.changed.v1',
      time: '2026-09-17T12:00:00.000Z',
      data: { path: 'a', before: { kind: 'absent' }, after: { kind: 'content', size: 1 }, observed_at_ms: 1e20 },
    });
    const ev = parseLine(line);
    assert.equal(ev.kind, 'change');
    if (ev.kind !== 'change') return;
    assert.equal(ev.atMs, Date.parse('2026-09-17T12:00:00.000Z'));
  });

  it('normalizes a capture.gap record with its reason', () => {
    const line = JSON.stringify({
      type: 'slipstream.capture.gap.v1',
      data: { session_id: 'abc', scope: { kind: 'session' }, reason: 'restart', observed_at_ms: 200 },
    });
    const ev = parseLine(line);
    assert.equal(ev.kind, 'gap');
    if (ev.kind !== 'gap') return;
    assert.equal(ev.reason, 'restart');
    assert.equal(ev.atMs, 200);
  });

  it('classifies unrelated event types as "other" so they are skipped', () => {
    const line = JSON.stringify({ type: 'slipstream.session.started.v1', data: { session_id: 'abc' } });
    assert.equal(parseLine(line).kind, 'other');
  });

  it('does not treat an unknown look-alike type as a change', () => {
    const line = JSON.stringify({ type: 'slipstream.file.changed.audit.v1', data: {} });
    assert.equal(parseLine(line).kind, 'other');
  });

  it('reports an unparseable line as malformed rather than hiding it', () => {
    const ev = parseLine('{not json');
    assert.equal(ev.kind, 'malformed');
  });
});

describe('formatEvent', () => {
  const change: FeedEvent = {
    kind: 'change',
    atMs: Date.UTC(2026, 0, 1, 0, 0, 0),
    path: 'greeting.txt',
    before: { kind: 'content', size: 6 },
    after: { kind: 'content', size: 12 },
  };

  it('renders a change as "HH:MM:SS path <before>B → <after>B [class]" without color', () => {
    const clock = formatClock(change.atMs);
    assert.equal(formatEvent(change, { color: false }), `${clock} greeting.txt 6B → 12B [modified]`);
  });

  it('renders a gap as a dim warning line', () => {
    const gap: FeedEvent = { kind: 'gap', atMs: Date.UTC(2026, 0, 1, 0, 0, 0), reason: 'restart' };
    const clock = formatClock(gap.atMs);
    assert.equal(formatEvent(gap, { color: false }), `${clock} ⚠ gap: restart`);
  });

  it('neutralizes terminal control characters in a path', () => {
    const evil: FeedEvent = {
      kind: 'change',
      atMs: 0,
      path: '\x1b[2Jforged.txt',
      before: { kind: 'absent' },
      after: { kind: 'content', size: 1 },
    };
    const line = formatEvent(evil, { color: false });
    assert.ok(!line!.includes('\x1b['));
    assert.ok(line!.includes('\\x1b'));
  });

  it('skips "other" events by returning null', () => {
    assert.equal(formatEvent({ kind: 'other' }, { color: false }), null);
  });

  it('adds ANSI escapes only when color is enabled', () => {
    const plain = formatEvent(change, { color: false });
    const colored = formatEvent(change, { color: true });
    assert.ok(!plain!.includes('\x1b['));
    assert.ok(colored!.includes('\x1b['));
  });
});
