# Slipstream

**Watch your coding agent's work as it happens, instead of facing a pile of
changed files at the end.**

Slipstream is a local daemon that watches the folder an AI coding agent (Claude
Code, Codex, or any other) is working in and records every file change it
observes into an append-only event log. You can follow that log live in your
terminal, read it over a local HTTP API, or build your own viewer on top of it.

The name is the idea: a slipstream is the low-pressure pocket behind a
fast-moving object. Following there costs far less than leading. Reviewing an
agent's changes as they land is easier than reviewing them all at once.

> **Status: early and pre-1.0.** The capture engine, log format, reader API, and
> agent integrations work and are tested. They are developed and used daily on
> macOS. The event format may still change between releases. The Linux test
> suite runs in CI, but live capture on Linux gets far less use.

## What it is honest about

Slipstream makes narrow claims on purpose, and the rest of the design follows
from them.

- **It records observed states, not every write.** Slipstream watches the
  filesystem, so it sees what a file looked like when it read it. If a file goes
  `A → B → C` faster than Slipstream can read it, you see `A → C`. A file that is
  created and deleted within a fraction of a second may never appear. When
  Slipstream knows it missed something, it records an explicit gap event.
- **"Which agent made this change?" is a guess, and labeled as one.** Slipstream
  can read an agent's local transcript and match file changes to the agent's tool
  calls by timing. The result is marked `heuristic`, `ambiguous`, `unknown`, or
  `pending`, and can be revised later. It is never presented as proof of
  authorship.
- **Missing content is marked missing.** If a file could not be read (too large,
  permission denied, removed mid-read), the event says so and gives the reason.
  It never shows a fake empty file.

## Install

