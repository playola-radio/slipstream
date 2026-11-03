# Workspace auto-capture: the real-use day

This is how to run the real-use check (the D8 verdict) and how to read it. It is
not a benchmark and nothing gates on it automatically. A person works normally
for a day and then reads the numbers against the pass bar.

## The pass bar

Quoted verbatim from the
[design spec](../superpowers/specs/2026-10-05-workspace-auto-capture-design.md):

> **Real-use check (P6, the D8 verdict).** Thirty-two workspaces (the D10 limit) recording, with
> linked chats, for a working day of normal use: the daemon's idle CPU stays at or
> under 1% of one core on average, its memory stays at or under 512 MiB with no
> sustained growth, and no change is lost (no unexplained gap, zero watcher
> subscription failures). A miss is written up with numbers and stops the work
> (CLAUDE.md).

## Before the day

1. Install the Slipstream build being released, so `slipstream` on your PATH is
   that build.
2. Run `slipstream conductor install` (its `Slipstream:` line shows the version
   the daemon now runs), then `slipstream conductor enroll`.
3. Make sure 32 intended Conductor workspace rows are `state: recording` in
   `slipstream status`; retained or archived capture history does not count.
   Any intended `not_recording` row has a reason on it; fix that before starting.
4. Link a chat in as many of them as you will use; at most 10 can be linked.
   In each chat, ask the agent to run `slipstream attach`, then send the chat
   one more message. `slipstream status` shows that workspace's chat as
   `connected`, and `linked_chats:` counts them.
5. Note the time the day starts.

## During the day

From a checkout of this repo, leave the sampler running in a terminal:

```sh
node tools/real-use-sample.ts --out ~/slipstream-real-use-$(date +%F).ndjson
```

Every 60 seconds it appends one line: the daemon's process id, its total CPU
time and memory (from `ps`), and the total size of the session logs. Add
`--store <dir>` if your store isn't `~/.slipstream`, or `--interval <seconds>`
to sample at a different interval. It reads only those numbers, never file
contents.

Then work normally in those workspaces, with their chats, for the day. Don't
restart the daemon or run `slipstream gc`. If something does restart it, carry
on and note why.

## After the day

Stop the sampler (Ctrl-C), then:

```sh
node tools/real-use-sample.ts --summary ~/slipstream-real-use-$(date +%F).ndjson
grep -E "is not recording|stopped:|watcher" ~/Library/Logs/slipstream/daemon.log
slipstream status
```

Pass `--summary` the same `--store` you sampled with. If it can't read the
store's sessions folder or a session log, it fails rather than reporting zero
gaps.

The summary prints:

| Field | Meaning |
|---|---|
| `hours` | Time from the first sample to the last. |
| `samples` | How many samples were taken. |
| `max_gap_s` | The longest time between two samples, in seconds. Much more than the interval means the sampler missed part of the day (a sleeping Mac, a failed sample); the averages say nothing about that stretch. |
| `cpu_pct_idle` | Average CPU, as a percentage of one core, over the intervals in which no session log grew. This is the idle CPU in the bar. |
| `cpu_pct_all` | Average CPU over the whole day, idle or not. For context only. |
| `idle_intervals` | How many intervals `cpu_pct_idle` averages. |
| `rss_max_mib` | The largest memory sample, in MiB. |
| `rss_first_quarter_mib`, `rss_last_quarter_mib` | Average memory over the first and last quarter of the samples. |
| `daemon_restarts` | Times the daemon's process id changed. The interval across each restart is left out of the averages. |
| `gaps` | `capture.gap` events in the sampled window, counted by reason, across every session. |
| `stops` | `capture.stopped` events in the sampled window, counted by reason. |

## Reading the verdict

Each part of the bar, and the numbers that answer it:

| Part of the bar | Read | Pass when |
|---|---|---|
| Thirty-two workspaces recording, with linked chats | `slipstream status` at the start and the end of the day | 32 rows `state: recording`, with the chats you linked `connected` |
| A working day of normal use | `hours`, `max_gap_s`; your own account of the day | You judge it a normal working day, and `max_gap_s` shows no long unsampled stretch |
| Idle CPU at or under 1% of one core on average | `cpu_pct_idle` | ≤ 1 |
| Memory at or under 512 MiB | `rss_max_mib` | ≤ 512 |
| No sustained growth | `rss_first_quarter_mib` against `rss_last_quarter_mib`, and the `rss_kib` column in the samples | Memory levels off rather than climbing through the day |
| No unexplained gap | `gaps` | Every gap has a cause you can name. A `restart` gap follows a daemon restart; check it matches `daemon_restarts` and the reason you noted. A `watcher-error` or `storage` gap means changes may have been missed. |
| Zero watcher subscription failures | `stops` and the daemon log | No `watcher-failed` stop and no "the watcher stopped delivering changes" line |

