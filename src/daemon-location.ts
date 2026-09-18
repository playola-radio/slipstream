/**
 * Where the forwarder finds the daemon's control socket.
 *
 * The forwarder is a control client, not the daemon: it never creates the
 * store, it only needs to know which store the shared daemon owns so it can
 * connect to `<store>/control.sock`. That store defaults to `~/.slipstream`
 * (matching the CLI) and may be overridden with an explicit `--store <dir>`
 * shared with the CLI, so both point at the same daemon.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const CONTROL_SOCKET_NAME = 'control.sock';

export function defaultDaemonStore(home: string = homedir()): string {
  return join(home, '.slipstream');
}

export function controlSocketPath(storeDir: string): string {
  return join(storeDir, CONTROL_SOCKET_NAME);
}

/** Resolve the store dir the forwarder should talk to from its argv: an
 * explicit `--store <dir>` (resolved to an absolute path), else the default
 * home store. Fails fast when `--store` is given without a value. */
export function resolveStoreDir(argv: string[], home: string = homedir()): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--store') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--store requires a directory argument');
      }
      return resolve(value);
    }
  }
  return defaultDaemonStore(home);
}
