# `slipstream attach` live acceptance (2026-10-07)

Stage A5.4. Every run used a disposable store and disposable worktrees under
`/tmp`, a daemon started by `slipstream attach` itself, and real agent chats. No
hook callback was simulated: every delivery below is the harness running the
installed `PostToolUse` hook, and every answer came back through the installed
`slipstream_answer_question` tool. Questions were sent with `slipstream ask`,
the same control verb the Swift client uses.

## Runtimes found on this machine

| Launcher | Harness | Version and launch mode | In the verified set? |
| --- | --- | --- | --- |
| Terminal | Claude Code | 2.1.292, interactive (`cli`) | No |
| Conductor | Claude Code | 2.1.284, `sdk-ts` | No |
| Conductor | Codex | 0.159.3, SDK | No |
| Terminal | Codex | 0.157.1, `codex exec` (`codex_exec`) | No |

Verified set (unchanged by this work): Claude Code 2.1.283/`sdk-cli` and
2.1.280/`sdk-ts`; Codex 0.154.0 and 0.155.1 with originator `codex_sdk_ts`.
Disposable installs of Claude Code 2.1.283 and Codex 0.155.1 were used for the
passing runs. Widening the set is a version-policy decision (PR #48) and was not
made here.

## Results

| Path | Result |
| --- | --- |
| Terminal × Claude Code 2.1.283, `claude -p` (`sdk-cli`) | **Pass.** Daemon stopped → attach started it; config installed, `setup_pending` with the exact `claude --resume` step; after resuming, attach again reported the same capture; live setup check → `connected`; a real question was delivered and answered; another workspace and another chat were refused with nothing changed. |
| Terminal × Claude Code 2.1.283, interactive `claude` (`cli`) | Refused, nothing written. The `cli` launch mode is not verified. |
| Terminal × Claude Code 2.1.292 | Refused as an unverified runtime, nothing written. |
| Codex SDK 0.155.1 (`codex_sdk_ts`, Conductor's launch mode, run outside Conductor), full access | **Pass.** Config installed, `setup_pending`; after trusting the hook in Codex's own hook review, the setup check and a real question were delivered and answered. |
| Codex TUI 0.155.1 resuming an SDK-started chat | **Pass.** Hook trusted through the TUI's review; delivery and answer, with the TUI's normal tool-approval prompt. |
| Codex SDK 0.155.1, `workspace-write` sandbox | Refused: Codex keeps `.codex/` read-only in that sandbox. Attach now explains this instead of crashing. |
| Terminal × Codex 0.157.1 `codex exec` | Refused as an unverified runtime or launch mode, nothing written. |
| Conductor × Claude Code 2.1.284 | Refused as an unverified runtime, nothing written. **Not validated.** |
| Conductor × Codex 0.159.3 | Not run: outside the verified set, so attach would refuse. **Not validated.** |

Other acceptance items:

- Recordings made by the previously installed Slipstream stay readable; their
  `/v1/sessions` entries report `agent_connection: disconnected`
  (`capture_not_live`).
- Unsupported runtime, missing transcript, and an existing different Slipstream
  config entry are refused with the reason and nothing recorded.
- The Swift client's Ask Agent gate is covered by model tests; the app itself
  was not exercised against these stores.

## Known gaps

- Neither Conductor path is validated: every runtime Conductor ships today is
  outside the verified set.
- No heartbeat: a chat that has closed still shows `connected` until detach.
- Codex project hooks run only after the user trusts them in Codex's
  interactive hook review. SDK-launched chats (including Conductor's) never
  show that review, so the user must run `codex` in the workspace once to trust
  the hook.
- Whether Conductor reloads a running chat's new hook and tool is unverified.
