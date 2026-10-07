# Queue contract for the ask/send slice

Status: D1 queueing, D2 Codex delivery, S1 Swift sending, and D3 Claude Code
delivery through the same public question and attempt events are merged. D4
answer return and follow-up questions are specified in
[Answer return](#answer-return-d4).

## Boundary

Use the existing owner-only `<store>/control.sock`, NDJSON framing, 1 MiB line cap, and `v:1` envelopes. `daemon.ts:dispatch` already adds `v:1` to all replies; do not refactor existing replies. The public HTTP reader remains GET-only. Support the shared `start` + explicitly bound `attach` daemon mode. Standalone `serve` has no matching control/binding path and must not pretend to support asking.

No separate broker, database, registration service, HTTP write endpoint, or privileged Swift inbox access. An arbitrary independent local client can use the documented command protocol and read resulting public events. Filesystem ownership of the control socket is the existing local authentication boundary; preserve ownership checks and never expose it over TCP.

## Ask request and acknowledgment

```typescript
interface AskRequest {
  v: 1;
  verb: 'ask';
  session_id: string; // capture session, not harness session
  request_id: string; // caller-generated canonical lowercase UUID
  text: string;
  context: {
    change_seq: string; // canonical positive decimal; never JSON number
    path: string; // exact relative path from this event
    snapshot_sha256: string; // exact lowercase after-content hash
    line_start: number; // inclusive, 1-based integer
    line_end: number;   // inclusive, 1-based integer
  };
  reply_to_question_id?: string; // D4 follow-up; see "Follow-up questions"
}
interface AskAccepted {
  v: 1;
  ok: true;
  session_id: string;
  request_id: string;
  question_id: string;
  seq: string; // queued event seq
  queued_at_ms: number;
  expires_at_ms: number;
  duplicate: boolean;
}
interface AskRejected {
  v: 1;
  ok: false;
  code: 'PROTOCOL' | 'SESSION_NOT_SELECTED' | 'CAPTURE_NOT_READY'
    | 'STORAGE_UNAVAILABLE' | 'INVALID_QUESTION' | 'INVALID_CONTEXT'
    | 'REQUEST_CONFLICT' | 'QUESTION_LIMIT' | 'AGENT_NOT_CONNECTED';
  message: string;
}
```

`ok:true` acknowledges a durable queue record for the bound session, never delivery, model receipt, or an answer. The CLI prints acknowledgment/error metadata; it must not print bearer tokens or unnecessary source text.

Protocol framing/version/invalid request_id errors use `PROTOCOL`; text errors use `INVALID_QUESTION`; invalid source identity, range, or unavailable source use `INVALID_CONTEXT`. A broken/unhealthy store uses `STORAGE_UNAVAILABLE` rather than pretending source is empty. `CAPTURE_NOT_READY` retains existing readiness semantics. A mismatched/replaced/inactive capture is `SESSION_NOT_SELECTED`, never an invitation to auto-retarget. A selected capture whose agent chat has not completed the setup check (or that has no verified root chat) is `AGENT_NOT_CONNECTED`; see [Agent readiness](#agent-readiness).

For `ask`, `STORAGE_UNAVAILABLE` is conservatively **outcome unknown**: an append
may already be committed even when its acknowledgment failed. Keep the original
request ID, capture ID and normalized body; retry those unchanged after recovery.
Never generate a new ID or retarget a replacement capture. The CLI preserves the
JSON error code, adds same-ID retry guidance, and exits 3 for this case as well as
lost/malformed post-send replies. Other domain rejections exit 1; local file or
syntax errors exit 2.


## Source validation and normalization

The daemon, not the app, derives selected source text:
1. Resolve `change_seq` in the named active session's durable log, using a bounded finite read at its committed boundary. Merely comparing seq to durable_seq is insufficient.
2. Require `slipstream.file.changed.v1`, exact path match, an `after.kind=content` snapshot, and exact hash match. The event must belong to this capture session.
3. Read the CAS object with existing safe path/O_NOFOLLOW conventions and an actual bounded read (at most 1 MiB + 1 byte), not merely a pre-read size check. Verify its bytes against its content hash. Reject NUL and invalid UTF-8; preserve BOM, tabs and CRLF content. Do not read the current working file.
4. Empty text has zero lines. Otherwise split on LF, preserving internal empty lines, and drop only the last empty segment when the file ends in LF. Keep CR in segments. This matches `ChangedLines.split`; display-only stripping of CR and tab expansion must not affect the request's line identity.
5. Require integer `1 <= line_start <= line_end <= lineCount`. Select those segments and join with LF, without adding a synthetic final LF. Selected text is derived once and persisted in the queued event.

Caps: text 1–8192 UTF-8 bytes after ECMAScript `String.trim()` normalization; path 1–4096 UTF-8 bytes; source blob at most 1 MiB; selected range at most 200 lines and selected text at most 16384 UTF-8 bytes. UTF-8 byte limits avoid Swift grapheme/JS UTF-16 disagreement. Tests include CRLF, BOM, tabs, astral characters, blank lines, and trailing LF. Source verification is bounded and asynchronous; do not block capture or scan unrelated logs/transcripts.

## Target and durable event

Target is copied from the daemon's current explicit attach binding: `{harness, harness_session_id, worktree}`. The app supplies capture session_id; it never supplies or guesses authorship. Re-check current selection/ownership after asynchronous canonicalization/source reads and before admission/append. Once admitted, detach/shutdown drains the admitted operation through the existing lifetime mechanism.

D1 emits only `slipstream.question.queued.v1`. Use the normal CloudEvents envelope, `source=urn:slipstream:session:<capture-id>`, `id=seq`, and `subject=question/<question_id>`.

```typescript
interface QuestionQueuedData {
  session_id: string;
  question_id: string;
  request_id: string;
  target: { harness: 'claude-code' | 'codex'; harness_session_id: string; worktree: string };
  text: string; // normalized question
  context: AskRequest['context'] & { selected_text: string };
  queued_at_ms: number;
  expires_at_ms: number;
  reply_to_question_id?: string; // present only on a D4 follow-up
}
```

Use the existing single append/durability boundary; never append straight to events.jsonl. The event is not a filesystem change or attribution evidence. Preserve task grouping, capture, folds, GC and reader invariants.

## Retry, recovery, queue bounds

- One idempotency key is `(capture session_id, request_id)`. Canonical body is the fixed-order fields of normalized text + context. Same key/same body replays the original result with `duplicate:true`, including original timestamps; different body returns `REQUEST_CONFLICT`. Register/coalesce in-flight duplicates synchronously before the first await that could create competing work.
- TTL is 1,800,000 ms from the server's queued timestamp, using an injected clock. At most 16 unexpired, not-attempted questions are eligible. Count/reserve concurrent admissions so 17 simultaneous callers cannot exceed the limit. A duplicate does not consume a slot. Failed admission releases its reservation.
- Preserve the original result for a duplicate even after expiry; never extend TTL. There is no new expiry event, sweeper or timer. Expiry is a derived eligibility check (`now < expires_at_ms`); a late claim gets no question.
- Rebuild the question index from the valid durable prefix during the existing **in-process storage recovery** in `session.ts:tryStorageRecovery`, just as `seedTaskState` rebuilds task declarations. Reconstruct original IDs/timestamps/body fingerprints. A torn tail must not be treated as committed. Recovery occurs within a capture even though daemon restart creates a new capture; omitting this distinction can duplicate durable questions.
- A full daemon restart/detach/new attach makes the old queue ineligible. Never resume or migrate it to the new capture. A retry addressed to the old session returns `SESSION_NOT_SELECTED`; retain uncertainty about whether the old log contains a commit. The public reader can inspect the old log by request_id, but this slice adds no dedicated lookup endpoint or UI.
- Pre-transmission transport failure means unavailable. Any timeout/drop/malformed reply after transmission is outcome unknown. The client preserves the same request ID and draft for retry; it never silently creates a fresh request to resolve uncertainty.

## Delivery through PostToolUse

Name reserved for the later public event: `slipstream.question.dispatch_attempted.v1`. It is written before a claim reply; it proves an attempt, not receipt or model emission. D2 supplies its schema when its claim contract is finalized. No speculative dispatcher or unused dispatch schema in D1.

D2 offers at most one oldest eligible question per hook call, records an attempt before replying, and never automatically offers that question again after commit. Concurrent claims must have one winner. Failure after attempt commit is explicitly unconfirmed. Persisted attempt records rebuild the eligibility index during in-process recovery. Hook failures are silent exit 0, with a 300 ms connect / 1000 ms total budget and bounded additional context.

The reported Conductor routing proof established this Codex discriminator: root
PostToolUse omits both `agent_id` and `agent_type`; a child includes both and
has a different transcript. `session_id` and `cwd` alone do not distinguish
them. The raw P0 routing report was absent from the D2 handoff, so independent
D2 live acceptance carried its own evidence. Claude delivery uses the same
root/child callback field discriminator, plus a separately verified Claude root
transcript at attach.

### Concrete attach and claim protocol

`attach` accepts an optional `root_transcript` path in addition to its existing
`worktree`, `harness`, and `harness_session_id`. For Codex delivery it is
required. The daemon resolves it to a canonical path at attach, reads at most
64 KiB of its first `session_meta` record, and requires the selected session ID,
canonical cwd, `codex_sdk_ts` originator, observed `exec`/`vscode` source, and
an observed supported CLI version (`0.154.0` or `0.155.1`). A missing, malformed,
oversize or mismatched record fails attachment. The daemon holds the canonical
path in the active binding. Existing capture-only attaches continue to work but cannot
claim or accept questions. `slipstream attach <worktree> --store <dir> --harness codex
--harness-session-id <root-hook-session-id> --root-transcript <root-hook-transcript-path>`
sets the binding. Use the root callback's identity, never the first callback that
arrives after attach. The active `status` response includes `root_transcript`
when set. The queued event retains the D1 target shape; each fresh capture has
its own queue, so no old queue is rebound to a new transcript.

The Codex PostToolUse adapter sends one owner-only control request:

```json
{"v":1,"verb":"claim_question","harness":"codex","harness_session_id":"<hook session_id>","worktree":"<hook cwd>","transcript_path":"<hook transcript_path>"}
```

Both `agent_id` and `agent_type` must be **omitted** in the callback and the
control request. Present `null`, empty, partial or other values fail closed.
The daemon canonicalizes the callback paths, checks the complete active binding
after that asynchronous work, and admits one claim under the capture lifetime.
Missing identity, wrong capture, other chat, another worktree, child, Claude, or
unbound capture cannot claim. A matching empty queue replies
`{"v":1,"ok":true,"question":null}`. A successful reply carries one `question`
object with the queued event's data plus `queued_seq`. No status reply or hook
output is proof of model receipt.

Before returning a question, the daemon appends
`slipstream.question.dispatch_attempted.v1` through the session's serialized,
durable writer. Its `subject` is `question/<question_id>` and its data is
`{session_id, question_id, queued_seq, attempted_at_ms}`. It records an attempt
before response. A committed attempt is never automatically offered again;
socket/output loss after commit is unconfirmed. In-process recovery rebuilds
attempted IDs from the valid durable prefix. A precommit failure releases the
reservation. Expiry is derived from the queued deadline; no timer or expiry
event is added.

The adapter accepts only a bounded Codex `PostToolUse` callback with a nonempty
`session_id`, `cwd` and `transcript_path`, and both agent fields absent. It uses
the existing Unix socket client with 300 ms connect and 700 ms reply deadlines,
emits only `hookSpecificOutput` with `hookEventName: PostToolUse` and
`additionalContext`, and caps that context at 32 KiB. Selected source is included
verbatim between question-ID markers and is never truncated. The path normally
appears JSON-escaped on the `Source:` line. Escaping can expand an accepted
4096-byte path up to sixfold, so when that form would exceed the cap the context
instead carries the raw path between `BEGIN SOURCE PATH <id>` and
`END SOURCE PATH <id>` lines, labelled untrusted data. With accepted daemon
limits (question 8192 bytes, path 4096 bytes, source 16384 bytes) the raw form
always fits; the markers are framing, not a security boundary. A malformed
reply whose context would still exceed 32 KiB, which accepted limits cannot
produce, gets no output. Parse, socket, daemon,
timeout, identity and malformed-response failures exit 0 with no stdout. It
neither logs question/source bytes nor writes reply artifacts.

### Startup installation

The verified prototype ran on Codex CLI `0.154.0` in Terminal and `0.155.1`
in Conductor; the latter used normal user hook trust. D2 pins these observed
versions at attach. A newer version needs fresh root/child and socket proof
before being added to that allowlist. Unknown or changed callback identity
shapes produce no delivery until retested.
The later P0 root/child report did not include its raw runtime version in the
D2 handoff; acceptance must record it before claiming Conductor support.

Register a synchronous `PostToolUse` command hook before starting the Codex
chat, using the absolute Node 24 executable and this checkout's absolute
`src/cli.ts` path:

```json
{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/absolute/node /absolute/slipstream/src/cli.ts hook codex post-tool-use --store /absolute/private/store","timeout":3}]}]}}
```

Merge this entry into the existing `.codex/hooks.json` rather than replacing
other hooks. Codex loads project hooks from the chat's own workspace, so every
Conductor workspace needs the entry in its own `.codex/hooks.json`; a copy only
in the repository's main checkout is not loaded (D4 Conductor proof). The
workspace copy was observed to inherit the main checkout's hook trust without a
new prompt; that is an observation, not a traced guarantee. Review and trust this exact command through
Codex's normal hook trust flow before the chat starts. The hook's ability to
connect to the daemon's external Unix socket depends on the selected sandbox
configuration. Installation does not bypass trust or launch an agent. `slipstream attach` run with no
identity flags from inside the chat writes this entry for its own workspace only
(README, "Connect an agent chat"); there is no global installer and no Conductor API
dependency.

### D3 Claude Code binding and hook

Select a running Claude Code root with its **root** `SessionStart` or
`PostToolUse` callback's `session_id`, `cwd`, and `transcript_path`:

```sh
slipstream attach <worktree> --store <private-store> --harness claude-code \
  --harness-session-id <root-session-id> --root-transcript <root-transcript-path>
```

Claude can write startup preamble records before its first identity-bearing
record, and the transcript can be unavailable at `SessionStart`. In that case,
wait for the first root tool callback and attach using its transcript path.
Attachment reads a bounded, complete transcript head (at most 64 records,
4 MiB total, 256 KiB per record). It requires a matching session ID,
canonical worktree, external user, root `isSidechain:false`, and an observed
runtime/entrypoint pair: Terminal Claude Code `2.1.283`/`sdk-cli` or Conductor
Claude Code `2.1.280`/`sdk-ts`. Missing, truncated, contradictory, or newer
unverified metadata fails closed; test a newer runtime before adding it. A
record still being written inside the bounded head, including one after a valid
identity record, makes attach fail as retryable (`IDENTITY_UNRESOLVED`); retry
once the record is complete. Verification runs only at attach. The
head bounds are strict even after an identity record: a large early attachment
or too many startup records can make an established chat impossible to attach.
Select the root shortly after its first tool call. An unresolved path may also
be mistyped; check it before retrying. The verifier pins the first identity
record's cwd. Later transcript cwd can drift after `cd`; the hook still requires
the callback's cwd to exactly match the attached worktree, so return to that
directory before a queued question can be delivered.

The callback must later match the selected harness, session ID, canonical worktree,
and root transcript. Both `agent_id` and `agent_type` must be absent. A child,
other root, wrong worktree, cross-harness claim, stale capture, or partial
identity gets no question. Changing the chat with `/clear` creates a new
session; select and attach that new root explicitly if desired. A question
queued for the old capture is never migrated.

Configure a Claude Code `PostToolUse` command hook before starting the chat,
using absolute paths to Node 24, this checkout, and a private store:

```json
{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"/absolute/node /absolute/slipstream/src/cli.ts hook claude-code post-tool-use --store /absolute/private/store","timeout":3}]}]}}
```

Merge the hook into existing Claude settings without replacing unrelated
hooks. Use a project `settings.local.json` or explicit Terminal `--settings`
file, following the host's normal hook trust flow. The hook sends a bounded
`claim_question` to the owner-only control socket; it emits one
`hookSpecificOutput.additionalContext` of at most 32 KiB on success and is
silent on missing identity or failure. The daemon commits the public attempt
before the hook reply. Neither that event nor stdout proves the model saw the
question. `slipstream attach` with no identity flags installs this hook in the
chat's own workspace; it never trusts or approves it on the host's behalf.

## Answer return (D4)

The agent returns an answer only by calling the forwarder's MCP tool
`slipstream_answer_question({question_id, text})`. A chat reply, transcript
line, Stop/idle hook or next assistant message is never an answer. The delivered
question ends with one line telling the agent to use the tool:

> Return your answer by calling the slipstream_answer_question tool with question_id <id> and your complete answer as text. A chat reply alone does not reach the user.

`queued.v1` is a durable request, `dispatch_attempted.v1` means the hook reply
was about to be written, and `answered.v1` means the targeted harness session
called the tool with this text. No "received", "delivered", "expired" or
timeout fact exists.

### Control verb

```typescript
interface AnswerQuestionRequest {
  v: 1;
  verb: 'answer_question';
  question_id: string;
  text: string;
  harness: 'claude-code' | 'codex';
  harness_session_id: string;
  worktree: string; // absolute; the daemon canonicalizes it
}
interface AnswerAccepted {
  v: 1;
  ok: true;
  session_id: string; // capture
  question_id: string;
  event_id: string; // == seq
  seq: string; // answered event seq
  answered_at_ms: number;
  duplicate: boolean;
}
interface AnswerRejected {
  v: 1;
  ok: false;
  code: 'PROTOCOL' | 'IDENTITY_UNRESOLVED' | 'SESSION_NOT_SELECTED' | 'CAPTURE_NOT_READY'
    | 'STORAGE_UNAVAILABLE' | 'INVALID_ANSWER' | 'QUESTION_NOT_FOUND' | 'ANSWER_CONFLICT';
  message: string;
}
```

Checks, in order:

1. The identity triple is present, else `IDENTITY_UNRESOLVED`.
2. The worktree is canonicalized; afterwards the binding must still be current,
   untorn and uncompromised, and harness, harness session and worktree must equal
   the attached binding, else `SESSION_NOT_SELECTED`. A replaced capture is never
   retargeted.
3. Text is a string with a non-whitespace character, no unpaired surrogate, and
   at most 16384 UTF-8 bytes, else `INVALID_ANSWER`. It is stored verbatim.
4. The question exists in this capture, has a committed `dispatch_attempted.v1`,
   and its target equals the caller, else `QUESTION_NOT_FOUND`. Unknown, other
   capture, other harness session and queued-but-undispatched are
   indistinguishable.
5. One immutable answer per question: the same text replays the original result
   with `duplicate:true`; different text is `ANSWER_CONFLICT`.

`ok:true` means durably appended (or already appended). `STORAGE_UNAVAILABLE` is
outcome unknown, as for `ask`. The question TTL gates only claiming; a
dispatched question can be answered after it, and answering changes neither
claim eligibility nor claim order.

Authorization proves the answer came through the selected harness session, not
from the root agent. A Codex subagent has its own thread id and is rejected. A
Claude Code subagent shares the root's MCP server and environment, so its call is
accepted.

### MCP tool result

- Success requires an ack whose `question_id` matches and whose `event_id`
  equals a nonempty `seq`. Text: `Answer recorded for question <id> (seq <n>).`,
  with the ack (without `v`/`ok`) as structured content.
- A first-send rejection passes through as `isError:true`, text
  `<CODE>: <message>`, structured `{code}`.
- A lost or malformed reply after sending is retried once with identical text.
  On that resend only `INVALID_ANSWER`, `IDENTITY_UNRESOLVED` and
  `ANSWER_CONFLICT` are definitive; anything else becomes `OUTCOME_UNKNOWN`
  ("resending the identical text is safe, different text is not"), because the
  first send may have committed.
- An unreachable daemon is `DAEMON_UNAVAILABLE` and records nothing.

### Durable event

`slipstream.question.answered.v1` uses the `dispatch_attempted.v1` envelope
(`id == seq`, `subject = question/<question_id>`):

```typescript
interface QuestionAnsweredData {
  session_id: string;
  question_id: string;
  attempt_seq: string; // seq of the dispatch_attempted.v1 this answer follows
  text: string;
  answered_at_ms: number;
}
```

Recovery treats a subject that does not match `question_id`, an `attempt_seq`
that does not name that question's attempt, or a second answer for a question as
a corrupt log. Answers are not filesystem changes or attribution evidence. The
reader and SSE carry them in seq order, and in-process recovery rebuilds the
answer index from the durable prefix, so a resend after recovery replays. A
detach, daemon restart or new attach ends the capture; a late answer to an old
question gets `SESSION_NOT_SELECTED` and the old log stays readable.

### Follow-up questions

A follow-up is a normal `ask` with `reply_to_question_id`. The referenced
question must exist in the same capture and the request `context` must equal its
context (change seq, path, snapshot hash and line range), else `INVALID_CONTEXT`;
a malformed id is also `INVALID_CONTEXT`. The field is part of the request body,
so reusing a `request_id` with a different reply target is `REQUEST_CONFLICT`.
`queued.v1` carries it as optional `data.reply_to_question_id`. A thread is the
root question plus every question whose chain reaches it. The daemon does not
check whether the previous turn has been answered; disabling follow-up while a
turn is Waiting is a client rule. The delivered follow-up names its parent on
the line after the question text:

> This follows up Slipstream question <reply_to_question_id> about the same source.

## Agent readiness

A verified root binding is not proof that the chat can receive a question and
call the answer tool: configuration may be missing, the chat may need a reload,
or the host may deny the tool. The daemon therefore admits questions only after
one real round trip through the same path a question takes.

- `attach` with a `root_transcript` appends
  `slipstream.agent.connection.v1` with `state: "setup_pending"` and the chat
  as `target` (`harness`, `harness_session_id`), and arms a private setup check. Its ID appears in no status,
  attach reply, or public event.
- The bound root's next `claim_question` replies
  `{"v":1,"ok":true,"question":null,"setup_check":{"check_id":"<uuid>"}}`, once
  per arm. The hook turns it into context asking the chat to call
  `slipstream_answer_question` with that ID and the text `connected`.
- The answer passes the normal `answer_question` identity checks (only the bound
  chat, harness and worktree). The daemon then appends
  `slipstream.agent.connection.v1` with `state: "connected"` and acknowledges
  with the answer-ack shape; a resend replays it with `duplicate: true`.
- Until then, `ask` returns `AGENT_NOT_CONNECTED`. A capture-only attach never
  becomes connected.
- Every `status` reply lists `attach_features: ["agent-connection-v1"]`. A
  daemon without it predates the setup check, so `slipstream attach` refuses
  rather than install config that daemon would never confirm.

`connected` proves the round trip at the time of the event, not afterwards.
There is no heartbeat or expiry: a chat that exits after connecting still shows
`connected` until detach. Liveness of the capture itself comes from
`GET /v1/sessions`, whose items carry `agent_connection`:

```ts
type AgentConnection =
  | { state: 'connected' | 'setup_pending' }
  | { state: 'disconnected'; reason: 'capture_not_live' | 'no_agent' };
```

`capture_not_live` covers detached, replaced, removed and pre-readiness
recordings; old logs stay readable and their questions stay bound to them.

`attach` is idempotent for the active binding. The same worktree (after
canonicalization), harness and chat returns the same `session_id` with
`already_active: true` and the current `agent_connection`; a pending check is
re-armed so the next root callback delivers it again. Another chat in the same
worktree, or any other worktree, returns `SESSION_ACTIVE` naming what is being
recorded, and the existing binding is unchanged.

