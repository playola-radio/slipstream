# Stage 3 · PR 1 — Harness Identity Probe (design)

Date: 2026-09-17
Status: approved to build (Brian, D1=A after Codex Stage 3 consult)
Stage: 3 ("Prove riding alongside Conductor, with tasks"), PR 1 of 5

## Why this PR exists — and why it is first

Stage 3's binding success criterion SC3 says:

> Identity binding uses verified harness session context; CWD alone is
> insufficient. Ambiguous identity **fails attachment rather than guessing**.

Everything else in Stage 3 (the shared daemon, attach/detach, the
`slipstream_begin_task` MCP tool) rests on one unproven assumption: that a
Claude Code or Codex MCP stdio subprocess can observe **verified, fresh**
harness-session identity, and that this identity can be correlated to an exact
canonical worktree. If it cannot, SC3 is blocked *as written* and no amount of
attachment code fixes it.

The Codex Stage 3 consult (2026-09-17, archived at
`.context/stage3-codex-consult-output.txt`) found the assumption is **not**
currently proven by documentation:

- **Claude Code** is documented to pass `CLAUDE_CODE_SESSION_ID` into stdio MCP
  subprocesses, plus `CLAUDE_PROJECT_DIR`. But an MCP subprocess retains its
  *startup* id; an interactive resume/continue or `/clear` can leave that value
  **stale**, with no known in-band invalidation signal.
