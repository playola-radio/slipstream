# Identity-probe findings — Stage 3 PR 1 (SC3 evidence)

**Status: scaffold only. No real-session evidence has been collected yet.**

Every row in the scenario matrix below is **UNMEASURED**, not confirmed,
not disproven, and not assumed. `UNMEASURED` in a cell is not a stand-in for
"probably works" or "probably fails" — it means literally no run has been
made. Do not fill any cell without a corresponding line in a real
`observations.jsonl` log produced by a real, operator-driven, Conductor-launched
harness session. See `tools/identity-probe/README.md` for wiring instructions
and how to read the log.

The synthetic unit tests under `tools/identity-probe/*.test.ts` are **not**
evidence for this document. They prove the server parses MCP messages and
builds records correctly; they say nothing about what a real Claude Code or
Codex process actually sends. Only real-session log lines, transcribed here by
a human, count.

## Environment pinning

Record the exact versions in play for the run(s) below, so evidence is pinned
to what actually shipped rather than to documentation:

| Field | Value |
| --- | --- |
| Conductor version | UNMEASURED |
| Claude Code — observed `initialize.clientInfo.version` | UNMEASURED |
| Codex — observed `initialize.clientInfo.version` | UNMEASURED |
| Date(s) of runs | UNMEASURED |
| Operator | UNMEASURED |

## Scenario matrix

One row per real run. Add rows as needed if a scenario is run more than once
(e.g. to check reproducibility). Columns:

- **harness** — `claude-code` or `codex`
- **scenario** — which of the 8 scenarios below
- **initialize.clientInfo** — the `name`/`version` observed in the `startup`
  record
- **startup id present?** — was `CLAUDE_CODE_SESSION_ID` (Claude) or a
  `CODEX_*` session/thread env var (Codex) present at `initialize` time?
- **tool-call `_meta` present + shape** — was `_meta` present on the
  `tools/call` params, and if so what keys/shape did it have (e.g. does Codex
  supply `threadId`)?
- **startup id == tool-call id?** — does the identity observed at startup
  match the identity observed on the tool call, in the same connection?
- **worktree correlatable?** — from the observed fields alone (no external
  knowledge), can this session be pinned to one exact canonical worktree?
- **notes** — anything scenario-specific (e.g. "id went stale after resume",
  "no per-call `_meta` at all")

| harness | scenario | initialize.clientInfo | startup id present? | tool-call `_meta` present + shape | startup id == tool-call id? | worktree correlatable? | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | 1. Fresh launch | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 1. Fresh launch | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| claude-code | 2. Explicit resume | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 2. Explicit resume | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| claude-code | 3. Implicit resume / continue | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 3. Implicit resume / continue | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| claude-code | 4. `/clear` / session change | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 4. Session change (Codex equivalent) | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| claude-code | 5. MCP reconnect, same session | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 5. MCP reconnect, same session | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| claude-code | 6. Two harness sessions, same worktree | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED (are the two sessions distinguishable from each other?) |
| codex | 6. Two harness sessions, same worktree | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED (are the two sessions distinguishable from each other?) |
| claude-code | 7. Three Conductor worktrees | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED (record exact identity + root for each of the three) |
| codex | 7. Three Conductor worktrees | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED (record exact identity + root for each of the three) |
| claude-code | 8. Skill/config inheritance into a session Slipstream did not launch | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |
| codex | 8. Skill/config inheritance into a session Slipstream did not launch | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED | UNMEASURED |

### Scenario definitions

1. **Fresh launch** — start a brand-new Conductor-launched harness session in
   a worktree; call the probe tool once shortly after startup.
2. **Explicit resume** — use the harness's explicit "resume this session" /
   "resume <id>" flow, then call the probe tool; compare against the original
   session's identity.
3. **Implicit resume / continue** — use the harness's "continue most recent
   session" behavior (no explicit id given) and call the probe tool.
4. **`/clear` (Claude) / session change (Codex)** — within a single running
   process, trigger whatever the harness's session-reset mechanism is, then
   call the probe tool again in the same process and compare startup vs.
   post-reset identity.
5. **MCP reconnect, same session** — force the MCP subprocess to restart
   (e.g. it crashes or the harness reconnects it) while the harness's own
   session stays logically the same; call the probe tool before and after.
6. **Two harness sessions in the same worktree** — open two independent
   harness sessions against the identical worktree at the same time; call the
   probe tool from each and check whether the two are distinguishable.
7. **Three Conductor worktrees** — open three separate Conductor worktrees
   (distinct roots) and call the probe tool from each; record the exact
   identity and worktree root observed for each of the three.
8. **Skill/config inheritance into a session Slipstream did not launch** —
   confirm the user-level MCP config (added per the README) is picked up by a
   harness session that Slipstream had no part in starting, and call the
   probe tool from it.

## Verdict for SC3

**Not yet written. This section is intentionally blank pending real-session
evidence.**

SC3 requires: "Identity binding uses verified harness session context; CWD
alone is insufficient. Ambiguous identity fails attachment rather than
guessing." Answering this requires knowing, from real runs above, whether
either or both harnesses expose **verified, fresh** identity that is
**correlatable to an exact canonical worktree**, and that this identity is
observable **before** any task declaration is made.

This section will be filled in only after every applicable scenario row above
has real data, with:

- A direct answer, per harness, to: does it expose verified, fresh identity
  correlatable to a canonical worktree before a declaration?
- If not for one or both harnesses: an explicit statement that **SC3 is
  blocked as written** for that harness, per
  `docs/superpowers/specs/2026-09-17-stage3-harness-identity-probe-design.md`
  and the project's "Decisions that are not yours to make" rule — this is not
  a decision to route around locally; it is reported up.
- If yes for one or both: the exact fields and conditions that make it true
  (e.g. "only true on fresh launch, not after resume"), since the matrix above
  is designed to catch partial rather than blanket answers.

No verdict is recorded until that evidence exists. Writing a verdict without
real runs behind it would be a fabricated finding, which violates this
project's honesty constraints.
