# Configuring the Slipstream MCP forwarder

Slipstream reaches an agent through **user-level MCP configuration**, the same
way any other MCP server would. Slipstream does not launch the agent — Conductor
(or you) stays the launcher; the forwarder simply rides along in each session
the harness starts.

## What the forwarder is

`src/mcp-forwarder.ts` is a thin, per-session stdio MCP server. When a harness
starts a session it spawns one forwarder subprocess and speaks JSON-RPC to it
over stdin/stdout. The forwarder exposes exactly one tool,
`slipstream_begin_task(title)` (see `SKILL.md`), and forwards each declaration
to the shared Slipstream daemon over the daemon's local control socket. It never
captures files, never attaches or detaches (the `slipstream` CLI owns that), and
never reads the feed — it only forwards task declarations.

If no daemon is running for the store, the tool fails fast with
`DAEMON_UNAVAILABLE`; it never hangs. Declaring a task is best-effort grouping,
so a missing daemon is harmless to the agent's work.

## Prerequisites

- **Node 24+** (the project runs TypeScript directly via Node's type stripping;
  no build step). `node --version` should report `v24` or newer.
- The Slipstream **daemon** running against the store you want to feed. See the
  main `README.md` / CLI for starting it and for `slipstream attach` (which
  selects the watched worktree). The forwarder only *forwards* to a daemon; it
  does not start one.

## Choosing the store

The forwarder talks to the daemon whose store it is pointed at. Pass
`--store <dir>` to match the store the daemon and CLI use. Omit it to use the
default store, `~/.slipstream`. Whatever you choose, **the forwarder, the
daemon, and the CLI must all agree on the same store** — otherwise the forwarder
connects to the wrong (or no) daemon.

Use an **absolute path** for the checkout and the store in the config below;
harnesses spawn the server from an unspecified working directory.

## Claude Code

Add a server entry to your user-level MCP config (`~/.claude.json`, under
`mcpServers`):

```json
{
  "mcpServers": {
    "slipstream": {
      "command": "node",
      "args": [
        "/absolute/path/to/slipstream/src/mcp-forwarder.ts",
        "--store",
        "/absolute/path/to/your/store"
      ]
    }
  }
}
```

Drop the `"--store"` / store arguments to use the default `~/.slipstream` store.

## Codex

Add the equivalent entry to `~/.codex/config.toml`:

```toml
[mcp_servers.slipstream]
command = "node"
args = [
  "/absolute/path/to/slipstream/src/mcp-forwarder.ts",
  "--store",
  "/absolute/path/to/your/store",
]
```

Again, omit the `--store` arguments to use the default `~/.slipstream` store.

## Installing the skill

The forwarder only exposes the tool; `SKILL.md` tells the agent *when* to call
it. Install `SKILL.md` wherever your harness loads skills from (for Claude Code,
a user- or project-level skills directory). The skill is portable — it contains
no harness-specific identity mechanics — so the same `SKILL.md` works in any
harness that has the forwarder configured.
