/**
 * The Slipstream macOS app runs this package from its own runtime folder through
 * two stable shims, `bin/slipstream` and `bin/slipstream-mcp`, which set
 * SLIPSTREAM_APP_RUNTIME to that folder. Only the shims set it, so it is read
 * as given. Hooks and connector configs written in the app point at the shims,
 * so an app update moves them along without rewriting any of them.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultDaemonStore } from './daemon-location.ts';

export interface AppRuntime { root: string; cli: string; mcp: string }

/** A command a hook or connector config runs. */
export interface Entry { command: string; args: string[] }

export function appRuntime(env: NodeJS.ProcessEnv): AppRuntime | null {
  const root = env.SLIPSTREAM_APP_RUNTIME;
  if (!root) return null;
  return { root, cli: join(root, 'bin', 'slipstream'), mcp: join(root, 'bin', 'slipstream-mcp') };
}

/** How hooks run the CLI and connectors run the MCP forwarder: the app's shims,
 * or outside the app this Node with the CLI and the forwarder beside it. */
export function agentEntries(env: NodeJS.ProcessEnv, nodePath: string, cliPath: string): { entry: Entry; mcpEntry: Entry } {
  const runtime = appRuntime(env);
  if (runtime) return { entry: { command: runtime.cli, args: [] }, mcpEntry: { command: runtime.mcp, args: [] } };
  const forwarder = join(dirname(cliPath), `mcp-forwarder${extname(cliPath)}`);
  return { entry: { command: nodePath, args: [cliPath] }, mcpEntry: { command: nodePath, args: [forwarder] } };
}

/** Where the app keeps the runtimes it copies out of its bundle. */
export function appRuntimeRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'com.playola.SlipstreamViewer', 'runtime');
}

/**
 * Why this copy must not start or restart the recorder for `store`, or null when
 * it may. The app manages the recorder for the default store once it has copied
 * a complete runtime, whether or not it has activated one yet: it only activates
 * when no other recorder runs, so an npm recorder started at every login would
 * keep it from ever doing so. The app's own copy may run it, whether started
 * through the shims or by the LaunchAgent the app installed, which runs the
 * runtime's cli.js without them.
 */
export async function appRecorderRefusal(o: { env: NodeJS.ProcessEnv; home: string; cliPath: string; store: string }):
  Promise<string | null> {
  if (appRuntime(o.env) || resolve(o.store) !== defaultDaemonStore(o.home)) return null;
  const root = appRuntimeRoot(o.home);
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return null;
  const inside = relative(realRoot, await realpath(o.cliPath).catch(() => resolve(o.cliPath)));
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return null;
  if (!await hasPreparedRuntime(realRoot)) return null;
  return `Slipstream.app manages the recorder for ${o.store}, so this slipstream (${o.cliPath}) will not start or restart one. `
    + `Open Slipstream.app, and run slipstream through the app's copy, ${join(root, 'bin', 'slipstream')}. `
    + `If Slipstream.app was removed, delete ${root} to let this copy run the recorder again.`;
}

/** A runtime the app finished copying; staging folders are hidden until renamed. */
async function hasPreparedRuntime(root: string): Promise<boolean> {
  for (const name of await readdir(root).catch(() => [])) {
    if (name.startsWith('.')) continue;
    const files = ['app/package.json', 'app/dist/cli.js', 'bin/node'].map((f) => stat(join(root, name, f)).then((s) => s.isFile(), () => false));
    if ((await Promise.all(files)).every(Boolean)) return true;
  }
  return false;
}
