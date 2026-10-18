# Record Client-Answered Question Threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new control verb `record_question_exchange` durably appends one
self-contained `slipstream.question.exchange_recorded.v1` event per completed
question/answer pair that the Swift client answered from a forked conversation.
Task 0 first checks that forked transcripts don't damage attribution. If they
do, the work stops there.

**Architecture:** This mirrors the existing `ask` path end to end:
1. Normalize in `src/questions.ts`.
2. The session method gets idempotent reservation and reply-to validation in
   `src/session.ts`.
3. Recovery seeds the session after a restart (`src/recovery.ts`).
4. The daemon verb lives in `src/daemon.ts`.

The verb skips everything that `ask` needs only for hook delivery: binding,
connection, target, expiry, the queue limit, and the answer cap.

**Tech Stack:** TypeScript on Node 24, `node --test`, custom JSON Schema validator (`src/schema.ts`). No new dependencies.

**Spec:** `docs/chat-console/DESIGN.md` (Change 2 + "Open risk"). Stages C1.2/C1.3 in `IMPLEMENTATION_PLAN.md`.

## Global Constraints

- **No product limit on `answer_text`.** Never truncate it. The only ceiling is
  the control socket's existing per-message limit (`MAX_MESSAGE_BYTES = 1 MiB`,
  `src/control-protocol.ts:85`).
  - A larger request fails with `PROTOCOL` and nothing is appended.
  - Do not raise or lower that limit, and do not add another one.
- **The daemon reads `context.selected_text` itself** via `readQuestionContext`.
  Never accept it from the client.
- **Conversation ids are client-reported and unverified.**
  - Validate them only as bounded, non-empty, distinct strings.
  - Never use them as a binding or as attribution evidence.
  - Never read transcripts to "confirm" them.
