# Identity-probe findings — Stage 3 PR 1 (SC3 evidence)

**Status: PARTIAL. Real-session evidence satisfies the documented procedure for
15 of the 16 matrix rows; the Claude Code config-inheritance row remains
explicitly unmeasured.**

Each measured row below is backed by at least one line in a real
`observations.jsonl` log produced by a real, operator-driven,
Conductor-launched harness session (Claude Code and Codex). Record indices
(`#N`) refer to that owner-only, gitignored log; the log itself is never
committed (see `tools/identity-probe/README.md`). The synthetic unit tests
under `tools/identity-probe/*.test.ts` are **not** evidence for this document.
An `UNMEASURED` row has no corresponding scenario-specific probe call and must
not be inferred from another row.

## Environment pinning

| Field | Value |
| --- | --- |
| Conductor version | 0.86.1 |
| Claude Code — observed `initialize.clientInfo` | `claude-code` @ `2.1.272` (MCP protocol `2025-11-25`, entrypoint `sdk-ts`) |
| Codex — observed `initialize.clientInfo` | `codex-mcp-client` @ `0.154.0` (MCP protocol `2025-06-18`, model `gpt-6-astra`) |
| Date(s) of runs | 2026-09-18 |
| Operator | Brian |

## Scenario matrix

One row per scenario per harness. "startup id" = `CLAUDE_CODE_SESSION_ID`
(Claude) observed at `initialize`; Codex exposes **no** session/thread env var
at startup, so its identity is observed only in tool-call `_meta`.

