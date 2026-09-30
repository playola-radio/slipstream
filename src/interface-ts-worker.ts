/** CPU-bound TypeScript/TSX extraction runs outside the daemon's capture loop. */
import { parentPort } from 'node:worker_threads';
import { createTypeScriptInterfaceExtractor, TypeScriptLimitError, type TypeScriptLimits } from './interface-v2-typescript.ts';
import { compareStructuredExtractions, type StructuredExtraction } from './interface-v2-comparison.ts';

export interface TypeScriptJob {
  id: number;
  language: 'typescript' | 'tsx';
  before: Uint8Array | null;
  after: Uint8Array | null;
  limits?: TypeScriptLimits;
  traceTimings?: boolean;
}
export type TypeScriptResult = {
  before: StructuredExtraction | { status: 'tooLarge' };
  after: StructuredExtraction | { status: 'tooLarge' };
  comparison: ReturnType<typeof compareStructuredExtractions> | null;
  traceTimings?: { grammarLoadNs: bigint; parseCompareNs: bigint };
};
export type TypeScriptReply = { id: number; ok: true; result: TypeScriptResult } | { id: number; ok: false };

if (!parentPort) throw new Error('interface-ts-worker must run in a worker thread');
const port = parentPort;
port.on('message', (job: TypeScriptJob) => {
  void (async () => {
    const loadStarted = job.traceTimings ? process.hrtime.bigint() : undefined;
    const extract = await createTypeScriptInterfaceExtractor(job.language);
    const parseStarted = job.traceTimings ? process.hrtime.bigint() : undefined;
    const side = (bytes: Uint8Array | null): StructuredExtraction | { status: 'tooLarge' } => {
      if (bytes === null) return { status: 'absent' };
      try { return extract(bytes, job.limits); }
      catch (error) {
        if (error instanceof TypeScriptLimitError) return { status: 'tooLarge' };
        throw error;
      }
    };
    const before = side(job.before);
    const after = side(job.after);
    const comparison = before.status === 'tooLarge' || after.status === 'tooLarge'
      ? null : compareStructuredExtractions(before, after);
    return { before, after, comparison,
      ...(loadStarted !== undefined && parseStarted !== undefined ? { traceTimings: {
        grammarLoadNs: parseStarted - loadStarted,
        parseCompareNs: process.hrtime.bigint() - parseStarted } } : {}) };
  })().then(
    result => port.postMessage({ id: job.id, ok: true, result } satisfies TypeScriptReply),
    () => port.postMessage({ id: job.id, ok: false } satisfies TypeScriptReply),
  );
});
