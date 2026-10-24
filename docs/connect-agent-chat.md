# Connect an agent chat

The full reference for one-command `slipstream attach`. The README has the short version.

This page covers chats that run outside the Slipstream app (a terminal or Conductor
chat), where the chat runs `slipstream attach` itself. The Slipstream app is being
designed to link its own chat for you instead, naming it explicitly, in the client
repo at `design/features/linked-chat/`; that path is not shipped yet.

From inside the Claude Code or Codex chat you want to connect, run (or ask the
agent to run) one command in the workspace:

```sh
slipstream attach
```

It finds the chat from the harness's own environment, starts the shared daemon
if it is not running, installs the question hook and the answer tool for that
harness in this workspace, and starts recording. Nothing needs copying: no chat
ID, transcript path, Node path, or checkout path.

- **Attached successfully** means both: the workspace is recording *and* the
  chat proved it can answer. A first attach always starts as `setup_pending`; the
  chat confirms through a one-time setup check on its next tool call. Until then
  the Slipstream app shows Ask Agent as unavailable and questions are refused
  with `AGENT_NOT_CONNECTED`.
- If attach had to install the hook or tool, the running chat must reload to see
  them. Attach prints the exact step: `claude --resume <id>` or
  `codex resume <id>` in the workspace, then `slipstream attach` again. The
  conversation is kept. Codex runs the new hook only after you trust it in
  Codex's own hook review.
- Running it again in the same chat reports the existing capture; it never starts
  a second recording or changes the binding.
- Several workspaces can record at once, and attach in a workspace that is
  already recording links the chat to that capture in place (same session ID, no
  new baseline). A capture links one chat, and a chat links one capture: if this
  chat is linked elsewhere, or another chat is linked here, attach installs and
  changes nothing and prints the `slipstream unlink --session <id>` step. The
  same holds when all 16 capture slots or all 10 chat slots are in use.
- If the workspace's capture is still starting, attach waits for it with short
  status checks and then links the chat. If it is still starting after 90
  seconds, attach says the outcome is unknown and exits with code 3; running it
  again never starts a second capture.
- Attach refuses, recording nothing, when it cannot tell which chat it is in,
  when the chat's transcript cannot be found, or when the harness version is not
  one Slipstream has verified. It never falls back to recording without an agent.

Files it writes, merging with what is already there and never duplicating its
own entry: Claude Code gets a `PostToolUse` hook in `.claude/settings.local.json`
and a local-scope `slipstream` MCP server (via `claude mcp add --scope local`);
Codex gets a hook in `.codex/hooks.json` and a `[mcp_servers.slipstream]` table
in `.codex/config.toml`. Unrelated hooks, servers, and permissions are kept. An
existing Slipstream entry pointing somewhere else is reported, not replaced,
and symlinked config is refused rather than followed. These files hold local
paths, so keep them out of commits; attach does not edit git ignore rules. The
host's own trust and approval prompts still apply: Codex may ask you to trust
the hook, and both harnesses ask before the first answer-tool call unless you
approve it.

Limitations:

- Verified runtimes only: Claude Code 2.1.283 started with `claude -p` and
  2.1.280 in Conductor; Codex 0.154.0 and 0.155.1 launched through its SDK
  (`exec` or `vscode` source). Other versions, and interactive `claude` or
  `codex exec` chats, are refused rather than guessed at. The Claude Code and
  Codex versions Conductor ships today are outside this set, so Conductor chats
  are refused for now. See the
  [acceptance record](ask-agent/attach-acceptance-2026-10-07.md).
- Codex SDK chats, including Conductor's, never show Codex's hook review. Run
  `codex` once in the workspace and trust the Slipstream hook there; attach
  prints this step.
- A Codex chat in the `workspace-write` sandbox cannot write `.codex/`; attach
  refuses and says so.
- A connected chat stays connected until detach; there is no heartbeat, so a
  chat that has since closed still shows as connected.
- Conductor has no verified way to reload a running chat's hooks and tools, so a
  Conductor chat that needed new config stays pending until it confirms.
- One chat per workspace, no chat picker.