| harness | scenario | initialize.clientInfo | startup id present? | tool-call `_meta` present + shape | startup id == tool-call id? | worktree correlatable? | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | 1. Fresh launch | claude-code@2.1.272 | YES — real UUID | YES — `{claudecode/toolUseId, progressToken}`; **no** session id / worktree in `_meta` | YES, within a connection (#0 startup == #2 tool_call, `f1fb8554`) | YES — `CLAUDE_PROJECT_DIR` + `cwd` both pin `…/porto-v3` | One fresh launch made TWO connections with DISTINCT session ids (`f1fb8554`, `ea71598a`); the tool call landed on one. Identity carrier is the ENV var, not `_meta`. |
| codex | 1. Fresh launch | codex-mcp-client@0.154.0 | **NO** — `CODEX_*` env absent; clean env (no leak) | **YES — the identity carrier.** `_meta.threadId` (== `x-codex-turn-metadata.thread_id` == session_id) + `_meta.x-codex-turn-metadata.workspaces` map | N/A — no startup id exists | YES — from `_meta.workspaces` (canonical path → origin/commit). NOT from `cwd` | #6 porto `01a0b5ad`, #10 chennai `01a0b5ae`. One startup per session had `cwd=/`. |
| claude-code | 2. Explicit resume | claude-code@2.1.272 | YES | YES (same shape) | YES | YES — `…/porto-v3` | Coldest resume (Conductor archive→unarchive→resume). #35/#36 `8df2f853` PRESERVED. Never stale. |
| codex | 2. Explicit resume | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — `…/chennai-v1` | Archive→unarchive→resume. #58 threadId `01a0b5d1` PRESERVED (== #53/#57). Survives full archive cycle. |
| claude-code | 3. Implicit resume / continue | claude-code@2.1.272 | YES | YES | YES | YES — `…/porto-v3` | Close+reopen. #33/#34 `8df2f853` PRESERVED. Live session held `f1fb8554` stable ~15 min. |
| codex | 3. Implicit resume / continue | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — `…/chennai-v1` | Close+reopen. #57 threadId `01a0b5d1` PRESERVED (== #53). Reopen ≠ new conversation. |
| claude-code | 4. `/clear` / session change | claude-code@2.1.272 | YES | YES | YES (post-clear id stable across #18/#19) | YES — `…/porto-v3` | `/clear` MINTED a fresh id `f1fb8554`→`8df2f853` (fresh, not stale). Claude respawns MCP servers on `/clear`. |
| codex | 4. Session change (new conversation) | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — `…/chennai-v1` | New conversation MINTED fresh threadId `01a0b5d1` (worktree already had `01a0b5ae`). Worktree still pinned. |
| claude-code | 5. MCP reconnect, same session | claude-code@2.1.272 | YES | YES | YES — respawn `8df2f853` UNCHANGED | YES — `…/porto-v3` | Killed all probe subprocs; recalled in same post-clear session. #20 startup + #21 tool_call, id UNCHANGED (env re-injected on respawn). **Clean recovery.** |
| codex | 5. MCP reconnect, same session | codex-mcp-client@0.154.0 | NO | — (no successful call) | N/A | — | **NEGATIVE.** Killed probe mid-conversation: 1st call fired one respawn `initialize` (#59, `cwd=/`) but died before the call → "Transport closed"; 2nd call did not respawn at all. Tool stays DEAD for that conversation. Recovery needs a NEW conversation (per-conversation scope; a new conversation in the same worktree works but mints a fresh threadId). Codex does NOT restore a working in-session stdio tool. |
| claude-code | 6. Two sessions, same worktree | claude-code@2.1.272 | YES | YES | YES (each session's own id) | YES — same `CLAUDE_PROJECT_DIR` | Session1 `8df2f853`, Session2 `7b694807` (#28/#29) — DISTINCT ids, SAME worktree. Distinguishable. |
| codex | 6. Two sessions, same worktree | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — same single root `…/edinburgh-v1` | **Purpose-built run (not borrowed from other scenarios):** two distinct Codex sessions opened in ONE worktree `edinburgh-v1` — threadIds `01a0b638-b823…` (#85) and `01a0b638-cf35…` (#86). Each `_meta.workspaces` has EXACTLY ONE entry, the SAME canonical root (origin `…/slipstream.git`, commit `7fe3f38`); `session_id`==`thread_id`==`threadId` within each. Distinguishable; ZERO cross-talk. |
| claude-code | 7. Three Conductor worktrees | claude-code@2.1.272 | YES | YES | YES | YES — each pins its OWN root | porto `8df2f853`, sydney `06a475a6` (#43), newport `40340d61` (#44). `cwd`==`CLAUDE_PROJECT_DIR` each; ZERO cross-talk. (Bujumbura #63 a 4th, also clean.) |
| codex | 7. Three Conductor worktrees | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — each pins its OWN root via `workspaces` | porto `01a0b5ad` (#6), chennai `01a0b5ae` (#10), florence `01a0b5d8` (#67). Distinct threadIds, single-key `workspaces` each. ZERO cross-talk. |
| claude-code | 8. Config inheritance (session Slipstream did not launch) | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | #82/#83 show startup-only inherited-config evidence in a new Conductor workspace, but no `identity_probe_snapshot` tool call was recorded. The documented procedure requires comparing startup and tool-call records; do not count this row until that scenario-specific call is captured. |
| codex | 8. Config inheritance (session Slipstream did not launch) | codex-mcp-client@0.154.0 | NO | YES — `threadId` + `workspaces` | N/A | YES — `…/edinburgh-v1` | Same `edinburgh-v1` workspace; Codex inherited user-level `~/.codex/config.toml` and spawned the probe. #84 startup + #85/#86 tool_call; `_meta.threadId` + single-key `workspaces` (root `…/edinburgh-v1`, origin `…/slipstream.git`) present. Config picked up by a session Slipstream had no part in starting. |

### Scenario definitions

1. **Fresh launch** — brand-new Conductor-launched session in a worktree; call
   the probe once shortly after startup.
2. **Explicit resume** — harness's explicit resume flow (here: the coldest path,
   Conductor archive→unarchive→resume); compare against the original identity.
3. **Implicit resume / continue** — reopen / continue most recent session (no
   explicit id) and call the probe.
4. **`/clear` (Claude) / new conversation (Codex)** — trigger the harness's
   session-reset/new-thread mechanism, then call again and compare identity.
5. **MCP reconnect, same session** — force the MCP subprocess to restart while
   the harness session stays logically the same; call before and after.
6. **Two harness sessions in the same worktree** — two sessions against the
   identical worktree; check whether the two are distinguishable.
7. **Three Conductor worktrees** — three distinct roots; record identity + root
   observed for each.
8. **Skill/config inheritance into a session Slipstream did not launch** —
   confirm user-level MCP config is picked up by a session Slipstream had no
   part in starting.

### Caveat observed during runs — Codex transport drops

On several Codex calls the tool returned `Transport closed` with no snapshot.
The server was verified healthy in isolation (Node v24.11.0; the full Codex
handshake `initialize`→`initialized`→`tools/list`→`tools/call`→`ping` all
succeed). The cause of the drop is **unresolved**: the isolation handshake
establishes that the probe can complete that sequence, but does not distinguish
a harness-side subprocess loss from an integration-specific lifecycle or
protocol problem. The observed effect is scoped per conversation: a new
conversation (even in the same worktree) re-establishes a working connection,
while scenario 5 did not restore a working in-session stdio tool after the
subprocess died. Forwarder guidance below therefore treats the observed drop
as terminal for that binding, without assigning a root cause.

## Verdict for SC3

SC3 requires: "Identity binding uses verified harness session context; CWD
alone is insufficient. Ambiguous identity fails attachment rather than
guessing."

**The 15 measured scenarios show both harnesses expose verified, fresh identity
correlatable to exactly one canonical worktree, but the 8×2 matrix remains
incomplete until the Claude Code config-inheritance scenario records its required
tool call.** The measured evidence supports the two forwarder adapters below,
including the Codex concurrent-two-sessions-in-one-worktree and
config-inheritance scenarios (edinburgh-v1).

### Claude Code — SC3 SATISFIED, identity observable BEFORE declaration

- **Verified:** identity arrives as `CLAUDE_CODE_SESSION_ID` (a real UUID) in
  the subprocess environment, alongside `CLAUDE_PROJECT_DIR`, under a
  protocol-verified `clientInfo` (`claude-code@2.1.272`). Present at
  `initialize`, i.e. **before any tool/task declaration**.
- **Fresh:** the id is live/stable within a session; preserved across reopen,
  continue, explicit resume (incl. archive/unarchive), and MCP reconnect (env
  re-injected on respawn); minted fresh (never stale) on `/clear`. No scenario
  produced a stale id.
- **Correlatable to one canonical worktree:** `CLAUDE_PROJECT_DIR` pins the
  exact root; three-worktree runs showed zero cross-talk. `cwd` is corroborating
  but not required.
- **CWD alone insufficient / ambiguity handling:** a single fresh launch emits
  MULTIPLE connections with DISTINCT session ids in the SAME worktree, and two
  concurrent sessions in one worktree carry distinct ids. Binding MUST key on
  `CLAUDE_CODE_SESSION_ID` **per connection**, never on worktree/cwd. `_meta`
  carries only `toolUseId`/`progressToken` — no identity — so it is not a
  binding source for Claude.

### Codex — SC3 SATISFIED, but identity observable ONLY AT DECLARATION

- **Verified:** `clientInfo` is protocol-verified (`codex-mcp-client@0.154.0`).
  Codex exposes **NO** identity env var and a CLEAN environment at startup —
  `startup id present? = NO` in every row.
- **Identity carrier is the tool-call `_meta`, only:** `_meta.threadId`
  (== `x-codex-turn-metadata.thread_id` == session_id) plus
  `_meta.x-codex-turn-metadata.workspaces` (canonical worktree path → origin
  url + commit). This arrives ONLY on the tool call — there is nothing to bind
  to before the harness declares.
- **Fresh:** threadId preserved across reopen, continue, and explicit resume
  (archive/unarchive); minted fresh on a new conversation; distinct across
  sessions and across worktrees. No stale threadId observed.
- **Correlatable to one canonical worktree:** the `workspaces` map pinned
  exactly one root in every run (porto/chennai/florence distinct, zero
  cross-talk). `cwd` is UNRELIABLE (some connections report `cwd=/`), so binding
  MUST use `workspaces`, not `cwd`.
- **Observed reconnect outcome (scenario 5):** a killed Codex MCP subprocess
  was not restored to a working state within the same conversation. Its cause
  remains unresolved.

### Consequences for the P4 forwarder adapters (fail-closed, per guardrails)

- **Claude adapter:** bind on `(claude-code, CLAUDE_CODE_SESSION_ID,
  CLAUDE_PROJECT_DIR)` observed at `initialize`, per connection. May pre-select
  before declaration. Survives subprocess restart (env re-injected).
- **Codex adapter:** CANNOT pre-select. Derive the binding from the declaration
  call's `_meta`: require `_meta` present, `threadId` present, and a
  `workspaces` map with **exactly one** entry. **Fail closed** if `_meta` is
  absent, `threadId` missing, or `workspaces` is empty or has >1 entry
  (ambiguous root → refuse, do not guess). Treat a dropped Codex transport as
  **terminal for that binding** — the harness does not restore an in-session
  tool; do not attempt in-session re-bind, and never fall back to `cwd`/PID
  proximity.
- **Both:** each harness opens MULTIPLE MCP connections per user-facing session;
  binding is per-connection/per-call, never per-worktree. `cwd` is unreliable
  for both and must not be a binding input.

**SC3 verdict: INCOMPLETE.** The 15 measured rows show no need to fall back to
CWD/PID proximity and support the fail-closed rules above, but the startup-only
Claude Code config-inheritance evidence cannot support an unconditional SC3
conclusion. Capture a scenario-specific `identity_probe_snapshot` call and
compare it with its startup record before declaring SC3 satisfied. The Codex
transport-drop cause (scenario 5) also remains unresolved, although the adapter
already treats that observed behavior as terminal for the binding without
assigning a harness-side versus integration/protocol root cause.
