/**
 * A small bounded admission budget shared across projection workloads.
 *
 * Clip projection and the upcoming interface projection each turn a change's
 * before/after blobs into a derived view on demand, in terminable workers. Two
 * independently-bounded pools can still JOINTLY starve capture, so both draw
 * from one budget: at most `C` computes execute at once (across all workloads),
 * at most `Q` admitted requests wait without running (queued leaders plus
 * coalesced waiters), at most `W` of those waiters may be coalesced, and every
 * admitted request has a deadline `D` measured FROM ADMISSION — queue wait
 * included (STAGE-T-PREREQS.md decision D7; rationale in ADMISSION.md).
 *
 * It is deliberately NOT a general job framework: no priorities, persistence,
 * retries, or plugins. Each workload keeps its own compute protocol, worker
 * pool, cache, and response envelope. The budget never constructs a projection
 * envelope; it returns a neutral outcome the workload maps to its own view.
 *
 * Every terminal transition runs through one idempotent `settle` that clears the
 * unit's timer, releases its reserved slots exactly once, cancels still-running
 * work, and ignores any late completion. A settled (timed-out) request is not
 * proof its worker stopped consuming CPU — real teardown is the workload pool's
 * responsibility; the budget bounds admitted running work as a proxy.
 */

export interface ComputeHandle<T> {
  promise: Promise<T>;
  /** Stop the running compute. Fire-and-forget; the budget never awaits it. */
  cancel: () => void;
}

export interface AdmitRequest<T> {
  /** Workload identity — groups per-workload concurrency and does not coalesce. */
  workload: string;
  /** Max computes this workload may run at once (clip: 1 single worker). */
  localConcurrency: number;
  /** Internal workload deadline; defaults to the shared D. Includes queue wait. */
  deadlineMs?: number;
  /** Coalescing key; identical concurrent keys share one compute. Undefined never coalesces. */
  key?: string;
  /** Cancels this request when its HTTP consumer disconnects. */
  signal?: AbortSignal;
  /** Starts the compute; called once, when a running slot is granted. */
  run: () => ComputeHandle<T>;
}

export type AdmitOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout' }
  | { kind: 'overloaded' }
  | { kind: 'closed' }
  | { kind: 'cancelled' }
  | { kind: 'error' };

export interface AdmissionConfig {
  /** Max computes executing at once, across all workloads. */
  C: number;
  /** Max admitted-but-not-running units: queued leaders plus coalesced waiters. */
  Q: number;
  /** Sub-cap on coalesced waiters within Q (W <= Q). */
  W: number;
  /** Per-request deadline in ms, measured from admission (queue wait included). */
  D: number;
}

export interface AdmissionSnapshot {
  running: number;
  queued: number;
  waiters: number;
}

export interface ProjectionAdmission {
  admit<T>(req: AdmitRequest<T>): Promise<AdmitOutcome<T>>;
  close(): Promise<void>;
  snapshot(): AdmissionSnapshot;
}

// PROVISIONAL — not approved, not measured. A starting point for the combined-load
// measurements that decide the real numbers, per D7, after the TypeScript (T5a.2)
// and Swift (T5a.4) modules exist. See ADMISSION.md. Nothing may claim these are
// approved. C=2 lets one clip and one interface compute run at once.
export const PROVISIONAL_SHARED_ADMISSION: AdmissionConfig = { C: 2, Q: 8, W: 8, D: 100 };

type UnitState = 'running' | 'queued' | 'waiting' | 'settled';

