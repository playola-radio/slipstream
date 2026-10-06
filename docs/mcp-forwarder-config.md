# Configuring the Slipstream MCP forwarder

Slipstream reaches an agent through **user-level MCP configuration**, the same
way any other MCP server would. Slipstream does not launch the agent — Conductor
(or you) stays the launcher; the forwarder simply rides along in each session
the harness starts.

## What the forwarder is

`src/mcp-forwarder.ts` is a thin, per-session stdio MCP server. When a harness
starts a session it spawns one forwarder subprocess and speaks JSON-RPC to it
over stdin/stdout. The forwarder exposes two tools and forwards each call to the
shared Slipstream daemon over the daemon's local control socket:

- `slipstream_begin_task(title)` declares a task (see `SKILL.md`).
- `slipstream_answer_question(question_id, text)` returns the agent's answer to
  a question the user asked from Slipstream. The delivered question tells the
  agent to call it; see `docs/ask-agent/contract.md` ("Answer return").

It never captures files, never attaches or detaches (the `slipstream` CLI owns
that), and never reads the feed.

If no daemon is running for the store, a tool fails fast with
`DAEMON_UNAVAILABLE`; it never hangs. Declaring a task is best-effort grouping,
so a missing daemon is harmless to the agent's work. An answer that fails is
not recorded, and the tool result says so.

## Prerequisites

- **Node 24+** (`node --version` should report `v24` or newer).
- **Slipstream installed**, which puts the forwarder on your PATH as
  `slipstream-mcp`:

  ```sh
  npm install -g @playola-radio/slipstream
  ```

  (Developing from a clone instead? Run `npm run build`, then `npm link`.
  Rebuild after pulling or editing sources — the linked commands run the
  compiled `dist/`, not your `.ts` files. Or point `command` at `node` with the
  absolute path to `dist/mcp-forwarder.js`.)
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

Use an **absolute path** for the store in the config below; harnesses spawn the
server from an unspecified working directory.

## Claude Code

Add a server entry to your user-level MCP config (`~/.claude.json`, under
`mcpServers`):

```json
{
  "mcpServers": {
    "slipstream": {
      "command": "slipstream-mcp",
      "args": [
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
command = "slipstream-mcp"
args = [
  "--store",
  "/absolute/path/to/your/store",
]
```

Again, omit the `--store` arguments to use the default `~/.slipstream` store.

To let Codex return answers, also:

- Approve the answer tool so Codex calls it without an approval prompt (with
  approval policy `never`, every call otherwise fails with "MCP tool call
  requires approval"):

  ```toml
  [mcp_servers.slipstream.tools.slipstream_answer_question]
  approval_mode = "approve"
  ```

- Run Codex in a **git** worktree. Outside git, Codex does not send the
  workspace metadata the forwarder uses to identify the chat, and every call
  fails closed with `IDENTITY_UNRESOLVED`.
- Install the Codex question hook (`docs/ask-agent/contract.md`, "Startup
  installation") in **each** workspace's `.codex/hooks.json`. Codex loads
  project hooks from the chat's own workspace, so a Conductor workspace does not
  read the main checkout's copy.

## After installing

MCP servers and hooks load only when a chat starts. Start a new chat after
installing or changing any of the above; an already-running chat does not see
the new tool.

## Installing the skill

The forwarder only exposes the tool; `SKILL.md` tells the agent *when* to call
it. Without the skill installed the tool is present but never triggered, so
install it for each harness you configured above. The skill is portable — it
contains no harness-specific identity mechanics — so the same `SKILL.md` works
in any harness that has the forwarder configured.

The skill's name (from its front matter) is `slipstream-begin-task`; use that as
the skill directory name where a harness expects one.

### Claude Code

Claude Code loads skills from a `skills/` directory, one folder per skill named
after the skill, each containing a `SKILL.md`. Install it at the user level:

```sh
mkdir -p ~/.claude/skills/slipstream-begin-task
cp /absolute/path/to/slipstream/SKILL.md ~/.claude/skills/slipstream-begin-task/SKILL.md
```

For a single project instead of every session, use that project's
`.claude/skills/slipstream-begin-task/SKILL.md` in place of `~/.claude`.

### Codex

Codex does not use Claude Code's skill-directory convention; it reads standing
instructions from `AGENTS.md` (the global `~/.codex/AGENTS.md`, or a project's
root `AGENTS.md`). Install the skill by appending its guidance — the body of
`SKILL.md` below the front matter — to whichever `AGENTS.md` Codex loads for the
sessions you want it active in:

```sh
# global, active in every Codex session:
cat /absolute/path/to/slipstream/SKILL.md >> ~/.codex/AGENTS.md
```

(The YAML front-matter block at the top of `SKILL.md` is Claude Code metadata;
it is inert as plain text in `AGENTS.md`, but you may trim it for tidiness.)