- **Codex** exposes an authoritative thread id only as **per-tool-call**
  metadata (`params._meta.threadId`, upstream PR openai/codex#18093). Nothing is
  documented at startup, so attachment *before the first declaration* may be
  unsupported.

Building attachment on top of that would bake in exactly the guessing SC3
forbids. So PR 1 does not build attachment. It **measures reality** and produces
an evidence report. A negative result is a valid, useful outcome: it tells us
SC3 is blocked and we stop and report with numbers (per CLAUDE.md "Decisions
that are not yours to make" and "If measurements say the current design is
insufficient, that is a useful result").

This mirrors the Stage 1 gate philosophy: prove the risky assumption with
measurement before building on it.

## Scope

### In scope

1. A **minimal, real MCP stdio server** under `tools/identity-probe/` that a
   harness can spawn via user-level MCP config. It implements just enough of the
   MCP 2025-06-18 stdio protocol (initialize / initialized / ping / tools/list /
   tools/call, JSON-RPC 2.0 over newline-delimited stdin/stdout) to be spawned,
   initialized, and called by a real Claude Code or Codex session. Diagnostics
   go to stderr; only protocol JSON goes to stdout.
2. A single diagnostic tool, `identity_probe_snapshot`, that captures the
   identity-bearing context the subprocess can observe **at that moment** and
   appends one **redacted** observation record to a local report log.
3. **Redaction + allowlist** logic that guarantees no secrets and no source
   bytes ever land in a committed artifact (owner-maintained honesty boundary,
   below).
4. A **findings scaffold** (`tools/identity-probe/FINDINGS.md`) listing the
   exact scenario matrix to run, with blanks to fill from real runs; and a
   README documenting user-level MCP wiring for **both** harnesses and the run
   procedure, keeping Conductor as the launcher.
5. Deterministic unit tests (CI tier) for the redaction, the MCP framing, and
   the observation-record builder, driven by a **synthetic** in-process client.

### Out of scope (explicitly)

- Any production capture change, event type, schema, IPC socket, daemon, CLI
  subcommand, or product error code. PR 1 introduces **none** of these.
- The `slipstream_begin_task` tool. The probe tool is diagnostic-only and never
  fabricates a task receipt.
- Transcript scanning, backfill hooks, a second capture source, dependency
  additions, or modifying the user's real MCP config from code.
- **Treating the synthetic-client tests as evidence about real harness
  behavior.** The tests prove the server *parses and records* correctly; they
  can never prove a real harness *supplies* a given field. Real-harness claims
  come only from recorded runs in `FINDINGS.md`.

## What "done" means for this PR

PR 1 is done when:

- The probe server builds, typechecks, and its CI-tier unit tests pass under
  `npm run test:tools`.
- The redaction guarantee is enforced by a test: given adversarial env/argv/meta
  inputs, no disallowed value and no path outside an allowlist appears in the
  emitted record.
- `FINDINGS.md` documents the scenario matrix and the wiring for both harnesses,
  and states plainly that unfilled rows are *unmeasured*, not *confirmed*.
- The evidence-gathering runs themselves are **operator-run** (Brian, in real
  Conductor sessions). The PR ships the instrument and the empty report; filling
  the report is a follow-up activity gated on real sessions, not a code gate.

This PR deliberately does **not** mark SC3 complete. SC3 is closed later (in the
attachment PR) *only if* the evidence here supports it.

## The honesty boundary (owner-maintained)

The same discipline the rest of Slipstream follows applies here:

- **Never record a value the allowlist did not explicitly permit.** Identity
  keys we care about (see below) are recorded by value; everything else is
  recorded by **key name only**, so we can discover unknown fields without
  leaking their contents.
- **Never record file contents.** The probe reads no worktree files.
- **Paths are home-relative.** Any absolute path is rewritten with `~` for the
  home directory before recording, so committed findings never leak a machine's
  directory layout or usernames beyond `~`.
- **A missing field is recorded as explicitly absent** (`{present: false}`),
  never omitted silently — an unobserved field is a finding, not a blank.
- **A synthetic observation is never labeled as a real-harness observation.**
  The record carries the observed `clientInfo` verbatim; if a human ran it by
  hand with no harness, that shows up as an absent/`unknown` client, not a
  fabricated one.

### The identity allowlist (recorded by value)

These are the fields whose *values* are identity evidence and are safe to record
(they are session/scope identifiers and protocol metadata, not user secrets or
source):

- Env: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CODEX_*` thread/session identifiers if present,
  `SLIPSTREAM_HOME`. `CLAUDE_PROJECT_DIR` and any path value is home-relativized.
- Process: `cwd` (home-relativized), `argv` (home-relativized).
- MCP `initialize` params: `protocolVersion`, `clientInfo.name`,
  `clientInfo.version`, and the *shape* (keys) of `capabilities`.
- MCP `tools/call` params: `_meta` (recorded verbatim — it is protocol metadata,
  where Codex's `threadId` lives), and the tool name. The tool `arguments` are
  **not** recorded beyond confirming presence.

Everything else in `process.env` is recorded as a **sorted list of key names
matching a discovery prefix** (`CLAUDE*`, `CODEX*`, `MCP*`, `SLIPSTREAM*`,
`CONDUCTOR*`) — names only, never values — so an unanticipated identity carrier
is discoverable in a follow-up without a data leak.

## The observation record

One JSON object per `identity_probe_snapshot` call, appended as a line to the
report log. Shape (all fields present; absence is explicit):

```jsonc
{
  "schema": "identity-probe-observation.v1",   // local dev artifact, NOT a public Slipstream event
  "captured_at_ms": 1789689932000,             // Date.now() — for run ordering only
  "phase": "tool_call",                        // "startup" | "tool_call"
  "env": {
    "CLAUDE_CODE_SESSION_ID": { "present": true, "value": "…" },
    "CLAUDE_PROJECT_DIR":     { "present": true, "value": "~/conductor/…" },
    "CODEX_THREAD_ID":        { "present": false },
    "SLIPSTREAM_HOME":        { "present": false }
    // …one entry per allowlisted env key
  },
  "discovered_env_keys": ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "…"], // names only
  "process": { "cwd": "~/conductor/…", "argv": ["node", "~/…/server.ts"] },
  "initialize": {                              // captured at startup, echoed on every record
    "present": true,
    "protocolVersion": "2025-06-18",
    "clientInfo": { "name": "claude-code", "version": "…" },
    "capabilityKeys": ["roots", "sampling"]
  },
  "tool_call": {                               // present only when phase == "tool_call"
    "present": true,
    "toolName": "identity_probe_snapshot",
    "meta": { "…": "verbatim _meta" },
    "hasArguments": false
  }
}
```

The `schema` string names this a **local development artifact**. It is
deliberately *not* a `slipstream.*` event type and never enters the public event
log. This keeps the frozen v1 public interface untouched (SC and the hard rule).

## Where artifacts live

- Code + tests: `tools/identity-probe/` (mirrors the existing `tools/live-feed/`
  dev-tool convention; tests run under the existing `npm run test:tools`).
- The report log the probe writes at runtime defaults to
  `tools/identity-probe/.observations.jsonl` and is **gitignored** — it can
  contain a machine's real (home-relativized) session ids. `FINDINGS.md` is the
  curated, hand-redacted, committed summary; raw observation logs are not
  committed.

## Interaction with the rest of Stage 3

PR 1 is a hard dependency of PR 2 (durable task declarations) and PR 3 (shared
daemon + attach): both encode identity assumptions this PR is meant to validate
or refute. The probe server is also a **reusable protocol skeleton** for PR 4's
real forwarder (same MCP stdio handshake), so the framing code is written to be
lifted, not thrown away.

Two Stage 3 rulings that do **not** affect this PR but bound later ones (recorded
so they are not re-litigated): the task event will carry a CloudEvents `subject`
of `task/<task_id>` via an additive optional envelope field (D2=A); Stage 3 uses
one shared daemon with a `~/.slipstream/` store (D3=accepted).

## Risks

1. **Claude's startup id goes stale with no observable invalidation** — the
   probe captures the id at startup *and* on every tool call, so a stale id
   shows up as a mismatch between the two phases across a resume/`/clear`
   scenario. This is the primary thing the scenario matrix is designed to catch.
2. **Codex offers identity only per tool call** — the matrix explicitly records
   whether *anything* authoritative is visible at startup vs only on a call. If
   only per-call, the report says so and PR 3's attach design must reckon with
   it (or SC3 is blocked).
3. **Conductor's embedded harness versions differ from upstream docs** — the
   report records observed `clientInfo.version` and Conductor version, so the
   evidence is pinned to what actually shipped, not to documentation.
