/** FD2 parent API. Grammar loading/parsing stays in the liftoff-only child. */
import { runSwiftParseChild, SwiftChildError } from './swift-parse.ts';
import { SWIFT_V1, type SwiftLimits, type SwiftSide } from './swift-interface-extract.ts';
import { emitProjectionTrace, type ProjectionTraceObserver } from './projection-trace.ts';

export { SWIFT_V1 };
export type { SwiftLimits, SwiftSide };

export class SwiftExtractCancelled extends Error {}
export class SwiftExtractTimeout extends Error {}

/** Batch sides into one isolated child invocation. Callers may pass absent sides as no entry. */
export async function extractSwiftSides(
  sides: { id: string; bytes: Uint8Array }[],
  options: { signal?: AbortSignal; deadlineMs?: number; limits?: SwiftLimits;
    trace?: ProjectionTraceObserver; traceUnitId?: number } = {},
): Promise<Map<string, SwiftSide>> {
  if (options.signal?.aborted) throw new SwiftExtractCancelled('Swift extraction aborted before start');
  const ids = new Set<string>();
  const decoded: { id: string; source: string }[] = [];
  const failures = new Map<string, SwiftSide>();
  for (const { id, bytes } of sides) {
    if (ids.has(id)) throw new Error(`duplicate Swift side id: ${id}`);
    ids.add(id);
    if (options.limits?.inputBytes !== undefined && bytes.byteLength > options.limits.inputBytes) {
      failures.set(id, { status: 'tooLarge', limit: 'inputBytes' });
      continue;
    }
    try {
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      decoded.push({ id, source });
    }
    catch { failures.set(id, { status: 'incomplete', reason: 'parse-error' }); }
  }
  if (!decoded.length) return failures;
  if (options.trace && options.traceUnitId !== undefined) emitProjectionTrace(options.trace,
    { kind: 'parser-request', unitId: options.traceUnitId, atNs: process.hrtime.bigint() });
  try {
    const result = await runSwiftParseChild({ op: 'extract', sides: decoded, limits: options.limits,
      ...(options.trace ? { traceTimings: true } : {}) },
      { signal: options.signal, deadlineMs: options.deadlineMs, trace: options.trace, traceUnitId: options.traceUnitId });
    if (result.op !== 'extract') throw new Error('Swift child returned unexpected operation');
    if (options.trace && result.traceTimings
      && Number.isSafeInteger(result.traceTimings.grammarLoadNs) && result.traceTimings.grammarLoadNs >= 0
      && Number.isSafeInteger(result.traceTimings.parseCompareNs) && result.traceTimings.parseCompareNs >= 0) {
      const atNs = process.hrtime.bigint();
      emitProjectionTrace(options.trace, { kind: 'phase', scope: 'swift', phase: 'grammar-load', atNs,
        durationNs: BigInt(result.traceTimings.grammarLoadNs), unitId: options.traceUnitId });
      emitProjectionTrace(options.trace, { kind: 'phase', scope: 'swift', phase: 'parse-compare', atNs,
        durationNs: BigInt(result.traceTimings.parseCompareNs), unitId: options.traceUnitId });
    }
    for (const { id, side } of result.results) failures.set(id, side);
    return failures;
  } catch (error) {
    if (error instanceof SwiftChildError && /aborted/.test(error.message)) throw new SwiftExtractCancelled(error.message);
    if (error instanceof SwiftChildError && /deadline/.test(error.message)) throw new SwiftExtractTimeout(error.message);
    throw error;
  }
}
