import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { blobPath } from './store-reader.ts';
import { startReaderServer } from './http-reader.ts';
import { createInterfaceService } from './interface-service.ts';
import { createProjectionAdmission, type ProjectionAdmission, type AdmitRequest, type AdmitOutcome } from './projection-admission.ts';

const CASES = fileURLToPath(new URL('../contracts/interface/v2/cases/', import.meta.url));
const FIXTURE_BUDGET = { C: 2, Q: 8, W: 8, D: 30_000 };

async function fixture(name: string) {
  const base = join(CASES, name);
  const history = JSON.parse(await readFile(join(base, 'history.json'), 'utf8')) as {
    session_id: string; events: unknown[]; blobs: Record<string, string>; missing_blobs?: string[];
  };
  const request = (await readFile(join(base, 'request.txt'), 'utf8')).trim();
  let expected: unknown;
  let expectedError: { http_status: number; headers?: Record<string, string> } | undefined;
  try { expected = JSON.parse(await readFile(join(base, 'expected.json'), 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    expectedError = JSON.parse(await readFile(join(base, 'expected-error.json'), 'utf8')) as typeof expectedError;
  }
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-fd4-http-'));
  const sessionDir = join(storeDir, 'sessions', history.session_id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'events.jsonl'), history.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const [sha, text] of Object.entries(history.blobs)) {
    if (history.missing_blobs?.includes(sha)) continue;
    const path = blobPath(storeDir, sha);
    await mkdir(join(storeDir, 'blobs', 'sha256', sha.slice(0, 2)), { recursive: true });
    await writeFile(path, text);
  }
  return { storeDir, request, expected, expectedError, harness: (history as { harness?: unknown }).harness };
}

test('reader serves the public interface.v2 projection schema with authentication', async () => {
  const { storeDir } = await fixture('ts-parameter-change');
  const reader = await startReaderServer({ storeDir });
  try {
    const path = '/v1/schemas/projections/interface.v2';
    const unauthorized = await fetch(reader.url + path);
    assert.equal(unauthorized.status, 401);
    assert.equal(await unauthorized.text(), 'unauthorized');
    const response = await fetch(reader.url + path, { headers: { authorization: `Bearer ${reader.token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await response.text(), await readFile(fileURLToPath(
      new URL('../contracts/interface/v2/schema.json', import.meta.url)), 'utf8'));
  } finally {
    await reader.close();
    await rm(storeDir, { recursive: true, force: true });
  }
});

const HARNESS_ONLY = new Set(['range-admission-skipped', 'range-cancelled-mid-page',
  'range-deadline-mid-page', 'range-gap-cap', 'range-too-large-first-file']);
for (const name of (await readdir(CASES)).filter(name => !HARNESS_ONLY.has(name))) {
  test(`reader comparison matches recorded ${name} history`, async () => {
    const { storeDir, request, expected, expectedError } = await fixture(name);
    const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET });
    try {
      const response = await fetch(reader.url + request.slice(4), {
        headers: { authorization: `Bearer ${reader.token}` },
      });
      if (expectedError) {
        assert.equal(response.status, expectedError.http_status);
        for (const [key, value] of Object.entries(expectedError.headers ?? {})) {
          assert.equal(response.headers.get(key), value);
        }
        assert.ok(!(response.headers.get('content-type') ?? '').includes('application/json'));
        await response.text();
      } else {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.deepEqual(await response.json(), expected);
      }
    } finally {
      await reader.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
}

test('cache hit does not hide loss of a recorded content blob', async () => {
  const { storeDir, request, expected } = await fixture('ts-parameter-change');
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET });
  try {
    const path = request.slice(4);
    const get = () => fetch(reader.url + path, { headers: { authorization: `Bearer ${reader.token}` } });
    assert.deepEqual(await (await get()).json(), expected);
    const before = (expected as { files: { before: { snapshot: { sha256: string } } }[] }).files[0]!.before.snapshot.sha256;
    await unlink(blobPath(storeDir, before));
    const lost = await (await get()).json() as { status: string; files: { status: string; fallback_reason: string; changes: unknown[] }[] };
    assert.equal(lost.status, 'partial');
    assert.equal(lost.files[0]?.status, 'unavailable');
    assert.equal(lost.files[0]?.fallback_reason, 'before-blob-missing');
    assert.deepEqual(lost.files[0]?.changes, []);
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('next_after_path pages the same frozen comparison', async () => {
  const { storeDir, request, expected } = await fixture('range-page-boundary-first');
  const second = await fixture('range-page-boundary-second');
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET });
  try {
    const get = async (path: string) => (await fetch(reader.url + path, {
      headers: { authorization: `Bearer ${reader.token}` },
    })).json();
    const first = await get(request.slice(4)) as { page: { next_after_path: string | null }; range: unknown };
    assert.deepEqual(first, expected);
    const next = await get(second.request.slice(4));
    assert.deepEqual(next, second.expected);
  } finally {
    await reader.close();
    await rm(storeDir, { recursive: true, force: true });
    await rm(second.storeDir, { recursive: true, force: true });
  }
});

test('invalid and ahead-of-durable requests keep text errors and the 409 header', async () => {
  const { storeDir, request } = await fixture('ts-parameter-change');
  const reader = await startReaderServer({ storeDir });
  try {
    const path = request.slice(4);
    for (const bad of [path + '&unknown=x', path + '&before_seq=3', path.replace('before_seq=3', 'before_seq=03'),
      path.replace('before_seq=3', 'before_seq=5'), path + '&path_prefix=../']) {
      const response = await fetch(reader.url + bad, { headers: { authorization: `Bearer ${reader.token}` } });
      assert.equal(response.status, 400);
      assert.ok(!(response.headers.get('content-type') ?? '').includes('application/json'));
    }
    const ahead = await fetch(reader.url + path.replace('after_seq=4', 'after_seq=5'), {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    assert.equal(ahead.status, 409);
    assert.equal(ahead.headers.get('slipstream-durable-seq'), '4');
    assert.ok(!(ahead.headers.get('content-type') ?? '').includes('application/json'));
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('interface route keeps reader authentication, unknown-session and tombstone statuses', async () => {
  const { storeDir, request } = await fixture('ts-parameter-change');
  const reader = await startReaderServer({ storeDir });
  try {
    const path = request.slice(4);
    assert.equal((await fetch(reader.url + path)).status, 401);
    const headers = { authorization: `Bearer ${reader.token}` };
    const unknown = path.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    assert.equal((await fetch(reader.url + unknown, { headers })).status, 404);
    await writeFile(join(storeDir, 'sessions', '11111111-1111-4111-8111-111111111111', 'removed.json'), '{"version":1}');
    const gone = await fetch(reader.url + path, { headers });
    assert.equal(gone.status, 410);
    assert.equal(await gone.text(), 'gone');
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('reader compares a recorded TSX function binding', async () => {
  const original = JSON.parse(await readFile(join(CASES, 'ts-parameter-change', 'history.json'), 'utf8')) as {
    session_id: string; events: { data: Record<string, unknown> }[]; blobs: Record<string, string>;
  };
  const before = 'export const Card = ({ title }: Props): JSX.Element => <div>{title}</div>;\n';
  const after = 'export const Card = ({ title }: NewProps): JSX.Element => <div>{title}</div>;\n';
  const old = Object.entries(original.blobs);
  const replacements = new Map(old.map(([sha, text]) => {
    const source = text.includes('number') ? before : after;
    return [sha, { sha256: createHash('sha256').update(source).digest('hex'), source }];
  }));
  for (const event of original.events) {
    if (event.data.path === 'src/f.ts') event.data.path = 'src/Card.tsx';
    for (const field of ['snapshot', 'before', 'after']) {
      const snapshot = event.data[field] as { kind?: string; sha256?: string; size?: number } | undefined;
      const replacement = snapshot?.sha256 && replacements.get(snapshot.sha256);
      if (replacement) { snapshot.sha256 = replacement.sha256; snapshot.size = Buffer.byteLength(replacement.source); }
    }
  }
  const storeDir = await mkdtemp(join(tmpdir(), 'slip-fd4-tsx-'));
  await mkdir(join(storeDir, 'sessions', original.session_id), { recursive: true });
  const logPath = join(storeDir, 'sessions', original.session_id, 'events.jsonl');
  const tsEvents = structuredClone(original.events);
  for (const event of tsEvents) if (event.data.path === 'src/Card.tsx') event.data.path = 'src/Card.ts';
  await writeFile(logPath, tsEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
  for (const { sha256, source } of replacements.values()) {
    const path = blobPath(storeDir, sha256);
    await mkdir(join(storeDir, 'blobs', 'sha256', sha256.slice(0, 2)), { recursive: true });
    await writeFile(path, source);
  }
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET });
  try {
    const path = `/v1/sessions/${original.session_id}/interfaces?before_seq=3&after_seq=4`;
    const headers = { authorization: `Bearer ${reader.token}` };
    const tsResponse = await fetch(reader.url + path, { headers });
    assert.equal(tsResponse.status, 200);
    const tsBody = await tsResponse.json() as { files: { status: string }[] };
    assert.equal(tsBody.files[0]?.status, 'incomplete');
    await writeFile(logPath, original.events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const response = await fetch(`${reader.url}/v1/sessions/${original.session_id}/interfaces?before_seq=3&after_seq=4`, {
      headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { files: { path: string; language: string; status: string; changes: { kind: string }[] }[] };
    assert.equal(body.files[0]?.path, 'src/Card.tsx');
    assert.equal(body.files[0]?.language, 'typescript');
    assert.equal(body.files[0]?.status, 'ready');
    assert.deepEqual(body.files[0]?.changes.map(row => row.kind), ['signatureChanged']);
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

for (const [name, config] of [
  ['range-admission-skipped', { projectionAdmissionConfig: { C: 0, Q: 0, W: 0, D: 100 } }],
  ['range-gap-cap', { projectionAdmissionConfig: FIXTURE_BUDGET, interfaceLimits: { metadataBytes: 0 } }],
  ['range-too-large-first-file', { projectionAdmissionConfig: FIXTURE_BUDGET, interfaceLimits: { fileResultBytes: 0 } }],
] as const) {
  test(`reader honors ${name} execution condition against its golden response`, async () => {
    const { storeDir, request, expected } = await fixture(name);
    const reader = await startReaderServer({ storeDir, ...config });
    try {
      const response = await fetch(reader.url + request.slice(4), {
        headers: { authorization: `Bearer ${reader.token}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
  });
}

test('deletion during Swift extraction returns 410 after the asynchronous work', async () => {
  const { storeDir, request } = await fixture('swift-parameter-change');
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET });
  try {
    const pending = fetch(reader.url + request.slice(4), {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    await delay(35);
    await writeFile(join(storeDir, 'sessions', '11111111-1111-4111-8111-111111111111', 'removed.json'), '{"version":1}');
    const response = await pending;
    assert.equal(response.status, 410);
    assert.equal(await response.text(), 'gone');
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('isolated Swift host failure stays a text HTTP 500 and does not imply no changes', async () => {
  const { storeDir, request } = await fixture('swift-parameter-change');
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET,
    interfaceExtractSwift: async () => { throw new Error('Swift host artifact failure'); } });
  try {
    const response = await fetch(reader.url + request.slice(4), {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'internal error');
    assert.ok(!(response.headers.get('content-type') ?? '').includes('application/json'));
    const schema = await fetch(reader.url + '/v1/schemas/projections/interface.v2', {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    assert.equal(schema.status, 200);
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('a Swift host reply missing a requested side fails closed as text HTTP 500', async () => {
  const { storeDir, request } = await fixture('swift-parameter-change');
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET,
    interfaceExtractSwift: async () => new Map() });
  try {
    const response = await fetch(reader.url + request.slice(4), {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'internal error');
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('reader shutdown aborts in-flight isolated Swift work before closing', async () => {
  const { storeDir, request } = await fixture('swift-parameter-change');
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const reader = await startReaderServer({ storeDir, projectionAdmissionConfig: FIXTURE_BUDGET,
    interfaceExtractSwift: async (_sides, options) => {
      const signal = options?.signal;
      started();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) { aborted = true; reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
      return new Map();
    } });
  try {
    const pending = fetch(reader.url + request.slice(4), {
      headers: { authorization: `Bearer ${reader.token}` },
    }).catch(() => null);
    await didStart;
    await reader.close();
    await pending;
    assert.equal(aborted, true);
  } finally { await rm(storeDir, { recursive: true, force: true }); }
});

test('clip and interface requests draw from one reader-owned admission budget', async () => {
  const { storeDir, request } = await fixture('swift-parameter-change');
  const reader = await startReaderServer({ storeDir,
    projectionAdmissionConfig: { C: 1, Q: 0, W: 0, D: 30_000 } });
  try {
    const headers = { authorization: `Bearer ${reader.token}` };
    const interfacePending = fetch(reader.url + request.slice(4), { headers });
    await delay(35);
    const clip = await fetch(`${reader.url}/v1/sessions/11111111-1111-4111-8111-111111111111/changes/4/clips`, { headers });
    assert.equal(clip.status, 200);
    assert.equal((await clip.json() as { fallback_reason: string }).fallback_reason, 'overloaded');
    assert.equal((await interfacePending).status, 200);
  } finally { await reader.close(); await rm(storeDir, { recursive: true, force: true }); }
});

async function serviceRequest(name: string) {
  const data = await fixture(name);
  const parsed = new URL('http://localhost' + data.request.slice(4));
  const history = JSON.parse(await readFile(join(CASES, name, 'history.json'), 'utf8')) as { durable_seq: string };
  return { ...data, req: { sessionId: parsed.pathname.split('/')[3]!,
    logPath: join(data.storeDir, 'sessions', parsed.pathname.split('/')[3]!, 'events.jsonl'),
    durableSeq: BigInt(history.durable_seq),
    beforeSeq: BigInt(parsed.searchParams.get('before_seq')!), afterSeq: BigInt(parsed.searchParams.get('after_seq')!),
    pathPrefix: parsed.searchParams.get('path_prefix') ?? '', afterPath: parsed.searchParams.get('after_path'),
    includeIdentical: parsed.searchParams.get('include_identical') === 'true',
    limit: Number(parsed.searchParams.get('limit') ?? '16'),
  } };
}

test('pre-first-file cancellation and scan limit disclose unevaluated metadata', async () => {
  const { storeDir, req } = await serviceRequest('ts-parameter-change');
  const admission = createProjectionAdmission(FIXTURE_BUDGET);
  const cancelled = new AbortController();
  cancelled.abort();
  const service = createInterfaceService({ storeDir, admission });
  try {
    const stopped = await service.get({ ...req, signal: cancelled.signal });
    assert.equal(stopped.status, 'skipped');
    assert.equal(stopped.fallback_reason, 'cancelled');
    assert.equal(stopped.inventory, null);
    assert.equal(stopped.gaps, null);
    const scanService = createInterfaceService({ storeDir, admission, scanBudget: { records: 0, bytes: 0 } });
    try {
      const limited = await scanService.get(req);
      assert.equal(limited.status, 'skipped');
      assert.equal(limited.fallback_reason, 'scan-limit');
      assert.equal(limited.inventory, null);
      assert.equal(limited.gaps, null);
    } finally { await scanService.close(); }
  } finally { await admission.close(); await service.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('deadline before any file starts returns a skipped page without moving the cursor', async () => {
  const { storeDir, req } = await serviceRequest('ts-parameter-change');
  const admission: ProjectionAdmission = {
    admit: async () => ({ kind: 'timeout' }), close: async () => {},
    snapshot: () => ({ running: 0, queued: 0, waiters: 0 }),
  };
  const service = createInterfaceService({ storeDir, admission });
  try {
    const page = await service.get(req);
    assert.equal(page.status, 'skipped');
    assert.equal(page.fallback_reason, 'timeout');
    assert.equal(page.inventory, null);
    assert.equal(page.gaps, null);
    assert.deepEqual(page.files, []);
    assert.deepEqual(page.page, { complete: false, next_after_path: null });
  } finally { await service.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('mid-page cancellation preserves finished rows and advances after_path', async () => {
  const { storeDir, req, expected } = await serviceRequest('range-cancelled-mid-page');
  const admission = createProjectionAdmission(FIXTURE_BUDGET);
  const controller = new AbortController();
  const service = createInterfaceService({ storeDir, admission, onFileStart: path => {
    if (path === 'src/b.ts') controller.abort();
  } });
  try { assert.deepEqual(await service.get({ ...req, signal: controller.signal }), expected); }
  finally { await admission.close(); await service.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('mid-page deadline preserves finished rows and advances after_path', async () => {
  const { storeDir, req, expected } = await serviceRequest('range-deadline-mid-page');
  let deadline = () => {};
  const admission: ProjectionAdmission = {
    admit: <T>(request: AdmitRequest<T>): Promise<AdmitOutcome<T>> => new Promise<AdmitOutcome<T>>(resolve => {
      const handle = request.run();
      deadline = () => { handle.cancel(); resolve({ kind: 'timeout' }); };
      handle.promise.then(value => resolve({ kind: 'ok', value }), () => resolve({ kind: 'error' }));
    }),
    close: async () => {}, snapshot: () => ({ running: 0, queued: 0, waiters: 0 }),
  };
  const service = createInterfaceService({ storeDir, admission, onFileStart: path => {
    if (path === 'src/b.ts') deadline();
  } });
  try { assert.deepEqual(await service.get(req), expected); }
  finally { await service.close(); await rm(storeDir, { recursive: true, force: true }); }
});

test('page blob budget ends before the next file with an exclusive cursor', async () => {
  const { storeDir, req, expected } = await serviceRequest('range-page-boundary-first');
  const admission = createProjectionAdmission(FIXTURE_BUDGET);
  const service = createInterfaceService({ storeDir, admission, pageBlobBytes: 62 });
  try { assert.deepEqual(await service.get({ ...req, limit: 16 }), expected); }
  finally { await admission.close(); await service.close(); await rm(storeDir, { recursive: true, force: true }); }
});
