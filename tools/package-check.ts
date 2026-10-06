/**
 * Package smoke check: pack the repo, install the tarball into a fresh temp
 * project, and drive the INSTALLED copy. Node refuses type stripping for files
 * under node_modules, so this proves the published artifact is compiled JS and
 * that everything it reads at runtime (schemas, workers, the Swift child)
 * actually shipped. Run with `npm run check:package`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_DIR = 'node_modules/@playola-radio/slipstream';

const LOADER_FAILURE = /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find (module|package)/;

const REQUIRED_FILES = [
  'dist/swift-parse-worker.js',
  'contracts/interface/v2/schema.json',
  'LICENSE',
  'README.md',
  'SKILL.md',
];

const PROBE = `
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = '@playola-radio/slipstream/dist/';

const { schemaBytes, projectionSchemaBytes } = await import(dist + 'store-reader.js');
assert.ok(await schemaBytes('slipstream.file.changed.v1'), 'event schema did not load');
assert.ok(await projectionSchemaBytes('clip.v3'), 'clip projection schema did not load');
assert.ok(await projectionSchemaBytes('interface.v2'), 'interface.v2 schema did not load');
const { loadAllSchemas } = await import(dist + 'schema.js');
assert.ok((await loadAllSchemas()).size > 0, 'no event schemas found');
console.log('probe: schemas ok');

const store = await mkdtemp(join(tmpdir(), 'slipstream-probe-'));
try {
  const { createCas } = await import(dist + 'cas.js');
  const cas = await createCas(join(store, 'blobs'));
  const before = await cas.put(Buffer.from('export function f(): number {\\n  return 1;\\n}\\n'));
  const after = await cas.put(Buffer.from('export function f(): number {\\n  return 2;\\n}\\n'));

  const { createClipWorkerPool } = await import(dist + 'clip-worker-pool.js');
  const clipPool = createClipWorkerPool();
  try {
    const clips = await clipPool.run({
      storeDir: store,
      before: { kind: 'content', sha256: before.sha256, size: before.size },
      after: { kind: 'content', sha256: after.sha256, size: after.size },
      opts: { changeSeq: '1', language: 'typescript' },
    }).promise;
    assert.equal(clips.status, 'ready', 'clip worker: ' + JSON.stringify(clips));
  } finally { await clipPool.close(); }
  console.log('probe: clip worker ok');
} finally { await rm(store, { recursive: true, force: true }); }

const { createTypeScriptPool } = await import(dist + 'interface-ts-pool.js');
const tsPool = createTypeScriptPool();
try {
  const result = await tsPool.run({ language: 'typescript',
    before: Buffer.from('function f(x: number): void {}'),
    after: Buffer.from('function f(x: string): void {}') }).promise;
  assert.equal(result.comparison?.status, 'ready', 'typescript worker: ' + JSON.stringify(result));
} finally { await tsPool.close(); }
console.log('probe: typescript worker ok');

const { runSwiftParseChild } = await import(dist + 'swift-parse.js');
const swift = await runSwiftParseChild({ op: 'parse', source: 'func f() {}\\n' });
assert.equal(swift.op, 'parse');
assert.equal(swift.result.clean, true, 'swift child: ' + JSON.stringify(swift.result));
console.log('probe: swift child ok');
`;

interface RunResult { code: number | null; stdout: string; stderr: string }

/** SIGTERM, then SIGKILL if the child has not exited within 5s. */
async function stop(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const killed = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), 5_000); }),
  ]);
  clearTimeout(timer);
  if (killed) {
    child.kill('SIGKILL');
    await exited;
  }
}

export function run(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutError: Error | undefined;
    const exited = new Promise<void>((done) => child.on('close', () => done()));
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutError = new Error(`${command} ${args.join(' ')} did not finish in ${timeoutMs / 1000}s:\n${stdout}\n${stderr}`);
      void stop(child, exited);
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(timeoutError);
      else resolve({ code, stdout, stderr });
    });
  });
}

function fail(step: string, detail: string): never {
  throw new Error(`package-check FAILED at "${step}":\n${detail}`);
}

function assertClean(step: string, result: RunResult, expectedCode = 0): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (LOADER_FAILURE.test(output)) fail(step, output);
  if (result.code !== expectedCode) fail(step, `exit code ${result.code} (expected ${expectedCode})\n${output}`);
}

async function checkInstalledFiles(project: string): Promise<void> {
  for (const file of REQUIRED_FILES) {
    try { await access(join(project, PACKAGE_DIR, file)); }
    catch { fail('installed files', `missing from the installed package: ${file}`); }
  }
}

/** `serve` loads the whole CLI import graph, the native watcher, and the HTTP
 * reader; fetching a schema through it proves the reader finds shipped data. */
export async function checkServe(project: string, bin: string, work: string, requestTimeoutMs = 30_000): Promise<void> {
  const worktree = join(work, 'worktree');
  const store = join(work, 'store');
  await mkdir(worktree);
  const child = spawn(bin, ['serve', worktree, '--store', store], { cwd: project, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let readyResolve!: (descriptorPath: string) => void;
  const ready = new Promise<string>((resolve) => { readyResolve = resolve; });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
    const match = /slipstream: reader descriptor (.+)\n/.exec(stderr);
    if (match) readyResolve(match[1]!);
  });
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`serve did not become ready in 30s:\n${stderr}`)), 30_000).unref());
    const descriptorPath = await Promise.race([ready, exited.then((code) => {
      throw new Error(`serve exited early (code ${code}):\n${stderr}`);
    }), timeout]);
    const { url, token } = JSON.parse(await readFile(descriptorPath, 'utf8')) as { url: string; token: string };
    const headers = { authorization: `Bearer ${token}` };
    for (const path of ['v1/schemas/slipstream.file.changed.v1', 'v1/schemas/projections/interface.v2']) {
      const res = await fetch(new URL(path, url), { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (res.status !== 200) fail('serve', `GET ${path} -> ${res.status}`);
      JSON.parse(await res.text());
    }
  } catch (err) {
    if (LOADER_FAILURE.test(stderr)) fail('serve', stderr);
    throw err;
  } finally {
    await stop(child, exited);
  }
  if (LOADER_FAILURE.test(stderr)) fail('serve', stderr);
}

