import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';

// Keep the complete start event well below the client's 1 MiB SSE line limit.
const POLICY_BYTES = 512 * 1024;
const exec = promisify(execFile);
type RuleSource = { dir: string; text: string };
export interface CaptureIgnores {
  version: 1;
  git: null | { root_prefix: string; ignore_case: boolean; sources: RuleSource[]; tracked_exceptions: string[] };
  slipstreamignore: string | null;
}

function fail(message: string): never { throw new Error(`Capture ignore policy: ${message}`); }
function safePath(path: unknown, empty = false): path is string {
  return typeof path === 'string' && (empty && path === '' || path !== '' && !isAbsolute(path)
    && !path.includes('\0') && !path.split(/[\\/]/).some((p) => p === '..' || p === '.'));
}
function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function bounded(policy: CaptureIgnores): CaptureIgnores {
  if (Buffer.byteLength(JSON.stringify(policy)) > POLICY_BYTES) fail('saved rules exceed the 512 KiB limit');
  return policy;
}

/** Validate before replay; never reinterpret an unknown policy as no exclusions. */
export function parseCaptureIgnores(value: unknown): CaptureIgnores {
  const p = value as CaptureIgnores | null;
  if (!p || typeof p !== 'object' || p.version !== 1
    || !(p.slipstreamignore === null || typeof p.slipstreamignore === 'string')) fail('invalid policy or version');
  if (p.git !== null) {
    const g = p.git;
    if (!g || typeof g !== 'object' || typeof g.root_prefix !== 'string'
      || !(g.root_prefix === '' || g.root_prefix.endsWith('/') && safePath(g.root_prefix.slice(0, -1)))
      || typeof g.ignore_case !== 'boolean' || !Array.isArray(g.sources) || !Array.isArray(g.tracked_exceptions)) fail('invalid Git policy');
    for (const s of g.sources) {
      if (!s || !safePath(s.dir, true) || s.dir.endsWith('/') || typeof s.text !== 'string') fail('invalid rule source path or text');
    }
    for (const path of g.tracked_exceptions) if (!safePath(path) || path.endsWith('/')) fail('invalid tracked exception path');
  }
  return bounded(p);
}

/** Rebase nested rules into one matcher so precedence and excluded parents are
 * resolved together. Per-file matchers would incorrectly retain parent ignores
 * that a deeper rule has already overridden. Wildmatch stays in the library. */
function scopedPatterns(source: RuleSource): string[] {
  if (source.dir === '') return source.text.split(/\r?\n/);
  const scope = source.dir.replace(/[\\*?\[\]!#]/g, '\\$&');
  return source.text.split(/\r?\n/).flatMap((line) => {
    // Strip only unescaped trailing spaces before deciding whether '/' anchors
    // the pattern. Prefixing a blank line would otherwise turn it into a rule.
    while (line.endsWith(' ')) {
      let slashes = 0;
      for (let i = line.length - 2; i >= 0 && line[i] === '\\'; i--) slashes++;
      if (slashes % 2) break;
      line = line.slice(0, -1);
    }
    if (line === '' || line.startsWith('#')) return [];
    const negative = line.startsWith('!');
    let body = negative ? line.slice(1) : line;
    if (body === '') return [];
    const directory = body.endsWith('/');
    if (directory) body = body.slice(0, -1);
    if (body === '') return [];
    const anchored = body.includes('/');
    if (body.startsWith('/')) body = body.slice(1);
    return [`${negative ? '!' : ''}${scope}/${anchored ? '' : '**/'}${body}${directory ? '/' : ''}`];
  });
}

export function compileCaptureIgnores(policy: CaptureIgnores): (rel: string, isDir?: boolean) => boolean {
  const slip = ignore({ ignorecase: false }).add(policy.slipstreamignore ?? '');
  const git = policy.git;
  const matcher = ignore({ ignorecase: git?.ignore_case ?? false });
  for (const s of git?.sources ?? []) matcher.add(scopedPatterns(s));
  const key = (path: string) => git?.ignore_case ? path.toLowerCase() : path;
  const tracked = new Set((git?.tracked_exceptions ?? []).map(key));
  const parents = new Set<string>();
  for (const path of tracked) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) { parents.add(parts.join('/')); parts.pop(); }
  }
  return (rel, isDir = false) => {
    if (rel === '') return false;
    const query = rel + (isDir ? '/' : '');
    if (slip.ignores(query)) return true;
    if (!git || (isDir ? parents : tracked).has(key(rel))) return false;
    return matcher.ignores(git.root_prefix + query);
  };
}

/** Git runs only at capture start. Rule text and tracked exceptions are frozen
 * in the public log; neither live observations nor recovery consult Git. */
