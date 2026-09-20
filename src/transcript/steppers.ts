import { claudeStep, initialClaudeState, type ClaudeState } from './claude.ts';
import { codexStep, initialCodexState, type CodexState } from './codex.ts';
import type { AdapterContext } from './types.ts';
import type { Stepper } from './file-reader.ts';

/** Bind the pure Claude core to one file's mutable join state. */
export function claudeStepper(ctx: AdapterContext): Stepper {
  let state: ClaudeState = initialClaudeState();
  return {
    reset: () => {
      state = initialClaudeState();
    },
    step: (record) => {
      const out = claudeStep(state, record, ctx);
      state = out.state;
      return { evidence: out.evidence, diagnostics: out.diagnostics };
    },
  };
}

/** Bind the pure Codex core to one file's mutable join state. */
export function codexStepper(ctx: AdapterContext): Stepper {
  let state: CodexState = initialCodexState();
  return {
    reset: () => {
      state = initialCodexState();
    },
    step: (record) => {
      const out = codexStep(state, record, ctx);
      state = out.state;
      return { evidence: out.evidence, diagnostics: out.diagnostics };
    },
  };
}
