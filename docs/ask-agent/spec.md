# Ask agent: select code and send a question

Status: approved owner UX transcribed; architecture and first implementation handoff under review. This document does not authorize an answer-display design.

## Authority and scope

Brian approved preparing this slice on 2026-09-25, supplied `/Users/brian/Documents/design/features/ask-agent/`, and required the implementer to follow it exactly. Four PNGs and `pen-nodes.json` are copied byte-for-byte under `design-source/`. The original folder remains authoritative for later owner revisions. Use the embedded interaction metadata as well as the images. The earlier suggested “save the current draft” behavior was withdrawn after reading that metadata; Brian confirmed disregarding that question.

Client baseline: `playola-radio/slipstream-client-swift`, `origin/develop` at `facdb953fd9b0b5aa7f822b9a2adf9c724b63adb`.
Daemon baseline: `briankeane/slipstream`, `origin/develop` at `0105465fa72eefd8f2697e857c5bcabce9b3bd38`.
Revalidate baselines before handing each PR to a fresh workspace. Never rename the orchestrator branch.

The outcome is selecting visible source lines, writing a question, and submitting it to the explicitly connected implementing agent. Receiving and displaying an answer is a later owner-designed slice. Delivery is cooperative at a subsequent agent tool call; it is not immediate interruption or idle wakeup.

## Product requirements

- **A1 — Exact ask UX.** Reproduce the selection highlight, connector, anchored composer, text styles, spacing, colors, borders, shadow, icons, labels, and saved-question menu from the supplied nodes. Closed modal `U3qs1P`, open modal `Q8o5Lh`; full-screen references `yDIp9` and `OY4ZN`. `design-values.md` extracts literal values; `ask-agent-interactions.md` retains interaction annotations. No generic sheet/popover/menu substituted for the drawn surfaces.
- **A2 — Selection.** Selecting one or more code lines in the stream opens the composer near the selection and clamps it to the visible workspace. Preserve the selection until dismissal. Anchor the connector to the selection boundary and nearest modal edge; selection and composer reposition together as the source scrolls. Escape, close, and Cancel dismiss. This slice starts on the existing stream, a location explicitly supported by the design. The full file/diff viewer shown in the backdrop has not been implemented and is not silently bundled into this slice.
- **A3 — Frozen source context.** Bind the draft to capture session, change sequence, relative path, immutable snapshot, and actual selected source line range/text. Later edits, card loads, or session switches cannot retarget an in-flight submission. Never substitute current working-tree bytes for the selected historical snapshot. Rendered cards expand tabs; transmitted source must preserve original text. Ellipses, truncation notices, absent content, and gaps between code blocks are not source lines.
- **A4 — Draft and send.** Start with an empty editable draft; the screenshot's question is example content. Disable Ask agent for an empty/whitespace-only draft. Submit question plus selected source context. Close only on a verified successful submission response. Keep draft and context on failure, including an unknown outcome after a lost response. Prevent duplicate button activations from creating separate submissions.
- **A5 — Saved questions.** Personal saved questions start with the two supplied options: “Why are you making this change?” and “Explain your thinking here, please.” Picking one only changes the selected preset. Append to question appends it to the textarea, separated by a newline when nonempty, preserves existing text, and moves the caret to the end. It never sends.
- **A6 — Add a saved question.** Add a question… opens an inline text input within this menu with Save and Cancel. Save trims text, requires nonempty text, persists it in personal saved questions, and selects it. It never appends or sends. Cancel preserves both the question draft and the previous preset selection. Use the surrounding menu's supplied values for this annotated state; do not introduce a separate dialog or management screen.
- **A7 — Same intended session.** Sending requires explicit connection to the intended main agent session. Neither matching workspace paths nor the presence of a change card establishes authorship. Another chat, another worktree, or a child agent must not consume the message. Unsupported or ambiguous identity must fail closed.
- **A8 — Harness/host independence.** Support Claude and Codex in both terminals and Conductor through their verified hook mechanism. No Conductor-only messaging API, replacement agent, agent launcher, implicit permission changes, or silent hook-trust bypass.
- **A9 — Replaceable client.** Sending and inspecting submission outcomes must have a documented daemon/command interface usable by an independent client. Preserve the daemon's public event/schema and GET-only reader invariants. Do not have the Swift UI manipulate the prototype's private files.
- **A10 — Honest completion.** Accepted/queued, hook emission, and a model answer are different facts. Success must state precisely which is acknowledged. No exactly-once-delivery claim. No unbounded waiting hidden behind a success state. Answer presentation is excluded even if QA observes a test reply artifact.

## Visual verification

Compare rendered closed/open composer states against both modal exports at matching logical size. Verify every extracted numeric/color/font value and supply screenshots under `.context/qa/`. Verify the selection anchor on a real stream card, scrolling and viewport-edge placement. The four exports do not authorize rebuilding the whole surrounding application. Record any visual discrepancy; do not repeat the previous feed's font-weight exception in this new feature without owner direction.

## Existing implementation constraints

The client uses `@Observable @MainActor` page models, dependency clients, Swift Testing, and zero business logic in views. Follow its CLAUDE.md and relevant Point-Free skills. `CodeLine.text` is presentation-normalized; use the recorded snapshot for sending. Card identities are `Seq` within a capture session. Clip blocks may omit intervening lines and may be truncated.

The daemon already has an owner-only Unix control socket, explicit attached harness/session/worktree identity, serialized capture operations, durable events/CAS, a token-authenticated public reader, and a QA harness. Reuse those boundaries when designing transport. `serve` and shared `start`/`attach` modes differ; state explicitly which supports sending. Do not expand capture semantics or claim all observed edits belong to the connected agent.

## Acceptance evidence required before shipping

1. Unit/model tests cover A2–A7 with dependencies and clocks controlled; no tests of view business logic or real sleeps in model tests.
2. Client and daemon wire names, error envelopes, retry identity, and source context are traced end-to-end in real code.
3. A disposable live daemon accepts a submission from an independent client; the intended main agent receives it and an unintended session does not.
4. Repeat live delivery for Claude/Codex × terminal/Conductor using startup hooks and ordinary trust setup; never use the real ~/.slipstream.
5. Repeated hooks, ambiguous response loss, daemon restart, session replacement, and concurrent callers preserve the declared semantics. These are not proved by the earlier single-message experiment.
6. Existing touched-area suites and cumulative daemon QA pass. Orchestrator independently verifies each merged PR before the next dependent handoff; owner merges.

## Deferred work

Receiving-answer UX, general chat history, change instructions, a full file/diff viewer, interface/caller graphs, database diagrams, TUI, idle-agent wakeup, and retrofit into arbitrary running sessions. The previously reported intermittent feed rendering bug and expected-disconnect logging fix remain separately tracked.
