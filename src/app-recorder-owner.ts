/**
 * Slipstream.app runs its own copy of this package and owns the recorder for the
 * default store (the LaunchAgent and `~/.slipstream`). Any other copy, such as a
 * global npm install, must then leave that recorder alone: an npm LaunchAgent
 * starts first at login and is usually newer, and the app will not replace a
 * newer recorder, so the app would be stuck behind it.
 *
 * The app counts as set up once it has prepared a runtime folder. Not `current`:
 * the app points `current` at its runtime only after it has checked what is
 * running, and it stops before that when it finds a newer recorder, which is
 * exactly the machine this guards. Not the runtime root alone: the app creates
 * it for its lock before the copy can fail.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { appRuntime } from './app-runtime.ts';
import { defaultDaemonStore } from './daemon-location.ts';

export function appRuntimeRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'com.playola.SlipstreamViewer', 'runtime');
}

/** The app's runtime root when the app owns this store's recorder and this CLI
 * (given by its real path) is not the app's copy; null when this CLI may manage
 * the recorder. */
export async function appRecorderRoot(o: { home: string; store: string; env: NodeJS.ProcessEnv; cliPath: string }):
  Promise<string | null> {
  if (appRuntime(o.env)) return null;
  const root = appRuntimeRoot(o.home);
  try {
    if (await canonical(o.store) !== await canonical(defaultDaemonStore(o.home))) return null;
    let names: string[];
    try { names = await readdir(root); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // launchd starts the app's recorder from its runtime folder without the shim.
    const fromRoot = relative(await realpath(root), o.cliPath);
    if (fromRoot !== '' && fromRoot.split(sep)[0] !== '..' && !isAbsolute(fromRoot)) return null;
    // A runtime folder appears only by renaming a verified copy into place.
    for (const name of names) {
      if (!name.startsWith('.') && await isFile(join(root, name, 'app', 'dist', 'cli.js'))) return root;
    }
    return null;
  } catch (err) {
    throw new Error(`couldn't tell whether Slipstream.app manages the recorder for ${o.store} from ${root}: `
      + `${(err as Error).message}`, { cause: err });
  }
}

/** The real path of `path`, through its nearest existing ancestor when it does not exist yet. */
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (err) {
    const parent = dirname(path);
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw err;
    return join(await canonical(parent), basename(path));
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

export function appOwnedRefusal(store: string, root: string, cliPath: string, wontDo: string): string {
  return `Slipstream.app manages the recorder for ${store}, so this copy of slipstream (${cliPath}) will not ${wontDo}. `
    + `Open Slipstream.app, and run slipstream through its command, ${join(root, 'bin', 'slipstream')}. `
    + `If you uninstalled Slipstream.app, remove ${root} to let this copy run the recorder again.`;
}