Requires **Node.js 24 or newer**. Day-to-day use is on **macOS**. Slipstream
watches files with [`@parcel/watcher`](https://github.com/parcel-bundler/watcher),
which also supports Linux.

```sh
npm install -g @playola-radio/slipstream
```

This installs two commands: `slipstream`, and `slipstream-mcp` (the connector
agents use, see [Group changes by task](#group-changes-by-task)).

**From a clone:** run `npm ci`, then `npm run slipstream -- <command>`. That
runs the TypeScript sources directly, with no build step. To put a clone's
commands on your PATH, run `npm run build && npm link`. Rebuild after pulling,
because the linked commands run the compiled `dist/`, not the sources.

## Quick start: watch a folder

The fastest way to see Slipstream work is to point it at a folder and follow
the feed from a second terminal.

**Terminal 1** — capture a folder and serve its feed:

```sh
slipstream serve ~/code/my-project --store ~/.slipstream-demo
```

It prints the new session's ID:

```text
slipstream: watching /Users/you/code/my-project
slipstream: session 3a8aee17-d12c-42f0-9798-f72d81819c0e
...
```

**Terminal 2** — follow it live:

```sh
slipstream view --store ~/.slipstream-demo --session <session-id>
```

```text
1 · slipstream.session.started.v1 · -
2 · slipstream.file.baselined.v1 · src/app.ts
3 · slipstream.capture.baseline.completed.v1 · -
4 · slipstream.enrichment.configured.v1 · -
5 · slipstream.file.changed.v1 · src/app.ts · 2751a3a
```

Add `--changes` to see the changed lines of each file, not just one line per
event. Edit something in the project, or let an agent work there, and the
changes appear as they are captured. Press Ctrl-C in terminal 1 to stop. The
history stays in the store.

> If you create the store folder yourself, make it private first
> (`mkdir -m 700 <dir>`). Slipstream refuses to use a store that other users on
> the machine can read, because the store holds copies of your source code.

## What gets captured

In a git repository, Slipstream records the files git would include in a
commit. A file that git ignores and doesn't track is skipped. Git itself makes
that call, so it matches your `.gitignore` exactly. Outside a git repository,
every file is captured.

To skip more, add a **`.slipstreamignore`** at the root of the repository. It
uses `.gitignore` syntax. Unlike `.gitignore`, it can also skip files git
tracks, such as a committed but noisy generated file. Slipstream reads it when a
recording starts, so edits apply to the next recording. It only works inside a
git repository. Skipped files are never read or stored, and reports from the
reader API say when this filter was active.

## Connect an agent chat

For real work, Slipstream runs as one long-lived daemon that records the
workspace an agent chat is working in. From inside the Claude Code or Codex
chat, run this in the workspace (or ask the agent to run it):

```sh
slipstream attach
```

It works out which chat it is in, starts the daemon if needed, and starts
recording. It also installs a hook and a tool in that workspace's agent config,
which let you [ask the agent about a change](#experimental-ask-the-agent-about-a-change).
If the chat has to reload to pick those up, `attach` prints the exact command.
Then:

```sh
slipstream status    # what's being recorded, and the reader URL
slipstream view --store ~/.slipstream --session <capture-session-id>
slipstream detach    # stop recording; history is kept
```

Current limits:

- **Only versions Slipstream has verified are accepted.** For Claude Code that
  is 2.1.283 started with `claude -p`, and 2.1.280 in Conductor. For Codex it is
  0.154.0 and 0.155.1, launched through its SDK. Anything else is refused and
  nothing is recorded. The versions Conductor ships today aren't on the list
  yet, so Conductor chats are refused for now.
- One workspace and one chat are recorded at a time.

**Recording any chat, without Ask Agent.** If your agent version isn't
verified, you can still record its workspace by naming the chat yourself:

```sh
slipstream start --enable claude-code &   # use --enable codex for a Codex chat
# Wait until it prints "slipstream: reader ..." before attaching.
slipstream attach ~/code/my-project \
  --harness claude-code --harness-session-id <chat-session-id>
```

`--harness` is `claude-code` or `codex`. The session ID is the chat
transcript's file name. `--enable` tells the daemon to read that harness's
transcripts and estimate which changes possibly came from the agent; without it,
Slipstream still records filesystem states but leaves that attribution unavailable:

- Claude Code: `~/.claude/projects/<project>/<session-id>.jsonl`
- Codex: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<session-id>.jsonl`

Everything about `attach`, including exactly which files it edits:
[docs/connect-agent-chat.md](docs/connect-agent-chat.md).

## Group changes by task

An agent can label its work so the feed groups changes under titles like "Fix
the pagination off-by-one" instead of by time alone. Slipstream offers this
through an MCP server, `slipstream-mcp`, which gives the agent a
`slipstream_begin_task` tool. The included [`SKILL.md`](SKILL.md) tells the
agent when to call it.

Copy-paste setup for Claude Code and Codex is in
[docs/mcp-forwarder-config.md](docs/mcp-forwarder-config.md). If the daemon isn't
running, the tool returns an error the agent is told to ignore. Slipstream never
blocks the agent's work.

## Build on it: the data is the interface

The bundled terminal viewer is just one client. Everything it shows is available
to any program you write, through two public routes. The daemon has no private
channel to its own UI.

**On disk.** The store (`~/.slipstream` by default) is plain files:

```text
~/.slipstream/
  sessions/<session-id>/events.jsonl   # append-only log, one JSON event per line
  blobs/sha256/<ab>/<sha256>           # file contents, stored by hash
  runtime/<id>.json                    # how to reach the running HTTP reader
```

Each line of `events.jsonl` is a [CloudEvents](https://cloudevents.io/)-style
record with a type such as `slipstream.file.changed.v1`. File contents are not
stored inline. Each change names its before and after content by SHA-256, and
the bytes live under `blobs/`. Contents are written to disk before any event
that refers to them, so a crash never leaves an event pointing at missing bytes.
Every event type has a JSON Schema in [`schemas/`](schemas/).

**Over HTTP.** The reader listens only on `127.0.0.1` and requires a bearer
token. Both the URL and the token are in the `runtime/*.json` file, readable only
by you.

```sh
STORE=~/.slipstream                               # or whichever --store you used
DESC=$(ls -t "$STORE"/runtime/*.json | head -1)   # the newest running reader
URL=$(node -p "require('$DESC').url")
# Put the token in a private file so it never appears in the process list.
HDR=$(mktemp); node -p "'Authorization: Bearer ' + require('$DESC').token" > "$HDR"

curl -H @"$HDR" "$URL/v1/sessions"
curl -H @"$HDR" "$URL/v1/sessions/<id>/events?after=0&follow=true"
```

| Route | Returns |
|---|---|
| `GET /v1/sessions` | Captured sessions |
| `GET /v1/sessions/:id/events?after=N[&follow=true]` | Events after sequence `N`, streamed live with `follow=true` |
| `GET /v1/blobs/sha256/:hash` | Raw file contents |
| `GET /v1/sessions/:id/changes/:seq/clips` | The changed regions of one file change ([CLIP-PROJECTION.md](CLIP-PROJECTION.md)) |
| `GET /v1/sessions/:id/interfaces?before_seq=B&after_seq=A` | Functions added, removed, or changed from sequence `B` through `A` in a session, for TypeScript and Swift ([FUNCTION-CHANGES.md](FUNCTION-CHANGES.md)) |
| `GET /v1/schemas/:type` | The JSON Schema for an event type |

To show the feed the same way the bundled viewer does, follow
[DISPLAY-FOLD.md](DISPLAY-FOLD.md). It explains how to turn the event stream
into what's displayed, and includes test cases a new client can check itself
against.

## Experimental: ask the agent about a change

From a captured change, you can queue a question about specific lines
("Why is this check needed?"). Slipstream delivers it to the attached chat the
next time the agent uses a tool, and the agent's answer is recorded back into
the log.

```sh
slipstream ask --store ~/.slipstream --session <capture-id> \
  --request-id <uuid> --input question.json
```

This needs a chat connected with the one-command `slipstream attach` above.
Until the chat confirms it can answer, questions are refused with
`AGENT_NOT_CONNECTED`. A successful `ask` means the question is safely queued,
not that the agent has seen it. The input format, limits, retry rules, and error
codes are in [docs/ask-agent/contract.md](docs/ask-agent/contract.md).

## Privacy and what Slipstream stores

- **Everything stays on your machine.** There is no telemetry and no network
  access beyond the local reader on `127.0.0.1`.
- **The store contains real copies of your source files**, including any secrets
  that pass through the watched folder and aren't excluded by git or
  `.slipstreamignore`. It is created readable only by you.
- **Slipstream reads your agents' local transcripts** (under `~/.claude` and
  `~/.codex`) to estimate which changes came from the agent. It never writes to
  them.
- **`slipstream attach` edits the workspace's agent config** (`.claude/` or
  `.codex/`) to add its hook and tool. Those entries contain local paths, so keep
  them out of commits.
- **History is kept until you delete it.** While the daemon is detached,
  `slipstream delete <session-id>` removes a session and `slipstream gc` removes
  file contents no remaining session refers to.

## How it works

```text
 agent edits files ─▶ worktree ─▶ file watcher ─▶ daemon ─▶ blobs/ + events.jsonl
                                                     │                   │
 agent's transcript ─(read-only, async)─▶ attribution┘                   ▼
                                                           HTTP/SSE reader ─▶ any client
 agent ─▶ slipstream-mcp (stdio, one per chat) ─▶ daemon control socket
```

- **The file watcher is the only capture source.** Agent transcripts can
  refine *who probably* made a change, but never create a change event. Each
  change is therefore recorded once.
- **Analysis never slows capture.** Transcript matching and code analysis run
  separately and only add to the log. If a step fails, the view has less
  detail, but no events are lost.
- **Slipstream never launches your agent.** It joins through the agent's own
  MCP and hook configuration. Each chat starts its own small `slipstream-mcp`
  process, which only relays to the single daemon that owns the store.

The full decision record is in [NOTES-architecture.md](NOTES-architecture.md).

## Command reference

| Command | Does |
|---|---|
| `watch [dir] [--store dir]` | Capture a folder into its own store, with no daemon or HTTP |
| `serve [dir] [--store dir]` | Same as `watch`, plus an HTTP reader |
| `start [--store dir] [--config file] [...]` | Run the shared daemon |
| `attach [dir]` | Run inside an agent chat: connect it and start recording |
| `attach [dir] --harness h --harness-session-id id` | Record a worktree for a chat you name yourself |
| `status` / `detach` | Show or stop the active recording |
| `view --store dir [--session id] [--changes] [--context N] [--full] [--disk]` | List sessions, or follow one live in the terminal |
| `ask --store dir --session id --request-id uuid --input file` | Queue a question for the agent (experimental) |
| `hook <codex\|claude-code> post-tool-use` | The hook command agents run to receive questions |
| `delete <session-id>` / `gc` | Remove a session / unused file contents (daemon detached) |

Run `slipstream` with no arguments for every option. The daemon commands accept
`--store <dir>`, which defaults to `~/.slipstream`; `view` needs it spelled out.
The daemon, the CLI, and `slipstream-mcp` must all use the same store.

## Contributing

Pull requests go to `develop`. Read [CLAUDE.md](CLAUDE.md) first. It lists the
rules that keep Slipstream honest, and the product decisions that need
discussion before a change.

```sh
npm run typecheck
npm test            # fast, deterministic tier; runs in CI on macOS and Linux
npm run test:os     # real-filesystem tier; needs macOS FSEvents
npm run test:tools
```

[TESTING.md](TESTING.md) covers the test layout and the fake filesystem the fast
tier uses.

### Design documents

| Document | Covers |
|---|---|
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Staged plan, success criteria, and status |
| [NOTES-architecture.md](NOTES-architecture.md) | Architecture decisions and the evidence behind them |
| [DISPLAY-FOLD.md](DISPLAY-FOLD.md) | How a client turns events into a display |
| [CLIP-PROJECTION.md](CLIP-PROJECTION.md), [FUNCTION-CHANGES.md](FUNCTION-CHANGES.md), [INTERFACE-PROJECTION.md](INTERFACE-PROJECTION.md) | Derived views: changed regions and function-level changes |
| [SWIFT-INTERFACE.md](SWIFT-INTERFACE.md), [INTERFACE-V2-TYPESCRIPT.md](INTERFACE-V2-TYPESCRIPT.md) | Language support for function-level changes |
| [STAGE-1-REPORT.md](STAGE-1-REPORT.md), [B2-MEASUREMENT-REPORT.md](B2-MEASUREMENT-REPORT.md) | Measured capture latency and loss |
| [docs/](docs/) | Agent setup, the ask-agent feature, reader API notes |

## License

Apache-2.0. Copyright Playola Radio, Incorporated. See [`LICENSE`](LICENSE).
