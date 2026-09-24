# Shared projection admission budget (T5b.1)

Clip projection and the upcoming interface projection (T5b.2) both turn a change's
before/after blobs into a derived view on demand, in terminable workers. Two
independently-bounded pools can still **jointly** starve capture, so both draw from
one small shared admission budget (spec `STAGE-T-PREREQS.md` Part 3.4, decision D7).

This file records the Architect-phase decisions (a Codex `gpt-6-astra` consult against
the spec + the existing clip service) and the measurement method that must run before
the numbers are approved. **The numbers here are PROVISIONAL.** Brian approves them
later, from measurements taken after the TypeScript (T5a.2) and Swift (T5a.4) language
modules exist (D7, D11). Nothing in this repo may claim they are approved or measured.

## What the budget is (and is not)

The budget owns four bounds, shared across every workload:

| Bound | Meaning |
|---|---|
| `C` | Max computes **executing** at once, across all workloads. |
| `Q` | Max admitted-but-not-running units: queued leaders **plus** coalesced waiters. |
| `W` | Sub-cap on how many of the `Q` units may be coalesced waiters (`W <= Q`). |
| `D` | Per-request deadline, measured **from admission** — queue wait included. |

It admits a unit to one of: **running**, **queued**, or **rejected (`overloaded`)**.
A unit whose `D` elapses while queued or running settles **`timeout`** (running work is
cancelled through the workload's own cancel handle). `close()` settles every pending
unit explicitly, leaves no live timer (all `unref`'d) and no held slot.

It is **not** a general job framework: no priorities, persistence, retries, or plugin
registry. Each workload keeps its own compute protocol, worker pool, cache, and
response envelope. The budget never constructs a projection envelope — it returns a
neutral outcome (`ok` / `timeout` / `overloaded` / `closed` / `error`) that the
workload maps to its own disposition.

## Consult outcomes (the five open points)

1. **What `C` counts, and how a shared `C` composes.** `C` counts computes actually
   **executing**. A running slot is acquired from the budget **before** the workload
   dispatches to its worker, so the cross-workload cap is authoritative. The budget also
   enforces a **per-workload** running cap (`localConcurrency`): clip passes `1` because
   its pool "runs exactly one clip worker" and returns `worker-error` if called while
   busy — deleting that guard under a shared `C > 1` would break clip. So the rule is
   `totalRunning <= C` **and** `runningByWorkload[w] <= localConcurrency[w]`. A shared
   `C = 1` deliberately serializes clip and interface; that is a defensible provisional
   choice, **not** evidence capture is unaffected — only the combined-load measurement
   below can claim that.

2. **How `W` relates to `Q`.** Coalesced waiters are folded **into** the `Q` pool, with
   `W` a sub-cap (`W <= Q`), never an additive third allowance. An additive `W` would let
   clip hold `C + Q + W` outstanding — a relaxation of today's `maxPending = C + Q`
   ceiling, which is forbidden. Clip sets `W = Q = queueLimit`, so `W` is non-binding for
   clip and `(queued + waiters) <= Q` reproduces `maxPending` exactly. D7 names a
   *separate bound*, not *additional capacity*; that interpretation is deliberate.

   Classification and reservation are **atomic and synchronous** (no `await` between the
   in-flight lookup, the reservation, and publishing the flight):
   - **New, immediately runnable leader** → consume a **running** slot (not a `Q` slot).
   - **New, blocked leader** → consume a **`Q`** slot (queued).
   - **Existing flight (same key)** → consume a **`Q` and a `W`** slot, then attach.

   This corrects a naive "take a `Q` slot first" design, which would reject the very
   first request when `Q = 0` despite an idle worker.

3. **Deadline start point.** `D` starts synchronously at successful admission and is
   **never reset on dispatch** (D7 includes queue wait, and explicitly forbids clip's
   deadline-starts-in-`runTask`). The deadline is stored as an absolute instant; a late
   timer callback must not let expired work start or be accepted as success. A duplicate
   never extends the leader's deadline; a leader timeout settles its waiters too.
   Timer registration stays **synchronous** inside `admit` (the mocked 100 ms clip test
   ticks immediately after the call, with no intervening microtask).

   This keeps every clip test green. The behavior differences D7 asks for are ones the
   existing clip assertions already permit: a **queued** clip request can now expire on
   queue wait (no clip test queues a request long enough to hit 100 ms while asserting a
   non-timeout outcome — verified by inspection), and a never-resolving injected compute
   now settles during shutdown instead of dangling. **No clip test expectation is
   edited.** If applying D7 had required editing one, the rule is STOP and report; it did
   not.

4. **Fairness between workloads.** Plain **FIFO**, no per-workload quotas or priorities.
   The capture-safety requirement is bounded execution (`C`) plus deadlines; it does not
   demand that every competing workload win admission. A burst from one workload can
   monopolize admission and get another workload repeatedly `overloaded` — that is *not*
   capture starvation, and adding priorities would be exactly the job-framework
   generality the spec forbids. The one refinement `C > 1` needs: promote the
   **oldest *runnable*** queued leader (skip a leader whose workload's local cap is
   full), so a queued clip stuck behind a busy clip worker does not block an interface
   job while global capacity is free.

5. **Shutdown ordering.** The end state: the **reader** owns one shared budget and hands
   it to each service; services own their pools. (For T5b.1 the interface service does not
   exist yet, so the clip service constructs and owns a **private** budget instance with no
   injection seam — the module is already workload-agnostic and is proven multi-workload by
   its synthetic tests, so adding an unused injection parameter now would be speculative
   generality. Wiring the reader-owned shared instance into both services is T5b.2's job.)
   Closing a service must cancel only **that** service's work, never shut down other
   workloads — which is why the clip service closes its own budget today, and why a future
   shared, reader-owned budget must not be closed by any single service.

   Order on shutdown: synchronously mark the budget closed and disable dispatch, settle
   queued/waiting units (`closed`), then let the workload's own pool `close()` perform the
   real worker **termination** and await it. Do not await HTTP drain before settling
   projections. One **idempotent terminal transition** per unit owns timer cleanup and
   settlement; it records the terminal state *before* any cancel, and ignores every late
   completion (including a late cache write). The code never depends on the compute
   promise resolving after cancellation — the tests deliberately supply no-op cancel
   handles. Clip maps the budget's `closed` outcome to `skipped`/`worker-error` because
   its existing close test requires exactly that reason.

### Settlement is not termination (the most important invariant)

A settled (timed-out) request is **not** proof its worker stopped consuming CPU. Cancel
on the clip pool is `terminate()` + immediate re-spawn, fire-and-forget; a retiring
worker can briefly overlap its replacement. The budget therefore bounds *admitted
running work*, which is a proxy for CPU, not a guarantee of it. Real worker teardown is
the workload's pool responsibility (`close()` awaits it). This is precisely why the
synthetic checker and unit tests **cannot** approve the numbers or claim capture safety —
only the combined-load measurement can, because it observes capture under real teardown.

## Provisional numbers (NOT approved, NOT measured)

- **Clip's own budget** (unchanged from today): `C = 1`, `Q = 8`, `W = 8`, `D = 100 ms`.
  These reproduce the existing clip ceiling `maxPending = C + Q = 9` exactly.
- **Future shared budget** (clip + interface, used by the synthetic checker): provisional
  `C = 2`, `Q = 8`, `W = 8`, `D = 100 ms`. `C = 2` lets one clip and one interface compute
  run at once; it is a starting point for measurement, not a decision.

Both are named constants in `src/projection-admission.ts`, commented as provisional
pending D7 approval.

## Measurement method (the D7 four-arm plan)

Approval requires measuring capture impact under four arms, then reporting per-language
thresholds. Crashes and missing data are **failures**, never discarded.

| Arm | What runs | Status |
|---|---|---|
| **Baseline** | Capture only, no projection load. | Runnable now. |
| **Clip-only** | Capture + a saturating clip request burst. | Runnable now. |
| **Interface-only** | Capture + a saturating interface request burst. | **NOT YET RUNNABLE** — needs the TypeScript module (T5a.2) and Swift module (T5a.4). |
| **Combined** | Capture + clip + interface bursts together, over the shared bound. | **NOT YET RUNNABLE** — needs T5a.2 + T5a.4. |

Inputs, once the interface arms are runnable: representative **TS / TSX / Swift** sizes,
plus **malformed** and **Unicode** inputs; **cold** (first parse, grammar load) and
**warm** (cache-primed) runs. Report acceptable timeout rates and the shared `C/Q/W/D`
**per language**. Do not run or fabricate the interface arms until their modules exist.

The clip-only and baseline arms are exercised today by the live acceptance checks
(`npm run qa:check -- --pr T5b.1`, claims 1–3) and the synthetic saturation checker
(`node tools/projection-check.ts admission --saturate`, claims 4–5). Neither approves
the numbers.