interface Unit {
  workload: string;
  localConcurrency: number;
  key?: string;
  run: () => ComputeHandle<unknown>;
  resolve: (outcome: AdmitOutcome<unknown>) => void;
  state: UnitState;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  handle: ComputeHandle<unknown> | undefined;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Flight {
  leader: Unit;
  waiters: Set<Unit>;
}

export function createProjectionAdmission(config: AdmissionConfig): ProjectionAdmission {
  const { C, Q, W, D } = config;

  let running = 0;
  const runningByWorkload = new Map<string, number>();
  const queue: Unit[] = []; // queued leaders, FIFO
  let waiters = 0;
  // Flights are keyed by (workload, key), never key alone: two workloads may reuse
  // the same coalescing key for unrelated computes, and a waiter must never receive
  // another workload's result (its declared result type differs). The composite is
  // length-prefixed so the encoding is injective even if a workload or key contains
  // the delimiter — `(a, bc)` and `(ab, c)` never collide.
  const inFlight = new Map<string, Flight>();
  const flightKey = (workload: string, key: string): string => `${workload.length}:${workload}${key}`;
  const live = new Set<Unit>();
  let closed = false;
  let pumping = false;

  const runningOf = (w: string): number => runningByWorkload.get(w) ?? 0;
  const incRunning = (w: string): void => { running++; runningByWorkload.set(w, runningOf(w) + 1); };
  const decRunning = (w: string): void => {
    running--;
    const n = runningOf(w) - 1;
    if (n <= 0) runningByWorkload.delete(w); else runningByWorkload.set(w, n);
  };
  const pending = (): number => queue.length + waiters;

  const arm = (unit: Unit): void => {
    unit.timer = setTimeout(() => settle(unit, { kind: 'timeout' }),
      Math.max(0, unit.deadlineAt - Date.now()));
    unit.timer.unref(); // a pending deadline must never hold the process open
  };

  const releaseFlight = (leader: Unit, outcome: AdmitOutcome<unknown>): void => {
    if (leader.key === undefined) return;
    const fk = flightKey(leader.workload, leader.key);
    const flight = inFlight.get(fk);
    if (!flight || flight.leader !== leader) return;
    inFlight.delete(fk);
    for (const waiter of [...flight.waiters]) settle(waiter, outcome);
  };

  const settle = (unit: Unit, outcome: AdmitOutcome<unknown>): void => {
    if (unit.state === 'settled') return;
    const prev = unit.state;
    unit.state = 'settled';
    if (unit.timer !== undefined) clearTimeout(unit.timer);
    if (unit.signal && unit.onAbort) unit.signal.removeEventListener('abort', unit.onAbort);
    live.delete(unit);

    if (prev === 'running') {
      decRunning(unit.workload);
      // Cancel only when forcibly ending unfinished work; ok/error already settled.
      // Fire-and-forget: a throwing cancel must not skip flight release or resolution.
      if (unit.handle && (outcome.kind === 'timeout' || outcome.kind === 'closed' || outcome.kind === 'cancelled')) {
        try { unit.handle.cancel(); } catch { /* ignore: teardown is the pool's job */ }
      }
      releaseFlight(unit, outcome);
    } else if (prev === 'queued') {
      const i = queue.indexOf(unit);
      if (i >= 0) queue.splice(i, 1);
      releaseFlight(unit, outcome);
    } else if (prev === 'waiting') {
      waiters--;
      if (unit.key !== undefined) inFlight.get(flightKey(unit.workload, unit.key))?.waiters.delete(unit);
    }

    unit.resolve(outcome);
    pump();
  };

  const startCompute = (unit: Unit): void => {
    let handle: ComputeHandle<unknown>;
    try {
      handle = unit.run();
    } catch {
      if (unit.state === 'settled') return; // reentrant settle already resolved it
      // A synchronous throw after the deadline is a timeout, mirroring the async path.
      if (Date.now() >= unit.deadlineAt) { settle(unit, { kind: 'timeout' }); return; }
      settle(unit, { kind: 'error' });
      return;
    }
    // run() may have settled this unit reentrantly (e.g. it closed the budget). The
    // handle it returned is then untracked, so cancel it and stop — never install it.
    // Absorb any late settlement of its promise so it cannot become an unhandled
    // rejection now that no handler is attached.
    if (unit.state === 'settled') {
      try { handle.cancel(); } catch { /* ignore: teardown is the pool's job */ }
      handle.promise.catch(() => {});
      return;
    }
    unit.handle = handle;
    handle.promise.then(
      (value) => {
        if (unit.state === 'settled') return; // late completion ignored
        // A finished result is never discarded for lateness: the deadline bounds
        // WAITING (its timer already fired 'timeout' if it elapsed), not completed
        // work. Returning a slow-but-real projection beats throwing it away.
        settle(unit, { kind: 'ok', value });
      },
      () => {
        if (unit.state === 'settled') return;
        // A rejection after the deadline is a timeout, not a worker error.
        if (Date.now() >= unit.deadlineAt) { settle(unit, { kind: 'timeout' }); return; }
        settle(unit, { kind: 'error' });
      },
    );
  };

  const pump = (): void => {
    if (pumping || closed) return; // shutdown never dispatches queued computes
    pumping = true;
    try {
      while (running < C && !closed) {
        // Oldest runnable queued leader: FIFO, but skip one whose workload cap is full
        // so a queued clip behind a busy clip worker cannot block another workload.
        let idx = -1;
        for (let i = 0; i < queue.length; i++) {
          if (runningOf(queue[i]!.workload) < queue[i]!.localConcurrency) { idx = i; break; }
        }
        if (idx < 0) break;
        const unit = queue[idx]!;
        if (Date.now() >= unit.deadlineAt) { settle(unit, { kind: 'timeout' }); continue; }
        queue.splice(idx, 1);
        unit.state = 'running';
        incRunning(unit.workload);
        startCompute(unit);
      }
    } finally {
      pumping = false;
    }
  };

  const admit = <T>(req: AdmitRequest<T>): Promise<AdmitOutcome<T>> => {
    if (closed) return Promise.resolve({ kind: 'closed' });
    if (req.signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise<AdmitOutcome<T>>((resolve) => {
      const unit: Unit = {
        workload: req.workload,
        localConcurrency: req.localConcurrency,
        key: req.key,
        run: req.run as () => ComputeHandle<unknown>,
        resolve: resolve as (outcome: AdmitOutcome<unknown>) => void,
        state: 'queued',
        deadlineAt: Date.now() + (req.deadlineMs ?? D),
        timer: undefined,
        handle: undefined,
        signal: req.signal,
      };
      unit.onAbort = () => settle(unit, { kind: 'cancelled' });

      const fk = req.key !== undefined ? flightKey(req.workload, req.key) : undefined;

      // Coalesce onto an existing flight (a running or queued leader for this key).
      // Lookup, reservation, and attachment are synchronous — no intervening await.
      if (fk !== undefined) {
        const flight = inFlight.get(fk);
        if (flight) {
          if (pending() >= Q || waiters >= W) { resolve({ kind: 'overloaded' }); return; }
          waiters++;
          unit.state = 'waiting';
          flight.waiters.add(unit);
          arm(unit);
          live.add(unit);
          req.signal?.addEventListener('abort', unit.onAbort, { once: true });
          return;
        }
      }

      // New leader: run now if there is capacity, else queue, else reject.
      if (running < C && runningOf(req.workload) < req.localConcurrency) {
        unit.state = 'running';
        incRunning(req.workload);
        if (fk !== undefined) inFlight.set(fk, { leader: unit, waiters: new Set() });
        arm(unit);
        live.add(unit);
        req.signal?.addEventListener('abort', unit.onAbort, { once: true });
        startCompute(unit);
        return;
      }
      if (pending() < Q) {
        unit.state = 'queued';
        queue.push(unit);
        if (fk !== undefined) inFlight.set(fk, { leader: unit, waiters: new Set() });
        arm(unit);
        live.add(unit);
        req.signal?.addEventListener('abort', unit.onAbort, { once: true });
        return;
      }
      resolve({ kind: 'overloaded' });
    });
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Settle every live unit exactly once; each settle clears its timer and slot.
    for (const unit of [...live]) settle(unit, { kind: 'closed' });
  };

  const snapshot = (): AdmissionSnapshot => ({ running, queued: queue.length, waiters });

  return { admit, close, snapshot };
}
