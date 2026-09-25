# D1 — let local clients queue questions about code changes

Status: READY for a fresh daemon implementation workspace. Scope is durable submission only. No hook delivery or Swift UI in this PR.

## Copy-paste assignment

Implement D1 in `briankeane/slipstream`, from freshly fetched `origin/develop`. Read the repo's CLAUDE.md, AGENTS.md and IMPLEMENTATION_PLAN.md, then these handoff files:

- `/Users/brian/conductor/workspaces/slipstream-client-swift/hangzhou-v2/.context/orchestrate-feature/ask-agent/spec.md`
- `/Users/brian/conductor/workspaces/slipstream-client-swift/hangzhou-v2/.context/orchestrate-feature/ask-agent/contract.md`
- this brief.

The inspected base is `0105465fa72eefd8f2697e857c5bcabce9b3bd38`; inspect any newer develop changes before implementing. Do not rename an existing workspace branch. Brian authorized the ask/send re-scope, including additive question events; amend the old MVP exclusion precisely to document this slice and leave answer UI/reply transport deferred. Never alter watcher-primary capture, attribution honesty, existing frozen contracts, or other success criteria.

PR target is **develop, never main**. Suggested title: `feature: let local clients queue questions about code changes`. No co-author/co-sign trailers and no skipped hooks. Brian merges; do not merge your own PR. Follow the applicable cross-model planning/review pipeline and delegate PR creation/review chores as specified by your main agent's instructions. Use the anti-ping-pong guard for delegated chores.

## Deliverable

An independent local client can submit a question tied to an immutable file-change snapshot through the existing control socket, receive an honest durable acknowledgment, safely retry the same request, and read the resulting event through the existing public reader. The daemon does not send the question to an agent yet. Do not build speculative delivery infrastructure.

## Source map and responsibility

- Add `src/questions.ts` and `src/questions.test.ts`: typed submission/context/result values, normalization and limits, source extraction, and the small question projection/dedup helpers needed by D1. Keep event append ownership in CaptureSession; do not introduce another service/writer or generic queue framework.
- `src/event.ts`, `schemas/slipstream.question.queued.v1.json`, and existing event/schema tests: additive public queued-event type and schema. Use current envelope conventions, including decimal string seq and `question/<id>` subject.
- `src/session.ts` + existing session tests: expose queue submission through the existing append boundary, reserve/coalesce requests, count admission slots, inject a clock, honor ownership/readiness/draining, seed the question projection after in-process recovery.
- `src/recovery.ts` + existing recovery tests: reconstruct committed question records needed for dedup and eligibility from the valid durable prefix. Preserve the existing strict corruption/torn-tail rules. Do not add a second capture source or weaken recovery.
- `src/daemon.ts` + `src/daemon.test.ts`: add the `ask` control verb, resolve existing active attach target, verify context against the durable event and bounded CAS data, re-check session/ownership after awaits, and drain admitted work on detach/shutdown.
- `src/control-protocol.ts`: the four new domain error codes from contract.md. Existing version/envelope/framing already work; reuse them. `src/control-client.ts` honesty behavior stays intact unless a concrete defect requires a separate justified change.
- `src/cli.ts` + CLI tests: `slipstream ask --store <dir> --session <capture-id> --request-id <uuid> --input <json-file>`. The file contains `{text, context}` using contract.md fields. Read it, validate syntax, call `sendControlRequest`, and retain existing exit/retry guidance. Print the structured acknowledgment or error, never tokens or source dumps. Do not auto-generate a new ID on retry.
- `tools/qa/acceptance/F1-ask.ts`, a focused negative-control test, and `tools/qa/acceptance/registry.ts`: executable live acceptance module named `F1-ask`, included in cumulative `qa:check --all`.
- `IMPLEMENTATION_PLAN.md`, `README.md` / existing schema and testing documentation: precise re-scope, public CLI/control/event contract, and the limitation that queue acceptance is not delivery.

## Ordered implementation and verification

1. Write contract fixtures and failing normalization/source-context tests. Include canonical IDs, decimal seq beyond JavaScript's safe integer, UTF-8 byte limits, Unicode whitespace, CRLF, BOM, tabs, blank lines, final LF, invalid UTF-8/NUL, deleted/unavailable/non-change snapshots, path/hash mismatch and invalid ranges. Implement only the helpers required to make them pass.
2. Add queued-event schema/type and validation fixtures before session behavior. Assert unknown-field compatibility and ensure existing display folds don't reinterpret question records as changes.
3. Add session tests before append logic: same-key retry, same-key body conflict, concurrent duplicate coalescing, 17 concurrent distinct requests with a 16-slot bound, reservation cleanup on failure, expiry frees capacity, duplicate does not refresh TTL, and storage ownership/readiness rejection. Implement via the existing append/lifetime patterns.
4. Add recovery regressions that fail when question-index reconstruction is removed: a commit followed by ambiguous failure and in-process recovery must remain a duplicate; a torn uncommitted tail must not appear committed. Do not confuse this with full daemon restart/new capture.
5. Add daemon integration tests for selection replacement during source reads, detach/shutdown during admitted append, incorrect active capture, explicit target copying, CAS hash mismatch and bounded reading, and old-capture requests after restart/new attach. No old request may retarget a new session. Implement `ask` beside the existing guarded control verbs.
6. Add CLI tests for JSON-file input, required IDs, bad files/flags, acknowledgment shape and error exits. Preserve post-send OutcomeUnknownError semantics; verify a lost response followed by same-id retry produces exactly one queued event.
7. Add the live acceptance module using T-QA's owned disposable store and Node 24. Create a real file change, read its actual durable seq/hash, send through the CLI, verify one queued record through authenticated GET, retry, then deliberately submit wrong context and verify no new question. Prove the acceptance check fails when the required queued event is suppressed or its identity/context is corrupted.
8. Run the full required checks below. Perform the user's cross-model review gates for nontrivial product code before claiming completion/opening a PR. Present exact commit, tests and live acceptance evidence in the handoff report.

## Required checks

Run from the daemon worktree with Node 24 LTS selected (the last known path is `/Users/brian/.nvm/versions/node/v24.11.0/bin`; verify it, don't inherit Node 26 accidentally):

```sh
npm run typecheck
npm test
npm run test:tools
npm run test:os
npm run qa:check -- --all
npm run check:fold-release
```

Run any repository-required additional checks discovered in the actual branch. Full session/recovery/daemon/control suites are mandatory because they cover changed shared behavior; a few new tests alone are insufficient. Keep source blobs, event logs, reply artifacts and daemon tokens out of commits. Use only T-QA disposable stores; never point anything at the real ~/.slipstream or Brian's monitoring store/app.

## Completion report

Report PR URL/base, final SHA, exact test results, live `F1-ask` evidence, negative-control result, protocol examples, cleanup, and any consciously deferred items. Do not say messaging delivery works from this PR: that belongs to D2 + P0. The orchestrator independently reruns cumulative QA after Brian merges before handing off the next dependent PR.

Pay extra attention in review to source-snapshot identity, detach/ownership races, concurrent admission bounds, and in-process recovery after an ambiguous commit. These are the parts where a plausible green mocked test can hide a real contract failure.
