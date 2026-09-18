# Stage 3 — P4: MCP forwarder + harness adapters + skill + config

Fresh workspace, branch off `develop`. Architecture is **locked** (Codex consult
01a0b5e5 + confirmed follow-up); this file tracks implementation only. Do not
re-architect. TDD throughout — test first, minimal implementation, small commits
that compile+pass.

## What P4 delivers (SC/tests it closes)
Accept declarations from Claude Code + Codex: a thin MCP stdio forwarder with two
context adapters, exactly one tool `slipstream_begin_task`, the portable skill,
and user-level config. Closes most of Stage 3's SC/tests with real sessions.

## STEP 0 is DONE — do NOT re-run the identity probe
SC3 is SATISFIED across the full 8×2 matrix (16/16), including two-sessions/one-
worktree and config-inheritance. `tools/identity-probe/FINDINGS.md` may still read
"INCOMPLETE" until docs PR #13 merges — stale text, NOT a signal to re-probe. Its
evidence + adapter rules are authoritative.

## Locked design (do not deviate)
- **Hand-rolled MCP stdio transport**, not the SDK. Promote an adapted copy of
  `tools/identity-probe/mcp.ts` to `src/mcp-protocol.ts` (structured tool results;
  `src/` sibling, not a shared import).
- **Forwarder NEVER calls attach/detach.** Control client that only emits
  `begin_task` (and optional `status` diagnostics). CLI owns attachment. No back
  channel — control writes/reports only, never reads the feed.
- **Exactly ONE tool: `slipstream_begin_task(title)`** → `{session_id, task_id,
  event_id, seq}`, returned only AFTER the daemon acks the commit. Forwarder mints
  a fresh request UUID per call for idempotency.
- **Selection lives daemon-side (decision X).** Forwarder sends the verified
  identity triple; the daemon compares atomically against the active session.
  `begin_task` envelope:
  `{ v:1, verb:'begin_task', title, request_id, session_id?, harness, harness_session_id, worktree }`.
  Keep BOTH guards: optional `session_id` = precise stale-target guard; the triple
  makes `SESSION_NOT_SELECTED` mean "this caller is not selected." Daemon
  canonicalizes incoming `worktree` with the SAME `realpath` policy as `attach`
  (`startAndActivate`) before comparing to `current.worktree`.
- **Retry semantics.**
  (a) On `OutcomeUnknownError`, auto-resend the SAME `begin_task` exactly ONCE —
      byte-identical payload (same triple, title, request_id, session_id guard).
      Safe because `session.beginTask` idempotency is durable/log-anchored
      (`committedTasks` rebuilt by `seedTaskState`). ONLY `begin_task` with a
      nonempty `request_id` and identical payload qualifies.
  (b) DEFER the client-side durable journal.
  (c) REFUSE inferring a later same-title call is a retry of an earlier one.
- **Error mapping.** Domain failures (`DAEMON_UNAVAILABLE`, `SESSION_NOT_SELECTED`,
  `IDENTITY_UNRESOLVED`, `CAPTURE_NOT_READY`, `INVALID_TITLE`, `STORAGE_UNAVAILABLE`)
  → `isError:true` MCP tool result. Transport/JSON-RPC faults → JSON-RPC error.
  Forwarder-level `OUTCOME_UNKNOWN` (resend also ambiguous) → `isError:true` result
  carrying the `request_id`; the agent must NOT re-declare.
  - Resend precedence: a FINAL domain error on the resend replaces the earlier
    unknown; a second `OutcomeUnknownError` → `OUTCOME_UNKNOWN`.
  - Honesty text: `SESSION_NOT_SELECTED` seen while resolving an earlier unknown →
    "selection unavailable; prior commit status unknown for request_id X" — NEVER
    "not committed."
- **Adapters interface:** `initialize(clientInfo, env)` (eager Claude capture) +
  `identityForCall(toolCallParams) -> {harness, harness_session_id, worktree} | {unresolved: reason}`.
  Dispatch by `clientInfo.name`. Claude: cache env triple at initialize, realpath
  worktree. Codex: initialize captures nothing; `identityForCall` requires `_meta`
  present + `threadId` present + `workspaces` with EXACTLY one key, else FAIL CLOSED
  (`IDENTITY_UNRESOLVED`). Dropped Codex transport terminal for the binding.
- **Identity mechanics stay OUT of `SKILL.md`** (portable core). Per-harness
  enrichment optional.
- **Daemon location:** explicit `--store` path shared with the CLI resolves socket.

## TDD stages (do retry-ambiguity early per Codex)
- **A. `src/mcp-protocol.ts`** — JSON-RPC-over-stdio dispatch. **Status: Complete**
- **B. `src/harness-context.ts` + `harness-context/{claude,codex}.ts`** — fail-closed
  identity matrix. **Status: Complete**
- **C. `src/task-forwarder.ts`** — begin_task orchestration + retry. **Status: Complete**
- **D. `src/daemon.ts` + `src/control-protocol.ts`** — daemon-side identity guard +
  realpath canonicalization; keep session_id guard. TOUCHED-AREA REGRESSION: run
  FULL daemon/session/control test suites. **Status: Complete**
- **E. `src/mcp-forwarder.ts` + `src/daemon-location.ts`** — wire transport+adapter+
  forwarder; `--store` socket resolution; daemon-down fast-fail; e2e vs fake daemon.
  **Status: Complete**
- **F. `SKILL.md` + user-level config docs** — portable core; documented install for
  Claude `~/.claude.json` and Codex `~/.codex/config.toml`. **Status: Not Started**
- **G. Real-session acceptance + adversarial review** — three-worktree
  SESSION_NOT_SELECTED; skill-from-config both harnesses; same-UUID commits once;
  never-declare → ungrouped; daemon-down no hang. Then Codex review + challenge +
  Excess Audit CONCURRENTLY, one combined fix wave, one re-review if non-trivial.
  **Status: Not Started**

## Gates (per CLAUDE.md)
- Branch off `develop`, never `main`. Node built-ins only; no new deps (hand-roll,
  no MCP SDK). Commit with `git -c commit.gpgsign=false`. TDD; never `--no-verify`;
  no co-sign trailers. Never commit captured data.
- Before PR: Codex adversarial review (review + challenge + Excess Audit concurrently),
  one combined fix wave.
- Delegate PR creation + `/fix-review` to `codex exec` (billing). Target `develop`;
  run `npm run typecheck && npm test && npm run test:os`; PR title `feature:` + jargon-free.
