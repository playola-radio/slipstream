# Slipstream

**Review your coding agent's work as it happens, instead of facing a pile of
files at the end.**

Slipstream streams the changes an AI coding agent makes to your code, live, so
you can follow along and review in near-real-time while the agent works. The name
is the thesis: a slipstream is the low-pressure pocket behind a fast-moving
object, and riding in it makes following far cheaper than leading.

Status: **pre-implementation.** The architecture is settled and the MVP plan is
written. No code yet.

- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — the five-stage MVP plan
- [`NOTES-architecture.md`](NOTES-architecture.md) — decision record, verified
  findings, and the Codex adversarial review

## What it promises — and does not

> Slipstream streams **a live history of observed filesystem states, with
> explicit coverage gaps.** It does not claim to be a complete record of every
> write.

Capture is watcher-primary, so it observes states rather than writes. If a file
goes `A → B → C` faster than it can be read, Slipstream reports `A → C`; an
`A → B → A` cycle can be invisible entirely. Those gaps are disclosed in the
event schema and surfaced in the UI rather than papered over.

Similarly, attribution is revisable inference with an explicit status
(`pending` / `heuristic` / `ambiguous` / `unknown`), never a verified claim of
authorship. A timestamp near an agent's tool call is evidence, not proof.

## Design constraints

- **The event schema is the public interface.** The on-disk JSONL log plus
  content-addressed blobs are the source of truth; the HTTP/SSE reader is a thin
  view over them; the bundled UI is one client among possible many. You must be
  able to delete the front-end and replace it.
- **Slipstream does not launch agents.** Conductor stays the launcher.
  Slipstream rides in through user-level MCP and skill configuration.
- **Claude Code and Codex CLI from day one**, via a capture path that does not
  depend on either.

## Architecture

A headless local daemon (TypeScript/Node) captures bytes and writes an
append-only event log; a browser client (React + Monaco) renders the feed. The
MCP server is a thin stdio forwarder per agent session — verified necessary,
since each session spawns its own server process — and the daemon owns the store.