interface JsonRpcReply {
  id?: number;
  result?: { protocolVersion?: string; capabilities?: { tools?: unknown }; tools?: { name?: string }[] };
}

/** Drive the installed `slipstream-mcp` launcher over stdio. The forwarder must
 * complete `initialize` and then answer `tools/list` without a daemon (it only
 * reaches one on a tool call), so a protocol-versioned handshake plus both tools
 * proves the published `bin` entry resolves to compiled JS that loads its whole
 * import graph. A launcher that cannot start, or that prints anything other than
 * JSON-RPC lines, fails the check — the real MCP client parses every line. */
export async function checkForwarder(bin: string, cwd: string, requestTimeoutMs = 30_000): Promise<void> {
  const child = spawn(bin, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>((done) => child.on('close', () => done()));
  let closed = false;
  let spawnError: Error | undefined;
  child.on('close', () => { closed = true; });
  child.on('error', (err) => { spawnError = err; });
  child.stdin.on('error', () => { /* a broken pipe surfaces via 'error'/'close' below */ });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const deadline = Date.now() + requestTimeoutMs;
    let handshake: JsonRpcReply | undefined;
    let listed: JsonRpcReply | undefined;
    while (Date.now() < deadline) {
      // Parse only complete lines; keep the final (possibly partial) segment for
      // the next read. A complete non-empty line that is not valid JSON-RPC is a
      // failure, not noise — a stdio MCP client would choke on it.
      const lines = stdout.split('\n');
      for (const line of lines.slice(0, -1)) {
        if (!line.trim()) continue;
        let msg: JsonRpcReply;
        try {
          msg = JSON.parse(line) as JsonRpcReply;
        } catch {
          fail('slipstream-mcp', `non-JSON stdout line from the launcher:\n${line}\n${stderr}`);
        }
        if (msg.id === 1) handshake = msg;
        if (msg.id === 2) listed = msg;
      }
      if (spawnError) fail('slipstream-mcp', `launcher failed to start: ${spawnError.message}\n${stderr}`);
      if (LOADER_FAILURE.test(stderr)) fail('slipstream-mcp', stderr);
      if (handshake && listed) break;
      if (closed) break; // the child is gone; stop waiting instead of hanging to the deadline
      await new Promise((r) => setTimeout(r, 50));
    }
    if (spawnError) fail('slipstream-mcp', `launcher failed to start: ${spawnError.message}\n${stderr}`);
    if (LOADER_FAILURE.test(stderr)) fail('slipstream-mcp', stderr);
    if (!handshake?.result?.protocolVersion || handshake.result.capabilities?.tools === undefined) {
      fail('slipstream-mcp', `initialize did not complete the handshake:\n${stdout}\n${stderr}`);
    }
    if (!listed) fail('slipstream-mcp', `no tools/list response:\n${stdout}\n${stderr}`);
    const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, ['slipstream_answer_question', 'slipstream_begin_task'],
      `unexpected tools from slipstream-mcp: ${JSON.stringify(names)}\n${stderr}`);
  } finally {
    try { child.stdin.end(); } catch { /* already closed */ }
    await stop(child, exited);
  }
}

export async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'slipstream-package-check-'));
  try {
    const packDir = join(work, 'pack');
    const project = join(work, 'project');
    await mkdir(packDir);
    await mkdir(project);

    const pack = await run('npm', ['pack', '--pack-destination', packDir, '--json'], REPO_ROOT);
    assertClean('npm pack', pack);
    const tarball = join(packDir, (JSON.parse(pack.stdout) as { filename: string }[])[0]!.filename.replace(/^.*\//, ''));
    console.log(`package-check: packed ${tarball}`);

    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'package-check-project', private: true, type: 'module' }));
    assertClean('npm install', await run('npm', ['install', '--no-audit', '--no-fund', tarball], project, 300_000));
    await checkInstalledFiles(project);
    console.log('package-check: installed package has every required file');

    const bin = join(project, 'node_modules/.bin/slipstream');
    const usage = await run(bin, [], project);
    assertClean('slipstream (no arguments)', usage, 2);
    if (!usage.stderr.includes('Usage: slipstream')) fail('slipstream (no arguments)', `no usage text:\n${usage.stderr}`);
    console.log('package-check: installed CLI runs');

    await checkServe(project, bin, work);
    console.log('package-check: installed CLI serves schemas');

    const forwarderBin = join(project, 'node_modules/.bin/slipstream-mcp');
    await checkForwarder(forwarderBin, project);
    console.log('package-check: installed MCP forwarder lists its tools');

    await writeFile(join(project, 'probe.mjs'), PROBE);
    const probe = await run(process.execPath, ['probe.mjs'], project);
    assertClean('probe', probe);
    process.stdout.write(probe.stdout);
    console.log('package-check: PASS');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
