# Ask-agent interaction annotations

Verbatim interaction metadata from the owner-supplied pen-nodes.json. These settle behavior not visible in the PNGs.

## Hideable task activity feed

Node: `t9gGA`

Hide with Hide feed; restore with Activity in the right editor toolbar. Feed scrolls independently in the implemented app.

## Task 1 sticky heading

Node: `YU323`

Shown pinned at the top of the feed. Keeps full task name visible.

## Task 2 sticky heading

Node: `TikcY`

Shown inline in chronology. Replaces Task 1 at the feed's sticky boundary.

## Full file editor

Node: `q8jIky`

Double-clicking a feed snippet opens its full file in a new tab, or focuses the existing tab, and reveals the clicked lines. Diff toggle switches between full current file and current-left/previous-right diff.

## user.ts independent diff pane

Node: `wd42b`

Double-click a feed snippet to open or focus its file tab in the active pane. Diff is independently toggleable. Unchanged code sections can be expanded.

## Diff / Plain view toggle

Node: `gL4s5`

Independent view mode for this pane. Diff shows current code on the left and marked-up previous code on the right. Plain shows the full current file in one editor without diff colors or deletion markup. Preserve active file, scroll position and selection when switching.

## Question-first modal · connected to selection

Node: `U3qs1P`

Opens after highlighting one or more lines in either stream or diff. Anchor near selection, clamp to viewport. Retain selection until dismissed. Escape or close dismisses; asking sends selected text, file/version or stream task context, and the question to the LLM.

## Ask agent button

Node: `qKwUC`

Send the nonempty question with the selected source context. Disable for an empty or whitespace-only draft. Close composer after successful submission; preserve draft if submission fails.

## Append to question button

Node: `QMQQp`

Append the selected saved question to the textarea, separated by a newline if nonempty. Preserve existing text and place the caret at the end. Does not send.

## Add a saved question

Node: `CwQ8b`

Add a question… opens an inline text input in this menu with Save and Cancel. Save nonempty trimmed text to personal saved questions and select it; never append or send automatically. Cancel preserves the draft and previous selection.

## Selection-to-question visual connector

Node: `JZODm`

Anchor the connector to the active selection boundary and the nearest modal edge. Reposition together when the source scrolls; clamp modal to visible workspace.