- **The result returns only after the append is durable** (fsync'd), the same
  as `ask`.
- **`ask`, `claim_question`, `answer_question`, attach, binding and the setup
  check stay untouched.**
  - Do not edit their existing tests.
  - Exchanges do not count against `QUESTION_LIMIT`.
- **The verb appends exactly one event**: no dispatch, binding, connection,
  attribution, or file-change event.
- **Never commit captured data** (`.slipstream/`, `sessions/`, `blobs/`,
  `*.jsonl`). Task 0 scratch data lives under `.context/c12/` or `/tmp`.
- **Commits:** small, compiling, and passing. Never `--no-verify`. No
  `Co-Authored-By` or co-sign trailers.
- **Gates** (there is no lint script):
  - `npm run typecheck`
  - `npm test`
  - `npm run test:tools`
  - `npm run qa:check -- --all`

## Review Focus

1. **A lost acknowledgement retried after a daemon restart** returns the
   original result with `duplicate: true`. It must not create a second event.
   This is pinned in Task 4 (session restart) and Task 5 (daemon restart).
2. **A very large answer** (200 KiB, multi-byte characters) round-trips
   byte-identical through recovery and HTTP replay. A request over 1 MiB fails
   `PROTOCOL` with nothing appended. Pinned in Task 5.
3. **Chains don't mix paths.**
   - An exchange replying to an `ask` question gives `INVALID_CONTEXT`.
   - An `ask` replying to an exchange also gives `INVALID_CONTEXT`, with `ask`
     code unchanged.
   - Pinned in Task 4.
4. **A capture that stops while an exchange is in flight** settles that
   exchange: it is either committed or an error, never half-written, and
   shutdown waits for it. Pinned in Task 5.
5. **Context pointing at unavailable content** (wrong seq, another capture's
   change, hash mismatch, deleted/content-unavailable change) gives
   `INVALID_CONTEXT` with nothing appended.
   - A lone-surrogate or whitespace-only answer gives `INVALID_ANSWER`.
   - Pinned in Tasks 1 and 4.

---

### Task 0: Fork-attribution check (Stage C1.2) — STOP GATE

**Files:**
- Create: `.context/c12/report.md` (gitignored scratch; a summary goes into
  `IMPLEMENTATION_PLAN.md`)
- Modify: `IMPLEMENTATION_PLAN.md` Stage C1.2 **Status**

This task produces no code. Tasks 1–6 do not start until it passes.

- [ ] **Step 1: Set up a watched scratch repo with attribution on.**
  - Run `git init` in `/tmp/c12-repo` with one committed file, `hello.txt`
    (`one`).
  - Start a daemon from this worktree with Claude attribution enabled
    (`--enable claude-code`; see `node src/cli.ts --help` for the exact daemon
    and attach commands).
  - Attach a watch-only capture to `/tmp/c12-repo` and use a store dir under
    `/tmp/c12-store`.
  - Confirm the capture shows `recording`.

- [ ] **Step 2: Baseline edit by a parent conversation.**
  - From `/tmp/c12-repo`, run
    `claude -p --session-id <A> --model haiku --permission-mode bypassPermissions "Append the line 'two' to hello.txt"`.
  - Wait for the change, then record its attribution status and label from the
    reader.
  - Expected: `heuristic` / "possibly agent".

- [ ] **Step 3: Fork without editing.**
  - Run
    `claude -p --resume <A> --fork-session --model haiku "Reply with OK. Do not edit any files."`.
  - Confirm that a new transcript file `<B>.jsonl` exists beside `<A>.jsonl` and
    contains `<A>`'s edit tool call.

- [ ] **Step 4: Edit again from the parent, then once by hand.**
  - Run `claude -p --resume <A> ... "Append the line 'three' to hello.txt"`.
  - Then run `echo four >> /tmp/c12-repo/hello.txt` from a shell.
  - Wait for attribution to settle (re-evaluation is revisable).

- [ ] **Step 5: Record the results.**
  - In `.context/c12/report.md`, write a table: change → status/label before
    the fork, and status/label after the fork.
  - Cover all three changes, plus whether the fork's copied tool calls appear as
    evidence.

- [ ] **Step 6: Gate.**
  - **Pass** = no change's status or label got worse because of the fork. The
    edit from step 2 is still `heuristic`, the step-4 agent edit is
    `heuristic`, and the manual edit is not "possibly agent".
  - **Fail** (anything became `ambiguous` or flipped): **STOP.**
    - Set C1.2 Status to `Blocked — forked transcripts degrade attribution;
      see report`.
    - Report the table to Brian.
    - Do not filter copied evidence. That is his call.
  - On pass: set C1.2 Status to `Complete — <one-line result>`, then commit
    `IMPLEMENTATION_PLAN.md` only.

---

### Task 1: Normalize an exchange request

**Files:**
- Modify: `src/questions.ts`
- Test: `src/questions.test.ts`

**Interfaces:**
- Consumes: `normalizeAsk`, `QuestionRequest`, `QuestionError`,
  `assertAnswerText`, `MAX_ANSWER_BYTES` (existing); `HarnessName`
  (`src/event.ts:172`).
- Produces:
  - `interface ExchangeConversation { harness: HarnessName; parent_session_id: string; fork_session_id: string }`
  - `interface QuestionExchangeRequest extends QuestionRequest { answer_text: string; conversation: ExchangeConversation }`
  - `normalizeExchange(value: unknown): QuestionExchangeRequest`. It throws
    `QuestionError`.
  - `exchangeBody(req: QuestionExchangeRequest): string`. This is the
    idempotency fingerprint.
  - `assertAnswerText(text: unknown, maxBytes?: number)`. Its signature widens;
    the default stays `MAX_ANSWER_BYTES`, so `answer_question` behavior is
    unchanged.

- [ ] **Step 1: Write failing tests** in `src/questions.test.ts`:
  - `normalizeExchange accepts a valid request and copies only contract fields`.
    Extra keys such as `selected_text`, `question_id` and `reported_by` are
    absent from the result.
  - `normalizeExchange keeps a 200 KiB multi-byte answer byte-identical`. Use
    `'é'.repeat(100*1024)` and assert strict equality, untrimmed.
  - `normalizeExchange rejects answer_text that is missing, non-string, whitespace-only, or has a lone surrogate`.
    Use `'\uD800'`. Every case gives code `INVALID_ANSWER`.
  - `normalizeExchange rejects bad conversation`. Each of these gives code
    `PROTOCOL`:
    - a missing object
    - harness `'cursor'`
    - an empty id
    - an id longer than 256 characters
    - an id containing a control character (`'a\nb'`)
    - `parent_session_id === fork_session_id`
  - `normalizeExchange inherits ask validation`. A bad `request_id` gives
    `PROTOCOL`, empty text gives `INVALID_QUESTION`, and `line_end < line_start`
    gives `INVALID_CONTEXT`.
  - `exchangeBody differs when answer_text, conversation, or reply_to differs and is equal for identical requests`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `node --test src/questions.test.ts`
  - Expected: FAIL with `normalizeExchange` not exported.

- [ ] **Step 3: Implement.**
  - `normalizeExchange` calls `normalizeAsk(value)` for the shared fields.
  - It then validates `answer_text` with
    `assertAnswerText(v.answer_text, Infinity)` and does not trim it.
  - It validates `conversation`: the harness is in `['claude-code','codex']`,
    and each id is 1–256 characters with no C0/C1 control characters. Distinct
    ids are required.
  - `exchangeBody` returns `JSON.stringify([questionBody(req), req.answer_text, harness, parent_session_id, fork_session_id])`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `node --test src/questions.test.ts src/answer-session.test.ts`
  - Expected: PASS. The `answer_question` 16 KiB cap tests are unchanged and
    still pass.

- [ ] **Step 5: Commit.** Message: "Validate client-answered question exchanges".

---

### Task 2: The `exchange_recorded` event and its schema

**Files:**
- Modify: `src/public-events.ts`
- Create: `schemas/slipstream.question.exchange_recorded.v1.json`
- Test: `src/question-schema.test.ts`. `src/schema.test.ts` needs no edit,
  because its file-set assertion covers the new type automatically.

**Interfaces:**
- Consumes: `ExchangeConversation`, `QuestionContext` (Task 1).
- Produces:
  - `interface QuestionExchangeRecordedData`, with these fields:
    - `session_id`, `question_id`, `request_id`
    - `text`
    - `context: QuestionContext & { selected_text: string }`
    - `answer_text`
    - `recorded_at_ms: number`
    - `reply_to_question_id?: string`
    - `conversation: ExchangeConversation & { reported_by: 'client' }`
  - `QuestionExchangeRecordedEvent` (subject `question/<question_id>`), with
    `type: 'slipstream.question.exchange_recorded.v1'`.
  - `QuestionExchangeRecordedInput` (data without `session_id`).
  - The new type is added to `PUBLIC_EVENT_TYPES`, `PublicEvent` and
    `PublicEventInput`, and `buildPublicEnvelope` handles it.

- [ ] **Step 1: Write failing tests** in `src/question-schema.test.ts`, using
  the file's existing build-then-`validate` pattern:
  - `exchange_recorded envelope validates against its schema`. The subject is
    `question/<question_id>` and `data.session_id` is injected.
  - `exchange_recorded schema has no maxLength on answer_text`. A 200 KiB
    answer validates.
  - Negative table. Each row fails validation:
    - missing `answer_text`
    - empty `answer_text`
    - missing `conversation.reported_by`
    - `reported_by: 'daemon'`
    - harness `'cursor'`
    - missing `context.selected_text`
    - a bad `subject`
  - `foldDisplay ignores exchange_recorded`: the fold is empty, as asserted for
    the other question events.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `node --test src/question-schema.test.ts src/schema.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Add the types and the `buildPublicEnvelope` branch, built like
    `answered`'s inline envelope.
  - Write the schema by copying `slipstream.question.queued.v1.json`'s
    envelope and `$defs`. For `data`:
    - required: `session_id`, `question_id`, `request_id`, `text`, `context`,
      `answer_text`, `recorded_at_ms`, `conversation`
    - `answer_text` is `{type:string, minLength:1}` with no maxLength
    - `conversation.reported_by` is `{const:'client'}`
    - the `$comment` states that the conversation ids are client-reported and
      unverified, and never authorship.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `node --test src/question-schema.test.ts src/schema.test.ts src/maintenance.test.ts && npm run typecheck`
  - Expected: PASS.

- [ ] **Step 5: Commit.** Message: "Add the public event for a recorded question exchange".

---

### Task 3: Recover exchanges from the log

**Files:**
- Modify: `src/recovery.ts` (the `RecoveredSession` interface around 25-56,
  the switch around 237-320, and the return around 363)
- Test: `src/recovery.test.ts`

**Interfaces:**
- Consumes: `QuestionExchangeRecordedEvent` (Task 2).
- Produces: `RecoveredSession.questionExchanges: QuestionExchangeRecordedEvent[]`, in log order.

- [ ] **Step 1: Write failing tests:**
  - `recovery collects exchange_recorded events in order`.
  - `recovery rejects an exchange whose subject does not match its question_id`.
    It throws `CorruptLogError`, the same as the queued-subject check.
  - `recovery rejects a schema-invalid exchange_recorded event`. It throws
    `CorruptLogError`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `node --test src/recovery.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement.** Add a `case` that mirrors the queued case's
  subject check, then push the event.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `node --test src/recovery.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit.** Message: "Recover recorded question exchanges after restart".

---

### Task 4: `recordQuestionExchange` on the capture session

**Files:**
- Modify: `src/session.ts`. This covers:
  - the `CaptureSession` interface (around 122)
  - the state maps (around 252)
  - `seedTaskState` (around 274)
  - `taskSequencer.onCommitted` (around 303)
  - the `appendEvent` overloads (around 438)
  - the new method next to `askQuestion` (around 1012)
  - the returned object (around 1184)
- Modify: `src/questions.ts`. Add `QuestionExchangeAccepted` and
  `exchangeResult`.
- Test: create `src/question-exchange-session.test.ts`, reusing the `fixture()`
  helper pattern from `src/question-session.test.ts`.

**Interfaces:**
- Consumes:
  - `normalizeExchange`, `exchangeBody` (Task 1)
  - `QuestionExchangeRecordedInput` (Task 2)
  - `rec.questionExchanges` (Task 3)
  - `readQuestionContext`, `questionReady`, `appendEvent` (existing)
- Produces:
  - `interface QuestionExchangeAccepted { session_id; request_id; question_id; seq: string; duplicate: boolean }`
  - `exchangeResult(event: QuestionExchangeRecordedEvent): QuestionExchangeAccepted`.
    It is frozen, with `duplicate: false`.
  - `CaptureSession.recordQuestionExchange(input: unknown, assertOwnership?: () => void): Promise<QuestionExchangeAccepted>`

- [ ] **Step 1: Write failing tests:**
  - `records one exchange_recorded event with daemon-read selected_text and reported_by client`.
    The session has a seeded change, and the request passes
    `selected_text: 'forged'`.
    - The event's `context.selected_text` equals the real snapshot lines.
    - `conversation.reported_by === 'client'`.
    - The log grew by exactly one record.
  - `identical retry returns the original result with duplicate true`. This is
    covered both settled and concurrent (two calls before the first append
    resolves). There is one event in the log.
  - `same request_id with a different answer_text is REQUEST_CONFLICT`.
  - `retry after session restart returns duplicate true`. Stop and resume with
    the same store; the log still has one exchange.
  - `exchanges do not count against QUESTION_LIMIT`. Record 17 exchanges, all
    succeed, and then a regular `ask` still has a full budget.
  - `follow-up to a recorded exchange with identical context succeeds`. Also:
    - a follow-up with a different `line_end` gives `INVALID_CONTEXT`
    - an unknown parent id gives `INVALID_CONTEXT`
    - a parent recorded before a restart is still accepted afterwards
  - `exchange replying to an ask question is INVALID_CONTEXT`, and
    `ask replying to an exchange is INVALID_CONTEXT`.
  - `context naming another session's change, a wrong hash, or a content-unavailable change is INVALID_CONTEXT and appends nothing`.
  - `append failure surfaces STORAGE_UNAVAILABLE and a later identical retry succeeds once`.
    Inject `createLog` the way `question-session.test.ts` does for ambiguous
    appends.
  - `session_id mismatch is SESSION_NOT_SELECTED`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `node --test src/question-exchange-session.test.ts`
  - Expected: FAIL with `recordQuestionExchange` not a function.

- [ ] **Step 3: Implement** by mirroring `askQuestion`'s shape:
  1. Normalize, check the session id, `assertOwnership()`, `questionReady()`.
  2. Check `committedExchanges` and `inflightExchanges`. On a hit, compare
     `exchangeBody`: equal gives a duplicate, otherwise `REQUEST_CONFLICT`.
  3. If there is a `reply_to_question_id`, look up `exchangesById` and compare
     the five context fields exactly as `askQuestion` does.
  4. Build the deferred promise, register it in `inflightExchanges`, and inside
     it:
     - `readQuestionContext`
     - re-check ownership and readiness
     - `appendEvent` with a new `question_id` (a random UUID) and
       `recorded_at_ms`
     - the surrendered check
     - `committedExchanges.set`
  5. Delete the entry in `finally`.

  Bookkeeping:
  - `seedTaskState` fills `committedExchanges` (using `exchangeBody` on the
    event data) and `exchangesById` from `rec.questionExchanges`.
  - `onCommitted` registers exchanges in `exchangesById`.
  - `exchangesById` is separate from `questionsById`, so `ask`'s reply-to
    lookup never sees exchanges. The `ask` code stays unchanged.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `node --test src/question-exchange-session.test.ts src/question-session.test.ts src/answer-session.test.ts src/question-delivery.test.ts`
  - Expected: PASS. The existing files are unedited.

- [ ] **Step 5: Commit.** Message: "Record client-answered question exchanges in a capture session".

---

### Task 5: The `record_question_exchange` control verb

**Files:**
- Modify: `src/daemon.ts`. Add `ownsCapture(c)`, have `owns(c, b)` call it, add
  the `recordExchange` handler, and add a `case 'record_question_exchange'` in
  `dispatch` (around 1308).
- Modify: the header comment of `src/control-protocol.ts` (the verb list).
- Modify: `docs/ask-agent/contract.md`. Add a short "Client-recorded
  exchanges" section: the request, the response, the event, and the
  "client-reported, unverified" wording. Link it to `docs/chat-console/DESIGN.md`.
- Test: `src/daemon.test.ts`, using `withDaemon`, `attachWatchOnly`,
  `withResumeDaemon` and `call`.

**Interfaces:**
- Consumes: `CaptureSession.recordQuestionExchange` (Task 4); `track`,
  `controlFailure`, `isLive`, `isRunning`, `errFields` (existing).
- Produces:
  - `ownsCapture(c: Capture): () => void`. It throws
    `QuestionError('STORAGE_UNAVAILABLE')` on `compromised || torn`, a lifecycle
    other than recording/stopping, or `activation?.lost`.
  - `owns(c, b)` becomes `ownsCapture(c)` plus the `c.binding !== b` check, and
    its behavior is unchanged.
  - Verb response: `{v:1, ok:true, session_id, request_id, question_id, seq, duplicate}`.

The handler order matches `ask` steps 1–3 and 6 (`src/daemon.ts` around 1086).
It does **not** include the binding, generation, chat-target or connection
checks.

- [ ] **Step 1: Write failing tests:**
  - `record_question_exchange succeeds on a watch-only capture and appends exactly one event`.
    - Seed a real change through the fake platform so the context resolves.
    - Assert that the log diff is `[exchange_recorded]`, with no dispatch,
      binding, connection, attribution, or file-change event.
  - `record_question_exchange on a capture that is not recording is CAPTURE_NOT_READY`,
    and `on an unknown session is SESSION_NOT_SELECTED`.
  - `a 200 KiB answer round-trips byte-identical through the log and HTTP replay`.
    Use `withReader` or the HTTP event route.
  - `GET /v1/schemas/slipstream.question.exchange_recorded.v1 serves the schema`.
  - `a request over the control message cap fails PROTOCOL and appends nothing`.
    Use an answer of `MAX_MESSAGE_BYTES + 1` bytes.
  - `retry after daemon restart returns duplicate true with the original question_id`,
    using `withResumeDaemon`.
  - `detach while an exchange is in flight drains it`.
    - Hold the append with an injected slow log, call `detach`, and release
      the log.
    - The exchange either returns `ok` with its event in the log, or returns an
      error with no event. Detach completes after it settles.
  - `ask on a watch-only capture is still AGENT_NOT_CONNECTED`. This is a
    regression guard showing `ask` is unchanged.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `node --test src/daemon.test.ts`
  - Expected: the new tests FAIL with `unknown verb`.

- [ ] **Step 3: Implement** the handler, `ownsCapture`, the dispatch case, the
  comment, and the docs section.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `node --test src/daemon.test.ts src/agent-connection.test.ts src/answer-forwarder.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit.** Message: "Let the client save question threads it answered itself".

---

### Task 6: Full regression and plan status

**Files:**
- Modify: `IMPLEMENTATION_PLAN.md`. Set Stage C1.3 **Status** to
  `Complete — <commit range>`.

- [ ] **Step 1: Run every gate.**
  - Run: `npm run typecheck && npm test && npm run test:tools && npm run qa:check -- --all`
  - Expected: all pass, with no edits to pre-existing question, answer or
    daemon tests (`git diff develop --stat -- src/*question* src/answer* src/daemon.test.ts`
    shows only additions).

- [ ] **Step 2: Check the trust boundary.**
  - Run `grep -n "parent_session_id\|fork_session_id" src/*.ts`.
  - Expected: they appear only in `questions.ts` validation, the
    `public-events.ts` types, `session.ts` passthrough, and tests. They never
    appear in attribution, binding or transcript code.

- [ ] **Step 3: Commit.** Message: "Mark question-exchange recording complete".
