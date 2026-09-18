import type { Health } from './health.ts';

export interface BoundarySource {
  current(): bigint;
  waitForAdvance(from: bigint, signal: AbortSignal): Promise<void>;
}

export function liveBoundary(health: Health): BoundarySource {
  const current = () => BigInt(health.snapshot().durable_seq);
  return {
    current,
    waitForAdvance(from, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        let off: (() => void) | undefined;
        const onAbort = () => { cleanup(); reject(new Error('aborted')); };
        const cleanup = () => { off?.(); signal.removeEventListener('abort', onAbort); };
        const check = () => { if (current() > from) { cleanup(); resolve(); } };
        signal.addEventListener('abort', onAbort, { once: true });
        off = health.subscribe(check);
        check(); // race-free: re-check after subscribing
      });
    },
  };
}

export function staticBoundary(seq: bigint): BoundarySource {
  return {
    current: () => seq,
    waitForAdvance(_from, signal) {
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}