`root-missing` or `archived` stops are workspaces you deleted or archived, not
lost changes, but each should match something you did.

A miss on any part is written up with the numbers above and stops the work. The
verdict is recorded with the P6 closeout, not in this file.

## Recorded runs

**2026-11-03, 32 captures (recording controls, PR 1).** Agent-run on a disposable
store (`npm run qa:daemon`), not a person's working day, so the "working day"
part of the bar is not established by this run. 31 clones of this repo plus the
QA sandbox were recording (32/32), with 10 chats linked and `connected`. A 33rd
attach was refused with `CAPTURE_LIMIT_REACHED: 32/32 capture slots in use. This
workspace is NOT recording. Pause one first.` A script edited, created and
deleted files in 12 of the workspaces and appended to the chat transcripts for
4 minutes, then idled for 3, sampling every 15 s.

The Mac went to sleep on battery from 21:31 to 21:42 UTC during the first
window, so a second window was run under `caffeinate` against the same daemon
(no restart). That one ended early, after 15 minutes, when the system file table
filled (`ENFILE`). Two macOS Virtualization VMs held about 230,000 files; the
daemon held 55. Recording was not affected.

| | First window | Second window |
|---|---|---|
| `hours` | 0.619 (about 0.4 awake) | 0.25 |
| `samples` / `max_gap_s` | 95 / 684.8 (the sleep) | 60 / 30.0 |
| `cpu_pct_idle` (`idle_intervals`) | 0.281 (32) | 0.291 (22) |
| `cpu_pct_all` | 1.498 (includes baselining 32 workspaces) | 0.413 |
| `rss_max_mib` | 159.1 (during baselining) | 74.4 |
| `rss_first_quarter_mib` → `rss_last_quarter_mib` | 132.1 → 69.5 | 72.2 → 69.0 |
| `daemon_restarts` | 0 | 0 |
| `gaps` / `stops` | none / none | none / none |

The daemon log had no "is not recording", "stopped:" or watcher lines. At the
end, all 32 rows were `state: recording` with 10/10 chats linked, and no session
log held a `capture.gap` or `capture.stopped` event. Every measured part of the
bar passes: idle CPU 0.29% of one core or less (bar ≤ 1), at most 159 MiB of
memory (bar ≤ 512) settling at about 69 MiB with no growth, no gaps, and no
watcher failures. A person's working day at 32 has not been run.

## Two checks of Conductor's order

**Known gap.** Conductor starts the agent before setup finishes (timings in the
README). Edits made before the first starting state is read appear as that
starting state, not as changes. This is accepted; Slipstream adds no hook, no
second capture source and no wait to close it, so the First edit check below
records what happens rather than a pass or fail.

Conductor's launch order was observed on 2026-10-18 (README, "Capture every
Conductor workspace"). It starts the agent without waiting for setup, and it
removes an archived workspace's folder. Two things were not observed directly.
Check them after the day's samples are summarized, in this order (the archive
frees the slot the new workspace needs):

- **Archive.** Archive one workspace you no longer need. Its capture must end
  with `state: stopped (archived)` in `slipstream status <session_id>`, not
  `root-missing`. `root-missing` means Conductor removed the folder before
  Slipstream's archive step stopped the capture.
- **First edit.** Create one new workspace and have its agent's first action be
  creating a new file that isn't in the repo, then look at that file's first
  event. `file.baselined` means the file already existed when its folder was
  read for the starting state, so recording started after the agent created
  it, and its creation was recorded only as the starting state. That is honest
  but worth knowing. `file.changed` does not settle it: a file created while
  the starting state was still being read, after its folder had been read,
  also appears as `file.changed`, even after `capture.ready`. So
  `file.changed` means only that this check was inconclusive; note it as such.
  (Editing an existing file can't answer this: it is baselined either way.)
