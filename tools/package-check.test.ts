import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkServe, run } from './package-check.ts';

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
