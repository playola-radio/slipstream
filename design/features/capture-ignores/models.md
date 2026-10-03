# Models

`capture_ignores` is an optional addition to the session-start payload:

- `version: 1` identifies the matching semantics. Other versions refuse recovery.
- `git: null` means the root is outside a Git worktree. Otherwise it contains
  `root_prefix`, `ignore_case`, the ordered rule `sources` (`kind`, repository-relative
  `dir`, literal `text`) and capture-root-relative `tracked_exceptions`.
- `slipstreamignore` is the root file's text, or null when absent.

The policy is immutable for a capture. Recovery reads it from the public log.
Absent metadata means legacy built-in exclusions only. New captures resample
rules and tracked exceptions. Ignoring a path emits no fake deletion or gap.
The JSON policy is bounded to 512 KiB; an unreadable or excessive policy refuses
startup explicitly. Rule text is not truncated. Symlink rule files inside the
worktree refuse startup. Other capture and comparison limits are unchanged.
