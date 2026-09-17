# live-feed

A standalone terminal viewer for a Slipstream capture log. It tails the public
artifact — `<store>/sessions/<session_id>/events.jsonl` — and pretty-prints each
file change as a scrolling colored line:

```
HH:MM:SS path <before>B → <after>B [new|deleted|modified]
```

Capture gaps are shown as dim `⚠ gap: <reason>` lines so coverage gaps stay
visible (the log never hides a gap, and neither does this viewer).

It reads only the on-disk JSONL log — no daemon back channel, no core `src/`
imports. Delete it and the capture is unaffected.

## Usage

In one terminal, run a capture:

```bash
npm run slipstream -- watch <dir>
```

In a second terminal, follow it:

```bash
npm run live-feed -- <dir>
# or point straight at a log:
npm run live-feed -- --log <dir>/.slipstream/sessions/<id>/events.jsonl
```

With no `--log`, the newest `events.jsonl` under `<store>/sessions/` is followed
(`<store>` defaults to `<dir>/.slipstream`). Existing history is printed first,
then new records as they arrive.

### Options

| Option | Meaning |
| --- | --- |
| `<dir>` | worktree whose `.slipstream` store to search (default: cwd) |
| `--store <dir>` | store dir to search (default: `<dir>/.slipstream`) |
| `--log <path>` | tail this `events.jsonl` directly, skipping discovery |
| `--no-color` / `--color` | force color off / on (default: on when stdout is a TTY and `NO_COLOR` is unset) |
| `-h`, `--help` | show help |

## What it shows

- **new** (green): the file was absent before and present after.
- **deleted** (red): present before, absent after.
- **modified** (yellow): content changed on both sides.
- Sizes are bytes straight from the record. There is no line count in the log,
  so only byte deltas are shown. Unavailable content shows `—`, never a fake
  size. A state whose prior baseline was never observed is reported as
  `modified`, never upgraded to a confident `new`.

## Known limitation

The viewer follows the log by polling its size. If a capture restart truncates
the log and regrows it past the follower's read offset **within a single poll
interval** (so the shrink is never observed), the viewer can splice a stale
partial line onto new bytes and print a `⚠ unparseable log line` — it never
silently drops the gap, but that one boundary record may show as malformed.
After restarting a capture, restart the viewer for a clean view.

## Tests

```bash
npm run test:tools
```

The record classification and line formatting are pure functions and carry the
tests; the tail loop is intentionally thin.
