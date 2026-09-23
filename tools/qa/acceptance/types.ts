/**
 * The contract every acceptance module implements. The runner owns lifecycle
 * (starting/attaching the daemon, deadlines, printing); a module only asserts.
 */
import type { ReaderClient, Assertion } from '../../qa-support.ts';

export interface AcceptanceContext {
  /** The attached sandbox worktree — write real files here to drive capture. */
  worktree: string;
  /** The attached session's id (capture scope, never authorship). */
  sessionId: string;
  reader: ReaderClient;
  /** Aborted when the runner is interrupted; abort long HTTP followers on it. */
  signal: AbortSignal;
}

export interface AcceptanceModule {
  id: string;
  /** Optional seed scenario the runner writes before `run` (most modules write
   * their own files and omit this). */
  scenario?: string;
  /** Restrict the module to a platform (T-QA needs macOS FSEvents). A mismatch is
   * a not-run, never a pass. */
  requiresPlatform?: NodeJS.Platform;
  /** Assert every claim; throw on any failure. Returns the evidence per claim. */
  run(ctx: AcceptanceContext): Promise<{ assertions: Assertion[] }>;
}
