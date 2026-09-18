# identity-probe

A diagnostic MCP stdio server for Stage 3 PR 1. It exists to answer one
question with real evidence instead of documentation-reading: **can a Claude
Code or Codex MCP subprocess observe verified, fresh harness-session identity,
correlatable to an exact worktree, before that harness declares anything?**
That question is SC3's linchpin (see
`docs/superpowers/specs/2026-09-17-stage3-harness-identity-probe-design.md`).
Nothing in Stage 3's attach/detach design is safe to build until it is
answered from real sessions.

It implements just enough of the MCP 2025-06-18 stdio protocol
(`initialize` / `initialized` / `ping` / `tools/list` / `tools/call`,
JSON-RPC 2.0 over newline-delimited stdin/stdout) to be spawned and driven by
a real harness, and exposes exactly one tool, `identity_probe_snapshot`. Every
call records what that subprocess can currently see and appends it to a local
log.

Delete it and nothing else breaks. It is not wired into capture, the daemon,
or any production code path — it is a standalone measurement instrument, same
convention as `tools/live-feed/`.

## The honesty guarantee

This tool follows Slipstream's honesty constraints even though it never
touches the production event log:

- **No unallowlisted env values.** Only a fixed allowlist of identity-related env keys
  (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`,
  `SLIPSTREAM_HOME`) is recorded **by value**. Everything else in the
  environment is recorded as a **sorted list of key names only** — never
  values — and only if the key name matches a discovery prefix (`CLAUDE*`,
  `CODEX*`, `MCP*`, `SLIPSTREAM*`, `CONDUCTOR*`). An unanticipated identity
  carrier is discoverable by name without ever leaking what it contains.
- **MCP `tools/call` `_meta` is recorded verbatim.** `_meta` is protocol
  metadata and is the Codex `threadId` carrier this diagnostic is designed to
  measure, so it may contain whatever the client places there.
- **No file bytes, ever.** The probe never reads a worktree file. It only
  reads its own process environment, argv, cwd, and the MCP protocol messages
  the harness sends it.
- **Whole-token home paths are home-relativized.** `cwd`, each `argv` entry,
  and path-valued env fields (`CLAUDE_PROJECT_DIR`, `SLIPSTREAM_HOME`) are
  rewritten when the whole value starts with the real home directory. An
  absolute path embedded inside a larger argv token is not decomposed.
- **A missing field is recorded as explicitly absent**, never omitted. Every
  allowlisted env key appears in every record as either
  `{ "present": true, "value": "…" }` or `{ "present": false }`. An
  unobserved field is itself a finding, not a silent gap.
- **The runtime log is owner-only and never committed.** Because raw records may
  contain verbatim `_meta` and argv tokens, every call to
  `identity_probe_snapshot` appends one JSON line
  (`identity-probe-observation.v1`) to a `*.jsonl` file. `*.jsonl` is
  gitignored repo-wide, and the default log path
  (`~/.slipstream-identity-probe/observations.jsonl`) lives outside the repo
  entirely. An operator-supplied `SLIPSTREAM_IDENTITY_PROBE_LOG` path is
  tightened best-effort to owner-only permissions. **Only `FINDINGS.md` —
  hand-curated and human-redacted from the log — is committed.** Never `git
  add` an observation log.

## Running it standalone (sanity check only)

```bash
npm run identity-probe
```

This starts the stdio server and blocks, waiting for JSON-RPC messages on
stdin. It is meant to be spawned by a harness (below), not run interactively;
use `Ctrl-C` to stop it. Running it this way with no harness attached is a
useful smoke test but produces no `initialize` capture worth recording — a
human process has no `clientInfo` and no session env vars, and that absence
is exactly what the tool would (correctly) report.

## Wiring it into a real harness

**Slipstream does not launch the harness — Conductor stays the launcher.**
This tool arrives through user-level MCP config, the same way any other MCP
server would; there is no privileged channel between the probe and the
daemon, because there is no daemon involved at all.

### Claude Code

Add a server entry to your user-level MCP config (`~/.claude/mcp.json`, or
wherever your Claude Code install keeps user-scope MCP servers):

```json
{
  "mcpServers": {
    "slipstream-identity-probe": {
      "command": "node",
      "args": ["/absolute/path/to/tools/identity-probe/server.ts"]
    }
  }
}
```

Replace `/absolute/path/to/` with the real absolute path to this checkout.
Then, in a **Conductor-launched** Claude Code session (a real session, not a
one-off shell), call the `identity_probe_snapshot` tool — for example by
asking the assistant to invoke it directly. Afterward, inspect the log:

```bash
cat ~/.slipstream-identity-probe/observations.jsonl
```

(or `$SLIPSTREAM_IDENTITY_PROBE_LOG` if you set that environment variable to
override the default path).

### Codex

Add the equivalent entry to `~/.codex/config.toml`:

```toml
[mcp_servers.slipstream-identity-probe]
command = "node"
args = ["/absolute/path/to/tools/identity-probe/server.ts"]
```

Then, in a real Codex session, call `identity_probe_snapshot` and read the
same log path as above.

## Reading the log and filling `FINDINGS.md`

Each line in the log is one `identity-probe-observation.v1` record — a
`startup` record captured when the harness sends `initialize`, and a
`tool_call` record captured each time `identity_probe_snapshot` is called.
For each scenario row in `FINDINGS.md`:

1. Run the scenario in a real Conductor-launched session for the harness
   under test (see the scenario matrix in `FINDINGS.md` for the exact list —
   fresh launch, resume, `/clear`, reconnect, multiple worktrees, etc).
2. Call `identity_probe_snapshot` at least once.
3. Read the new line(s) appended to the log and compare the `startup` record
   (captured at that MCP connection's `initialize`) against the `tool_call`
   record from the same call.
4. Transcribe the relevant fields into the matching row of `FINDINGS.md` —
   `initialize.clientInfo`, whether the startup identity env var was present,
   whether `tool_call.meta` was present and what shape it had, whether the
   startup id and the tool-call id match, and whether the result is enough to
   pin an exact worktree. Home-relativized paths and env values from the log
   may be copied in as-is; they are already redacted.
5. Never fabricate or extrapolate a row from a different scenario. A row with
   no real run behind it must stay marked unmeasured.

## Evidence discipline

**The unit tests in this directory (`redact.test.ts`, `observe.test.ts`,
`mcp.test.ts`, `server.test.ts`) are not evidence about real harness
behavior.** They run against a synthetic in-process client and prove only
that this server parses MCP messages and builds observation records
correctly. They can never prove what a real Claude Code or Codex process
actually sends — only a recorded run in `FINDINGS.md`, produced by driving a
real Conductor-launched harness session end to end, counts as evidence for
SC3. This distinction is a product honesty requirement, not a style
preference: conflating "the code works" with "the harness behaves this way"
would let a false SC3 verdict slip through.

## Tests

```bash
npm run test:tools
npm run typecheck
```
