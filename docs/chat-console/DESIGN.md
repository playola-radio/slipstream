# Chat console — daemon side

Date: 2026-10-18 · Status: approved by Brian 2026-10-18; Change 2 (record_question_exchange) implemented · Architecture
consulted with Codex (gpt-6-astra).

## Why

Brian wants the agent chat inside the Slipstream window, next to the stream,
so one workspace picker switches both. Conductor's local chats can't be driven
from outside (its API covers cloud workspaces only), so the Swift client will
**run the chat agent itself**. The client side is specified in the client
repo; this document covers the two daemon-repo changes.

## Change 1 — amend the launch rule (docs only)

`CLAUDE.md` (`AGENTS.md` is a symlink to it) ("Slipstream does not launch
agents. Conductor stays the launcher.") and `IMPLEMENTATION_PLAN.md`
("Conductor stays the launcher") are amended to:

> Conductor creates and sets up workspaces. The Slipstream client may run the
> chat agent inside a watched workspace. The daemon never launches agents, and
> capture stays watcher-primary: a client-run chat is never a capture source
> and never emits file-change events.

Also record that the attach / hook / `slipstream_answer_question` path is kept
for Conductor-run chats; client-run chats don't use it.

## Change 2 — record client-answered question threads

### Problem

Inline question threads are public log events today
(`slipstream.question.queued.v1` / `dispatch_attempted.v1` / `answered.v1`,
`src/public-events.ts:5-55`). With ask-at-a-line, the **client** answers by
forking the tab's conversation (`claude --resume <id> --fork-session`) — no
hook delivery, binding, or setup handshake. Those threads must still land in
the log ("no capability reachable only through the bundled UI").

### Control verb: `record_question_exchange`

```ts
{
  v: 1, verb: 'record_question_exchange',
  session_id, request_id,          // canonical UUIDs, as for `ask`
  text, context,                   // existing QuestionRequest fields
  answer_text,
  reply_to_question_id?,
  conversation: { harness, parent_session_id, fork_session_id }
}
```

- Returns `{ session_id, request_id, question_id, seq, duplicate }` only after
  durable append.
- Requires a **recording capture** (watch-only captures included). Requires no
  binding, connection, or handshake.
- Idempotent on `(session_id, request_id)` across concurrent calls and restart:
  identical normalized payload → original result with `duplicate: true`; any
  difference → `REQUEST_CONFLICT`. Reuse the reservation pattern in
  `src/session.ts` (~1017).

### Event: `slipstream.question.exchange_recorded.v1`

One self-contained event per completed question/answer pair: request fields,
daemon-generated `question_id`, daemon-read `context.selected_text`,
`recorded_at_ms`, and `conversation` with `reported_by: 'client'`.

Chosen over a discriminator on existing events because `queued` requires a
target and expiry and `answered` requires an `attempt_seq`; reusing them would
mean inventing a fake queue/attempt or making both contracts conditional. One
event also avoids partial two-event commits. Publish its JSON Schema, register
the envelope, include it in replay/SSE. No separate thread store.

### Validation vs. trust

- **Validated** (reuse `normalizeAsk`, `readQuestionContext`,
  `assertAnswerText` in `src/questions.ts`): IDs, text limits, the change
  belongs to this capture, path/hash match, content available, real line
  bounds. The daemon reads `selected_text` itself; never accept it from the
  client.
- **Client-reported, not verified**: the conversation IDs, that one is a fork
  of the other, and that the answer came from it. Validate only as bounded,
  non-empty, distinct strings. Never treat them as bindings or attribution
  evidence, and never inspect transcripts to "confirm" them. UI language:
  "Client reports this answer came from a copy of conversation X."
- `recorded_at_ms` is when the daemon recorded it, not when it was generated.
- Size: no product limit on `answer_text` (Brian, 2026-10-18). `ask`'s 16 KiB
  cap does not apply. Never truncate. If very large answers ever strain the
  log, store the text as a content-addressed blob referenced by hash (the
  existing pattern for file contents) — an internal detail, not a limit.
- Exchanges do not count against `QUESTION_LIMIT` (that bounds *pending*
  hook-delivered questions; an exchange is never pending).

### Follow-ups

Each follow-up is another exchange with `reply_to_question_id`. The parent must
be a recorded exchange in the same capture with identical source context (as
`ask` enforces today, `src/session.ts` ~1024). Chains don't mix paths: a
follow-up to a hook-delivered question goes through `ask`, a follow-up to an
exchange through `record_question_exchange`.

### Open risk — forked transcripts and attribution (needs Brian)

A fork (`--fork-session`) writes a new transcript in the same folder that
copies the parent's history under a new conversation ID. The daemon discovers
transcripts by folder, so the parent's past edit tool calls may appear twice as
evidence, from two conversations. That could turn a clear "possibly agent"
label into "ambiguous". Before Change 2 is built: run one real fork and check
what attribution does with it. If it degrades, how to treat copied evidence is
an attribution-confidence decision reserved to Brian. Do not quietly filter it.

### Not changing

`ask`, `claim_question`, `answer_question`, attach, binding, setup check — all
untouched. The daemon launches nothing. Only completed exchanges are recorded;
streaming, failed, or unfinished turns are out of scope.

### Tests

Watch-only capture succeeds; invalid context/content/text rejected; concurrent
and post-restart retries return the original or `REQUEST_CONFLICT`; parent
missing / in another capture / with mismatched context rejected; append failure
and lost acknowledgement; shutdown draining; thread reconstructable from disk
and over HTTP independently; existing question-delivery tests unchanged; the
verb emits no dispatch, binding, connection, attribution, or file-change event.

## Order

1. Change 1 (docs) — can land now.
2. Change 2 — lands before the client's ask-at-a-line work; the client's v0.1
   chat console does not depend on it.
