import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReaderClient } from '../../qa-support.ts';
import { t5a1 } from './T5a.1.ts';

function response(status: number) {
  return { status, headers: new Headers(), body: Buffer.alloc(0) };
}

describe('T5a.1', () => {
  it('probes the interfaces route for a real file.changed sequence', async () => {
    const paths: string[] = [];
    const reader: ReaderClient = {
      raw: async (path) => {
        paths.push(path);
        return response(path === '/v1/schemas/projections/clip.v3' ? 200 : 404);
      },
      finite: async () => ({
        durableSeq: 7n,
        events: [
          { seq: '1', type: 'slipstream.session.started.v1' },
          { seq: '7', type: 'slipstream.file.changed.v1' },
        ],
      }),
      sessions: async () => { throw new Error('unused'); },
      blob: async () => { throw new Error('unused'); },
      follow: async () => { throw new Error('unused'); },
    };

    await t5a1.run({ worktree: '/unused', sessionId: 'session', reader, signal: new AbortController().signal });

    assert.ok(paths.includes('/v1/sessions/session/changes/7/interfaces'));
    assert.ok(!paths.includes('/v1/sessions/session/changes/1/interfaces'));
  });

  it('fails clearly when the session has no file.changed event', async () => {
    const reader: ReaderClient = {
      raw: async (path) => response(path === '/v1/schemas/projections/clip.v3' ? 200 : 404),
      finite: async () => ({ durableSeq: 1n, events: [{ seq: '1', type: 'slipstream.session.started.v1' }] }),
      sessions: async () => { throw new Error('unused'); },
      blob: async () => { throw new Error('unused'); },
      follow: async () => { throw new Error('unused'); },
    };

    await assert.rejects(
      t5a1.run({ worktree: '/unused', sessionId: 'session', reader, signal: new AbortController().signal }),
      /no file\.changed event/,
    );
  });
});
