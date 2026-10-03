# Models

`capture_ignores` is an optional addition to the session-start payload:

- `version: 1` identifies the matching semantics. Other versions refuse recovery.
- `git: null` means the root is outside a Git worktree. Otherwise it contains
  `root_prefix`, `ignore_case`, the ordered rule `sources` (repository-relative
  `dir`, literal `text`) and capture-root-relative `tracked_exceptions`.
- `slipstreamignore` is the root file's text, or null when absent.

The policy is immutable for a capture. Recovery reads it from the public log.
Absent metadata means legacy built-in exclusions only. New captures resample
rules and tracked exceptions. Ignoring a path emits no fake deletion or gap.
The JSON policy is bounded to 512 KiB; an unreadable or excessive policy refuses
startup explicitly. Rule text is not truncated. Symlink rule files inside the
worktree refuse startup. Other capture and comparison limits are unchanged.

Only repository `.gitignore` files are copied. Git's external/global excludes
and `info/exclude` are deliberately outside this policy; Git configuration must
not direct capture to publish arbitrary external file contents. Independent
nested repositories retain capture scope under the outer rules, without loading
their own rules/index. Startup discovery checks a 10-second budget between IO
operations; this does not change capture debounce or comparison admission.
