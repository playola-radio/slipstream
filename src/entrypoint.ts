import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when this module is the process entrypoint (run directly), false when it
 * is merely imported. Node's ESM loader resolves symlinks for `import.meta.url`,
 * but `process.argv[1]` keeps the path exactly as invoked — so a symlinked or
 * `npm link`-ed launcher must be realpath'd before comparing, or the guard
 * wrongly decides "imported" and the program silently does nothing.
 */
export function isMainModule(moduleUrl: string, argvPath: string): boolean {
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}
