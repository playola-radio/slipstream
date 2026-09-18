/** Env keys whose VALUES are identity evidence and safe to record. */
export const ALLOWLISTED_ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'SLIPSTREAM_HOME',
] as const;

/** Prefixes for name-only discovery of unanticipated identity carriers. */
export const DISCOVERY_PREFIXES = ['CLAUDE', 'CODEX', 'MCP', 'SLIPSTREAM', 'CONDUCTOR'] as const;

export type EnvField = { present: true; value: string } | { present: false };

/** Rewrite an absolute path under `home` to start with `~`. Non-matching paths pass through. */
export function homeRelativize(value: string, home: string): string {
  if (value === home) return '~';
  if (home.length > 0 && value.startsWith(home + '/')) return '~' + value.slice(home.length);
  return value;
}

/** Values are home-relativized for the path-bearing keys; identifiers pass through unchanged. */
const PATH_VALUED_KEYS = new Set(['CLAUDE_PROJECT_DIR', 'SLIPSTREAM_HOME']);

export function collectAllowlistedEnv(
  env: Record<string, string | undefined>,
  home: string,
): Record<string, EnvField> {
  const out: Record<string, EnvField> = {};
  for (const key of ALLOWLISTED_ENV_KEYS) {
    const raw = env[key];
    if (raw === undefined) { out[key] = { present: false }; continue; }
    out[key] = { present: true, value: PATH_VALUED_KEYS.has(key) ? homeRelativize(raw, home) : raw };
  }
  return out;
}

const ALLOWLISTED_SET = new Set<string>(ALLOWLISTED_ENV_KEYS);

export function discoverEnvKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => !ALLOWLISTED_SET.has(k))
    .filter((k) => DISCOVERY_PREFIXES.some((p) => k.startsWith(p)))
    .sort();
}
