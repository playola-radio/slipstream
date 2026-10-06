import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkForwarder, checkServe, run } from './package-check.ts';

/** Write an executable stub launcher into a fresh temp dir and return its path. */
async function stubLauncher(body: string): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'slipstream-forwarder-test-'));
  const bin = join(dir, 'launcher.mjs');
  await writeFile(bin, `#!/usr/bin/env node\n${body}\n`);
  await chmod(bin, 0o755);
  return { bin, dir };
}

test('run reports its deadline after stopping the child', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)"], process.cwd(), 50),
    /did not finish in 0.05s/,
  );
});

test('checkServe bounds a schema response body', async () => {
  const work = await mkdtemp(join(tmpdir(), 'slipstream-package-check-test-'));
  try {
    const descriptor = join(work, 'descriptor.json');
    const bin = join(work, 'serve-forever.mjs');
    await writeFile(bin, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import http from 'node:http';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{');
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port + '/';
  await writeFile(${JSON.stringify(descriptor)}, JSON.stringify({ url, token: 'test-token' }));
  console.error('slipstream: reader descriptor ' + ${JSON.stringify(descriptor)} + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
    await chmod(bin, 0o755);

    await assert.rejects(
      checkServe(work, bin, work, 50),
      (err: unknown) => err instanceof DOMException && err.name === 'TimeoutError',
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

const INIT_REPLY = `JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })`;
const TOOLS_REPLY = `JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'slipstream_begin_task' }, { name: 'slipstream_answer_question' }] } })`;

test('checkForwarder rejects a launcher that prints non-JSON output', async () => {
  // A valid handshake + tool list is still a failure if a banner line precedes
  // it: a stdio MCP client parses every line, so the check must too.
  const { bin, dir } = await stubLauncher(
    `process.stdout.write('starting slipstream-mcp...\\n');\n`
    + `process.stdout.write(${INIT_REPLY} + '\\n');\n`
    + `process.stdout.write(${TOOLS_REPLY} + '\\n');\n`,
  );
  try {
    await assert.rejects(checkForwarder(bin, dir, 5_000), /non-JSON stdout line/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkForwarder rejects a launcher that skips the initialize handshake', async () => {
  // tools/list answers without a successful initialize, so the check must demand
  // a protocol-versioned handshake rather than tools alone.
  const { bin, dir } = await stubLauncher(`process.stdout.write(${TOOLS_REPLY} + '\\n');\n`);
  try {
    await assert.rejects(checkForwarder(bin, dir, 5_000), /initialize did not complete the handshake/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkForwarder fails fast when the launcher cannot start', async () => {
  // A missing bin must surface the spawn error and run cleanup, not hang to the
  // request deadline. The generous timeout proves the early-exit break fires.
  const dir = await mkdtemp(join(tmpdir(), 'slipstream-forwarder-test-'));
  try {
    await assert.rejects(
      checkForwarder(join(dir, 'does-not-exist'), dir, 30_000),
      /launcher failed to start|ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
