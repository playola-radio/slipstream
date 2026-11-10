/**
 * The Slipstream macOS app runs this package from its own runtime folder through
 * two stable shims, `bin/slipstream` and `bin/slipstream-mcp`, which set
 * SLIPSTREAM_APP_RUNTIME to that folder. Only the shims set it, so it is read
 * as given. Hooks and connector configs written in the app point at the shims,
 * so an app update moves them along without rewriting any of them.
 */
import { dirname, extname, join } from 'node:path';

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
