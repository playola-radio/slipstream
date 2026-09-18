/**
 * In-process capture health. Stage 2a keeps this an in-memory object (Q6); a
 * later stage may surface it over the reader API. It exists so that when the
 * store fails (ENOSPC/quota/IO), capture can stop *acknowledging* writes and
 * report `failing` honestly, rather than silently dropping observed states.
 */
export type HealthState = 'starting' | 'healthy' | 'failing' | 'recovering';

export interface HealthFailure {
  code: string | undefined;
  operation: string;
  detected_at_ms: number;
}

export interface HealthSnapshot {
  state: HealthState;
  /** Highest durably-committed seq, as a decimal string. */
  durable_seq: string;
  failure?: HealthFailure;
  /** True once an outage has begun and a disclosing gap has not yet been recorded. */
  gap_pending: boolean;
}

export interface Health {
  snapshot(): HealthSnapshot;
  setDurableSeq(seq: bigint): void;
  markHealthy(): void;
  /** Enter the failing state, recording the storage failure that triggered it. */
  markFailing(failure: HealthFailure): void;
  markRecovering(): void;
  /**
   * Register a listener called synchronously, after the value is set, on
   * every `setDurableSeq`. Returns an unsubscribe function. Listeners must
   * be cheap; they must not perform I/O or await inside the callback. A listener
   * that throws is isolated (reported, not propagated) so it cannot corrupt the
   * caller mid-append.
   */
  subscribe(listener: () => void): () => void;
}

export function createHealth(durableSeq: bigint = 0n): Health {
  let state: HealthState = 'starting';
  let seq = durableSeq;
  let failure: HealthFailure | undefined;
  let gapPending = false;
  const listeners = new Set<() => void>();

  return {
    snapshot: () => ({
      state,
      durable_seq: seq.toString(),
      ...(failure ? { failure } : {}),
      gap_pending: gapPending,
    }),
    setDurableSeq: (next) => {
      seq = next;
      // A listener that throws (violating its contract) must not corrupt the
      // caller that just advanced the durable seq — e.g. break the append path
      // between a durable commit and the bookkeeping that follows it. Report and
      // keep notifying the rest.
      for (const l of listeners) {
        try {
          l();
        } catch (err) {
          // Reporting must itself be crash-proof: String(err) can re-enter user
          // code (a custom toString / Symbol.toPrimitive) that throws again, and
          // that second exception would escape into the caller — re-opening the
          // exact post-commit hole this catch exists to close.
          let detail: string;
          try {
            detail = String(err);
          } catch {
            detail = '<unstringifiable listener error>';
          }
          console.error(`slipstream: health listener threw: ${detail}`);
        }
      }
    },
    markHealthy: () => {
      state = 'healthy';
      failure = undefined;
      gapPending = false;
    },
    markFailing: (next) => {
      // Keep the first failure of an outage: it marks when acknowledgment
      // stopped. A failed recovery attempt re-enters `failing` from
      // `recovering`; preserve that original failure rather than overwriting it.
      if (state !== 'failing') {
        state = 'failing';
        failure ??= next;
        gapPending = true;
      }
    },
    markRecovering: () => {
      state = 'recovering';
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
