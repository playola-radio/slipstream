import { collectAllowlistedEnv, discoverEnvKeys, homeRelativize, type EnvField } from './redact.ts';

export interface InitializeCapture {
  present: boolean;
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilityKeys?: string[];
}

export interface ToolCallCapture {
  present: boolean;
  toolName?: string;
  meta?: unknown;
  hasArguments?: boolean;
}

export interface Observation {
  schema: 'identity-probe-observation.v1';
  captured_at_ms: number;
  phase: 'startup' | 'tool_call';
  env: Record<string, EnvField>;
  discovered_env_keys: string[];
  process: { cwd: string; argv: string[] };
  initialize: InitializeCapture;
  tool_call?: ToolCallCapture;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Extract only the identity-bearing shape of an MCP initialize params object. */
export function captureInitialize(params: unknown): InitializeCapture {
  if (!isObject(params)) return { present: false };
  const cap: InitializeCapture = { present: true };
  if (typeof params.protocolVersion === 'string') cap.protocolVersion = params.protocolVersion;
  if (isObject(params.clientInfo)) {
    const ci = params.clientInfo;
    cap.clientInfo = {
      name: typeof ci.name === 'string' ? ci.name : undefined,
      version: typeof ci.version === 'string' ? ci.version : undefined,
    };
  }
  if (isObject(params.capabilities)) cap.capabilityKeys = Object.keys(params.capabilities).sort();
  return cap;
}

export interface ObservationInput {
  phase: 'startup' | 'tool_call';
  env: Record<string, string | undefined>;
  argv: string[];
  cwd: string;
  home: string;
  nowMs: number;
  initialize: InitializeCapture;
  toolCall?: ToolCallCapture;
}

export function buildObservation(input: ObservationInput): Observation {
  const obs: Observation = {
    schema: 'identity-probe-observation.v1',
    captured_at_ms: input.nowMs,
    phase: input.phase,
    env: collectAllowlistedEnv(input.env, input.home),
    discovered_env_keys: discoverEnvKeys(input.env),
    process: {
      cwd: homeRelativize(input.cwd, input.home),
      argv: input.argv.map((a) => homeRelativize(a, input.home)),
    },
    initialize: input.initialize,
  };
  if (input.phase === 'tool_call' && input.toolCall) obs.tool_call = input.toolCall;
  return obs;
}
