import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReaderServer } from './http-reader.ts';
import { withFakeSession } from './test/helpers.ts';

// INDEPENDENT direct-disk reader — deliberately not the production log-reader.
function directDiskEvents(logText: string): { seq: string }[] {
  return logText.split('\n').filter((l) => l.length > 0).map((l) => {
    return { seq: (JSON.parse(l) as { seq: string }).seq };
  });
}

async function GET(url: string, token: string, port: number, path: string) {
  return fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` },
  });
}

describe('reader convergence', () => {
  it('the HTTP reader and an independent disk reader agree on ordered event identities', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        // Write AFTER capture attaches so this is a real observed change, not
        // pre-existing baseline content (which never produces a changed event).
        await writeFile(join(root, 'a.txt'), 'hi');
        observe('a.txt'); // relative to root — see FakePlatform.observe contract
        await waitFor((recs) => recs.some((r) => r.type === 'slipstream.file.changed.v1'));
        const storeDir = session.logPath.replace(/sessions\/.+$/, '').replace(/\/$/, '');
        const srv = await startReaderServer({ storeDir });
        try {
          const H = BigInt(session.health.snapshot().durable_seq);
          const res = await fetch(`${srv.url}/v1/sessions/${session.sessionId}/events?after=0`, {
            headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
          });
          const httpSeqs = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l).seq);
          const diskSeqs = directDiskEvents(await readFile(session.logPath, 'utf8'))
            .filter((e) => BigInt(e.seq) <= H).map((e) => e.seq);
          assert.deepEqual(httpSeqs, diskSeqs);
          assert.ok(httpSeqs.length > 0);
        } finally { await srv.close(); }
      },
    );
  });

  it('surfaces task grouping and attribution identically over HTTP and on disk', async () => {
    await withFakeSession(
      async () => {},
      async ({ root, session, observe, waitFor }) => {
        const task = await session.beginTask({ title: 'Group me', requestId: 'req-1' });
        await writeFile(join(root, 'a.txt'), 'hi');
        observe('a.txt');
        await waitFor((recs) => recs.some((r) => r.type === 'slipstream.file.changed.v1'));

        const storeDir = session.logPath.replace(/sessions\/.+$/, '').replace(/\/$/, '');
        const srv = await startReaderServer({ storeDir });
        try {
          const res = await fetch(`${srv.url}/v1/sessions/${session.sessionId}/events?after=0`, {
            headers: { authorization: `Bearer ${srv.token}`, host: `127.0.0.1:${srv.port}` },
          });
          const httpChange = (await res.text())
            .split('\n').filter(Boolean).map((l) => JSON.parse(l))
            .find((e) => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.txt');
          const diskChange = (await readFile(session.logPath, 'utf8'))
            .split('\n').filter(Boolean).map((l) => JSON.parse(l))
            .find((e) => e.type === 'slipstream.file.changed.v1' && e.data.path === 'a.txt');

          assert.ok(httpChange && diskChange);
          assert.equal(httpChange.data.task_hint_id, task.task_id);
          assert.equal(httpChange.data.task_hint_id, diskChange.data.task_hint_id);
          // Attribution is no longer an inline seed on the change: "no result yet"
          // is PENDING, disclosed as a separate revisable change.attribution event.
          assert.equal(httpChange.data.attribution, undefined);
          assert.equal(diskChange.data.attribution, undefined);
        } finally { await srv.close(); }
      },
    );
  });

  it('reconnect from a stale cursor returns exactly the suffix (idempotent by seq)', async () => {
    const UUID = '77777777-7777-4777-8777-777777777777';
    const dir = await mkdtemp(join(tmpdir(), 'slip-recon-'));
    await mkdir(join(dir, 'sessions', UUID), { recursive: true });
    await writeFile(
      join(dir, 'sessions', UUID, 'events.jsonl'),
      [
        '{"seq":"1","type":"slipstream.file.changed.v1","data":{"path":"a.txt"}}',
        '{"seq":"2","type":"slipstream.file.changed.v1","data":{"path":"b.txt"}}',
        '{"seq":"3","type":"slipstream.file.changed.v1","data":{"path":"c.txt"}}',
        '',
      ].join('\n'),
      'utf8',
    );
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const resFromOne = await GET(srv.url, srv.token, srv.port, `/v1/sessions/${UUID}/events?after=1`);
      assert.equal(resFromOne.status, 200);
      const seqsFromOne = (await resFromOne.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l).seq);
      assert.deepEqual(seqsFromOne, ['2', '3']);

      const resFromThree = await GET(srv.url, srv.token, srv.port, `/v1/sessions/${UUID}/events?after=3`);
      assert.equal(resFromThree.status, 200);
      assert.equal(await resFromThree.text(), '');
    } finally {
      await srv.close();
    }
  });

  it('schema-evolution guard: unknown type between and after known events, plus unknown fields', async () => {
    const UUID = '88888888-8888-4888-8888-888888888888';
    const dir = await mkdtemp(join(tmpdir(), 'slip-schema-'));
    await mkdir(join(dir, 'sessions', UUID), { recursive: true });
    const lines = [
      JSON.stringify({ seq: '1', type: 'slipstream.file.changed.v1', data: { path: 'a.txt' } }),
      JSON.stringify({
        seq: '2',
        type: 'future.unknown.v9',
        data: { path: 'b.txt', nested: { forward: { compat: true } } },
      }),
      JSON.stringify({
        seq: '3',
        type: 'slipstream.file.changed.v1',
        data: { path: 'c.txt' },
        unexpectedTopLevelField: 'still-present',
      }),
      '',
    ];
    await writeFile(join(dir, 'sessions', UUID, 'events.jsonl'), lines.join('\n'), 'utf8');
    const srv = await startReaderServer({ storeDir: dir });
    try {
      const res = await GET(srv.url, srv.token, srv.port, `/v1/sessions/${UUID}/events?after=0`);
      assert.equal(res.status, 200);
      const bodyLines = (await res.text()).split('\n').filter(Boolean);
      const parsed = bodyLines.map((l) => JSON.parse(l));
      assert.deepEqual(parsed.map((p) => p.seq), ['1', '2', '3']);
      // unknown type and unknown fields must pass through verbatim
      assert.equal(parsed[1]!.type, 'future.unknown.v9');
      assert.deepEqual(parsed[1]!.data.nested, { forward: { compat: true } });
      assert.equal(parsed[2]!.unexpectedTopLevelField, 'still-present');

      const followUp = await GET(srv.url, srv.token, srv.port, `/v1/sessions/${UUID}/events?after=3`);
      assert.equal(followUp.status, 200);
      assert.equal(await followUp.text(), '');
    } finally {
      await srv.close();
    }
  });
});
