/**
 * Seed scenarios: named sequences of REAL filesystem states written into the
 * sandbox worktree so a started QA daemon has genuine, durably-observed capture
 * for an operator to curl. Scenarios write real files only — never synthetic log
 * records — and await each state's exact public observation before the next, so
 * "ready" means the daemon truly captured and durably published every state.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { awaitObservedChange, type ReaderClient } from '../qa-support.ts';

export interface SeedContext {
  worktree: string;
  sessionId: string;
  reader: ReaderClient;
  signal: AbortSignal;
  /** Await states appearing AFTER this seq (the session's baseline high-water). */
  after: bigint;
  deadlineMs?: number;
}

export interface SeedScenario {
  name: string;
  /** Write the scenario's states, awaiting each durably; return the seq of the
   * last observed state (the new ready-through high-water). */
  seed(ctx: SeedContext): Promise<bigint>;
}

function pollOpts(ctx: SeedContext): { deadlineMs?: number } {
  return ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {};
}

/** The T-QA seed: create then modify one file, so the operator sees two distinct
 * content states with real hashes. Deletion is exercised by the T-QA acceptance
 * module, not seeded here (a present file is more useful to curl). */
const tqa: SeedScenario = {
  name: 'T-QA',
  async seed(ctx) {
    const rel = 'hello.txt';
    const abs = join(ctx.worktree, rel);

    const v1 = Buffer.from('hello from slipstream qa\n', 'utf8');
    await writeFile(abs, v1);
    const created = await awaitObservedChange(
      ctx.reader, ctx.sessionId,
      { relPath: rel, before: { kind: 'absent' }, after: { kind: 'content', bytes: v1 } },
      ctx.after, pollOpts(ctx),
    );

    const v2 = Buffer.from('hello from slipstream qa — edited\n', 'utf8');
    await writeFile(abs, v2);
    const modified = await awaitObservedChange(
      ctx.reader, ctx.sessionId,
      { relPath: rel, before: { kind: 'content', bytes: v1 }, after: { kind: 'content', bytes: v2 } },
      created.seq, pollOpts(ctx),
    );

    return modified.seq;
  },
};

const REGISTRY: ReadonlyMap<string, SeedScenario> = new Map([[tqa.name, tqa]]);

export function getScenario(name: string): SeedScenario | undefined {
  return REGISTRY.get(name);
}

export function scenarioNames(): string[] {
  return [...REGISTRY.keys()];
}
