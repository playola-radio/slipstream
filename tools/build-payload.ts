/**
 * Build the runtime payload the Slipstream macOS app embeds:
 *
 *   npm run build:payload -- --out <dir>
 *
 * `<dir>/app/` gets exactly what `npm pack` publishes (its `prepack` is the only
 * build, so there is one `dist/build-id`) plus production `node_modules`
 * installed from this repo's lockfile for the host's arch. The app adds its own
 * Node and shims.
 */
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED = ['dist/build-id', 'node_modules/@parcel/watcher-darwin-arm64'];

function fail(message: string): never {
  throw new Error(message);
}

function npm(args: string[], cwd: string): string {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) fail(`npm ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`npm ${args.join(' ')} exited ${String(result.status)} in ${cwd}`);
  return result.stdout;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== '--out') fail('usage: npm run build:payload -- --out <dir>');
  const app = join(resolve(argv[1]!), 'app');
  if (await access(app).then(() => true, () => false)) fail(`${app} already exists; build into a fresh directory`);

  const work = await mkdtemp(join(tmpdir(), 'slipstream-payload-'));
  try {
    const packed = JSON.parse(npm(['pack', '--pack-destination', work, '--json'], REPO_ROOT)) as { filename: string }[];
    const tarball = join(work, packed[0]!.filename.replace(/^.*\//, ''));
    await mkdir(app, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', app, '--strip-components', '1'], { stdio: 'inherit' });
    if (tar.error) fail(`tar could not run: ${tar.error.message}`);
    if (tar.status !== 0) fail(`could not extract ${tarball} into ${app}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  await copyFile(join(REPO_ROOT, 'package-lock.json'), join(app, 'package-lock.json'));
  npm(['ci', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund'], app);

  for (const path of REQUIRED) {
    if (!await access(join(app, path)).then(() => true, () => false)) fail(`${join(app, path)} is missing`);
  }
  const link = (await readdir(app, { recursive: true, withFileTypes: true })).find((e) => e.isSymbolicLink());
  if (link) fail(`${join(link.parentPath, link.name)} is a symbolic link; the payload must hold only real files`);
  console.log(`build-payload: ${app}`);
}

await main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`build-payload: ${err.message}`);
  process.exitCode = 1;
});
