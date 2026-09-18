---
name: slipstream-begin-task
description: Use when you start a distinct new task or piece of work in a session — before you begin making the file changes for it — to group those upcoming changes under a titled task in the Slipstream feed. Applies in any harness (Claude Code, Codex, or another) that has the Slipstream MCP server configured.
---

# Declaring a task to Slipstream

Slipstream shows a human a live feed of the file changes happening in this
worktree. On its own it sees *states of files*, grouped only by time. When you
tell it what you are about to work on, it can group the changes you then make
under that task — which makes the feed legible instead of an undifferentiated
stream of edits.

## When to use this

Call the `slipstream_begin_task` tool **once, right before you start a distinct
piece of work** — a bug fix, a feature, a refactor, answering a specific
request. Declare the task *before* you make its file changes, not after.

Start a **new** declaration whenever you move on to a genuinely different task.
Each declaration marks the start of its own group; a second task is never a
retry of the first.

Do **not** call it for every individual edit, and do not re-call it to "resume"
a task you already declared — one declaration per task is enough.

## How to use it

Call the tool with a short, human-readable title describing the work:

```
slipstream_begin_task(title: "Fix the off-by-one in the pagination cursor")
```

A good title is the kind of one-line summary you would put in a commit subject:
concrete and specific ("Add retry to the upload client"), not vague ("changes"
or "work"). Then do the work as usual — the changes you make are grouped under
the task automatically; you do not call anything again to "end" it.

## Reading the result

On success the tool returns identifiers for the task it recorded
(`session_id`, `task_id`, `event_id`, `seq`). You do not need to act on these;
they confirm the declaration was committed.

If the tool returns an **error**, read it — it is telling you the truth about
what happened, and each case wants a different response:

- **`DAEMON_UNAVAILABLE`** — Slipstream is not running for this worktree. This is
  not a failure of your work; just proceed. Declaring a task is best-effort
  grouping, never a prerequisite for doing the work.
- **`SESSION_NOT_SELECTED`** — Slipstream is running but is not currently
  watching this worktree, so it cannot attribute the task here. Proceed with the
  work; a human controls which worktree is being watched.
- **`INVALID_TITLE`** — the title was empty or unusable. Retry once with a real,
  descriptive title.
- **`OUTCOME_UNKNOWN`** — the declaration reached Slipstream but its outcome
  could not be confirmed. **Do not call the tool again for this same task.** A
  fresh call would create a *second* task, not retry the first. Just continue
  the work.

In every case: a task declaration is an aid to the human watching the feed. It
never blocks, gates, or changes the actual work you do.
