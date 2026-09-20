/**
 * The public configuration surface (Fork 4): a JSON daemon config file plus CLI
 * overrides, resolved into the effective enrichment policy and transcript
 * discovery settings. Precedence is CLI > file > built-in defaults, applied
 * field by field so an override never wipes a sibling.
 *
 * Configuration is enrichment-only: a bad or missing config warns and falls back
 * to defaults, never throws — enrichment must never block capture (CLAUDE.md).
 */
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_ENRICHMENT_POLICY } from './attribution-producer.ts';
import type { EnrichmentPolicy, HarnessName, SourceCoverage } from './event.ts';

const HARNESSES: readonly HarnessName[] = ['claude-code', 'codex'];
const COVERAGE_VALUES: readonly SourceCoverage[] = ['unconfigured', 'configured'];

/** Max transcripts a bounded Codex scan reads before disclosing discovery-limited. */
export const DEFAULT_CODEX_SCAN_LIMIT = 2000;

export interface TranscriptConfig {
  /** Absolute transcript home per harness (Claude reads `<home>/projects/<slug>`;
   * Codex scans `<home>/sessions`). */
  homes: Record<HarnessName, string>;
  codexScanLimit: number;
}

export interface ResolvedConfig {
  policy: EnrichmentPolicy;
  transcript: TranscriptConfig;
}

/** A partial override layer (from the file or the CLI); every field is optional. */
export interface ConfigOverrides {
  windowMs?: number;
  graceMs?: number;
  sources?: Partial<Record<HarnessName, SourceCoverage>>;
  homes?: Partial<Record<HarnessName, string>>;
  codexScanLimit?: number;
}

export function defaultConfig(homeDir: string): ResolvedConfig {
  return {
    policy: {
      window_ms: DEFAULT_ENRICHMENT_POLICY.window_ms,
      grace_ms: DEFAULT_ENRICHMENT_POLICY.grace_ms,
      sources: { ...DEFAULT_ENRICHMENT_POLICY.sources },
    },
    transcript: {
      homes: {
        'claude-code': resolve(homeDir, '.claude'),
        codex: resolve(homeDir, '.codex'),
      },
      codexScanLimit: DEFAULT_CODEX_SCAN_LIMIT,
    },
  };
}

function isHarness(v: string): v is HarnessName {
  return (HARNESSES as readonly string[]).includes(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Parse a JSON config file into an override layer. Never throws: malformed JSON
 * or bad fields produce warnings and are skipped, so capture is never blocked. */
export function parseConfigFile(raw: string): { overrides: ConfigOverrides; warnings: string[] } {
  const warnings: string[] = [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { overrides: {}, warnings: ['config: file is not valid JSON; using defaults'] };
  }
  if (typeof obj !== 'object' || obj === null) {
    return { overrides: {}, warnings: ['config: top level is not an object; using defaults'] };
  }
  const root = obj as Record<string, unknown>;
  const overrides: ConfigOverrides = {};

  const enrichment = root.enrichment;
  if (typeof enrichment === 'object' && enrichment !== null) {
    const e = enrichment as Record<string, unknown>;
    if ('window_ms' in e) {
      const n = positiveInt(e.window_ms);
      if (n === undefined) warnings.push('config: enrichment.window_ms must be a positive integer; ignored');
      else overrides.windowMs = n;
    }
    if ('grace_ms' in e) {
      const n = positiveInt(e.grace_ms);
      if (n === undefined) warnings.push('config: enrichment.grace_ms must be a positive integer; ignored');
      else overrides.graceMs = n;
    }
    if (typeof e.sources === 'object' && e.sources !== null) {
      const sources: Partial<Record<HarnessName, SourceCoverage>> = {};
      for (const [k, v] of Object.entries(e.sources as Record<string, unknown>)) {
        if (!isHarness(k)) warnings.push(`config: unknown harness "${k}" in enrichment.sources; ignored`);
        else if (typeof v !== 'string' || !(COVERAGE_VALUES as readonly string[]).includes(v)) {
          warnings.push(`config: enrichment.sources.${k} must be one of ${COVERAGE_VALUES.join('/')}; ignored`);
        } else sources[k] = v as SourceCoverage;
      }
      if (Object.keys(sources).length > 0) overrides.sources = sources;
    }
  }

  const transcripts = root.transcripts;
  if (typeof transcripts === 'object' && transcripts !== null) {
    const t = transcripts as Record<string, unknown>;
    if (typeof t.homes === 'object' && t.homes !== null) {
      const homes: Partial<Record<HarnessName, string>> = {};
      for (const [k, v] of Object.entries(t.homes as Record<string, unknown>)) {
        if (!isHarness(k)) warnings.push(`config: unknown harness "${k}" in transcripts.homes; ignored`);
        else if (typeof v !== 'string' || v.length === 0) warnings.push(`config: transcripts.homes.${k} must be a path; ignored`);
        else homes[k] = v;
      }
      if (Object.keys(homes).length > 0) overrides.homes = homes;
    }
    if ('codex_scan_limit' in t) {
      const n = positiveInt(t.codex_scan_limit);
      if (n === undefined) warnings.push('config: transcripts.codex_scan_limit must be a positive integer; ignored');
      else overrides.codexScanLimit = n;
    }
  }

  return { overrides, warnings };
}

function applyLayer(base: ResolvedConfig, o: ConfigOverrides, homeDir: string): ResolvedConfig {
  const homes = { ...base.transcript.homes };
  if (o.homes) {
    for (const h of HARNESSES) {
      const v = o.homes[h];
      if (v !== undefined) homes[h] = isAbsolute(v) ? v : resolve(homeDir, v);
    }
  }
  return {
    policy: {
      window_ms: o.windowMs ?? base.policy.window_ms,
      grace_ms: o.graceMs ?? base.policy.grace_ms,
      sources: { ...base.policy.sources, ...(o.sources ?? {}) },
    },
    transcript: {
      homes,
      codexScanLimit: o.codexScanLimit ?? base.transcript.codexScanLimit,
    },
  };
}

/** Layer file then CLI overrides onto the defaults; CLI wins field by field. */
export function resolveConfig(
  file: ConfigOverrides,
  cli: ConfigOverrides,
  homeDir: string,
): ResolvedConfig {
  const withFile = applyLayer(defaultConfig(homeDir), file, homeDir);
  return applyLayer(withFile, cli, homeDir);
}

export interface ConfigIO {
  /** File contents, or undefined if the file does not exist. */
  readFile(path: string): Promise<string | undefined>;
}

export interface LoadConfigOptions {
  path?: string;
  io: ConfigIO;
  cli?: ConfigOverrides;
  homeDir: string;
}

export async function loadConfig(
  opts: LoadConfigOptions,
): Promise<{ config: ResolvedConfig; warnings: string[] }> {
  const warnings: string[] = [];
  let fileOverrides: ConfigOverrides = {};
  if (opts.path !== undefined) {
    const raw = await opts.io.readFile(opts.path);
    if (raw === undefined) {
      warnings.push(`config: file not found at ${opts.path}; using defaults`);
    } else {
      const parsed = parseConfigFile(raw);
      fileOverrides = parsed.overrides;
      warnings.push(...parsed.warnings);
    }
  }
  const config = resolveConfig(fileOverrides, opts.cli ?? {}, opts.homeDir);
  return { config, warnings };
}