export async function loadCaptureIgnores(root: string, storeDir?: string): Promise<CaptureIgnores> {
  root = await realpath(root);
  const deadline = Date.now() + 10_000;
  const checkTime = () => { if (Date.now() >= deadline) fail('rule discovery exceeded its 10-second budget'); };
  let readBytes = 0;
  const readRule = async (path: string): Promise<string | null> => {
    checkTime();
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
      return fail(`cannot read ${path}: ${(err as Error).message}`);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail(`rule file is not a regular file: ${path}`);
      const remaining = POLICY_BYTES - readBytes;
      if (stat.size > remaining) fail(`rule text exceeds the 512 KiB limit: ${path}`);
      const bytes = Buffer.alloc(remaining + 1);
      let used = 0;
      while (used < bytes.length) {
        checkTime();
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > remaining) fail(`rule text exceeds the 512 KiB limit: ${path}`);
      readBytes += used;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
    } catch (err) { return fail(`cannot read ${path}: ${(err as Error).message}`); }
    finally { await handle.close(); }
  };
  const policy: CaptureIgnores = { version: 1, git: null, slipstreamignore: await readRule(join(root, '.slipstreamignore')) };
  let repo: string | undefined;
  for (let dir = root; ; dir = dirname(dir)) {
    try { await lstat(join(dir, '.git')); repo = dir; break; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fail(`cannot inspect Git metadata: ${(err as Error).message}`); }
    if (dirname(dir) === dir) break;
  }
  if (!repo) return bounded(policy);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = async (args: string[], optional = false): Promise<string> => {
    checkTime();
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', ...args], {
        cwd: root, env, timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: POLICY_BYTES, encoding: 'buffer',
      });
      checkTime();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout);
    } catch (err) {
      if (optional && (err as { code?: number }).code === 1) return '';
      if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail(`Git ${args[0]} output exceeds the 512 KiB policy limit`);
      return fail(`Git ${args[0]} failed: ${(err as Error).message}`);
    }
  };
  const chomp = (s: string) => s.endsWith('\n') ? s.slice(0, -1) : s;
  repo = await realpath(chomp(await git(['rev-parse', '--show-toplevel'])));
  if (!within(root, repo)) fail('Git worktree does not contain the capture root');
  const ignoreCase = chomp(await git(['config', '--bool', '--get', 'core.ignoreCase'], true)) === 'true';
  const tracked = (await git(['ls-files', '-z', '--cached', '--ignored', '--exclude-per-directory=.gitignore'])).split('\0').filter(Boolean);
  const prefix = relative(repo, root).split(sep).join('/');
  policy.git = { root_prefix: prefix ? `${prefix}/` : '', ignore_case: ignoreCase, sources: [], tracked_exceptions: [...new Set(tracked)].sort() };
  let policyBytes = Buffer.byteLength(JSON.stringify(bounded(policy)));
  const addSource = async (path: string, dir: string) => {
    const text = await readRule(path);
    if (text === null) return;
    const source = { dir, text };
    policyBytes += Buffer.byteLength(JSON.stringify(source)) + (policy.git!.sources.length ? 1 : 0);
    if (policyBytes > POLICY_BYTES) fail('saved rules exceed the 512 KiB limit');
    policy.git!.sources.push(source);
  };
  let ancestor = repo;
  while (ancestor !== root) {
    await addSource(join(ancestor, '.gitignore'), relative(repo, ancestor).split(sep).join('/'));
    const next = relative(ancestor, root).split(sep)[0]!;
    ancestor = join(ancestor, next);
  }
  let compiledSources = -1;
  let discoveryMatcher: ReturnType<typeof compileCaptureIgnores>;
  const walk = async (dir: string): Promise<void> => {
    await addSource(join(dir, '.gitignore'), relative(repo!, dir).split(sep).join('/'));
    if (compiledSources !== policy.git!.sources.length) {
      discoveryMatcher = compileCaptureIgnores({ ...policy, git: { ...policy.git!, tracked_exceptions: [] } });
      compiledSources = policy.git!.sources.length;
    }
    const excludes = discoveryMatcher;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return;
      throw err;
    }
    checkTime();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (storeDir && within(abs, storeDir)) continue;
      if (excludes(relative(root, abs).split(sep).join('/'), true)) continue;
      // Nested worktrees have their own index and policy; do not pretend their
      // rules use the outer repository's tracked exceptions. Capture retains
      // its existing scope there, governed by the outer capture's rules only.
      try { await lstat(join(abs, '.git')); continue; }
      catch (err) { if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err; }
      await walk(abs);
    }
  };
  try { await walk(root); }
  catch (err) { fail(`cannot discover rule files: ${(err as Error).message}`); }
  return parseCaptureIgnores(policy);
}
