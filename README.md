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

## Install

```sh
npm install -g @playola-radio/slipstream
```

Node.js 24 or newer is required. The published package ships compiled
JavaScript; developing in this repo still runs the TypeScript sources directly
(`npm run slipstream`, `npm test`) with no build step. To put a clone on your
PATH with `npm link`, run `npm run build` first, and again after pulling: the
linked command runs the compiled `dist/`, not the sources.

## License

Apache-2.0. Copyright Playola Radio, Incorporated. See [`LICENSE`](LICENSE).

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

## What gets captured

Inside a git work tree, capture follows what git would merge: a path git ignores
and does not track is out of scope, decided by git itself rather than a
re-implemented matcher. Outside a git work tree, every path is captured.

You can exclude extra paths with a root **`.slipstreamignore`** file. It uses
git's own ignore syntax and, unlike `.gitignore`, can also exclude files git
*tracks* (a committed-but-noisy generated file, say). Its rules are frozen when a
capture starts, so editing the file takes effect on the next capture, not the
running one. The file is honored only inside a git work tree; a non-git root
ignores it. Patterns anchored with a leading slash (`/build`) are relative to the
git worktree root, as git's own excludes are — so place `.slipstreamignore` at
the worktree root rather than in a watched subdirectory. Excluded paths are never read or recorded, and the comparison API
discloses that the layer was active (`inventory.policy_exclusions` lists
`"slipstream-ignored"`).

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


## Queue a question about a captured change

With the shared daemon running (`slipstream start`) and explicitly attached to a
Claude Code or Codex session, an independent local client can queue a question:

```sh
slipstream ask --store /path/to/store --session <capture-uuid> \
  --request-id <caller-generated-lowercase-uuid> --input question.json
```

`question.json` contains the question and immutable after-snapshot identity read
from the public events API (sequence numbers are decimal strings):

```json
{
  "text": "Why is this check needed?",
  "context": {
    "change_seq": "42",
    "path": "src/example.ts",
    "snapshot_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "line_start": 3,
    "line_end": 5
  }
}
```

A follow-up adds `"reply_to_question_id"` naming the earlier question; its
`context` must be identical. The example hash is a placeholder: use the actual change's `after.sha256`. The
daemon validates the durable event and original blob, derives the selected text,
and copies the explicit attach target. It never reads the current working file
or accepts client-supplied authorship. Only after-content up to 1 MiB is eligible;
select at most 200 lines / 16 KiB. Questions are trimmed and capped at 8192 UTF-8
bytes. `serve` has no attach/control path and does not support `ask`.

Success prints JSON `{v:1,ok:true,session_id,request_id,question_id,seq,
queued_at_ms,expires_at_ms,duplicate}`. It means **durably queued**, not delivered
to an agent or answered. Read `slipstream.question.queued.v1` through the existing
authenticated `GET /v1/sessions/<id>/events` endpoint; its self-contained schema is
available at `GET /v1/schemas/slipstream.question.queued.v1`.

Codex and Claude Code delivery require an explicit root transcript binding at
`attach` and a `PostToolUse` hook configured before the chat starts. See
[the delivery contract](docs/ask-agent/contract.md#delivery-through-posttooluse)
for the control fields and setup. The public
`slipstream.question.dispatch_attempted.v1` event means the daemon committed an
attempt before answering the hook; it does not confirm receipt or an answer.
Attach Claude shortly after its first root tool call, and keep the chat's
current directory at the attached worktree when claiming a question.

Retry with the **same request ID, capture ID and input**. Same-ID/body retries
return the original result without extending the 30-minute TTL. A changed body
returns `REQUEST_CONFLICT`; more than 16 unexpired questions returns
`QUESTION_LIMIT`. Other domain errors are `INVALID_QUESTION`, `INVALID_CONTEXT`,
`SESSION_NOT_SELECTED`, `CAPTURE_NOT_READY`, and `STORAGE_UNAVAILABLE`. Errors
print structured JSON on stderr (exit 1); local file/syntax errors exit 2.
`STORAGE_UNAVAILABLE`, or a lost/malformed response after transmission, exits 3:
the outcome is unknown and the record may already be committed. Preserve the same
request ID, capture ID and input when retrying. A new capture never resumes an old queue; inspect
the old public log by `request_id` rather than retargeting a retry.

The control wire request is `{v:1,verb:"ask",session_id,request_id,text,context}`
over the owner-only `<store>/control.sock` using existing NDJSON framing. No
harness identity is required from the client. Full details, limits and lifecycle:
[queue contract](docs/ask-agent/contract.md). Receiving-answer UI remains
separate work.
