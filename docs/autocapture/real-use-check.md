# Workspace auto-capture: the real-use day

This is how to run the real-use check (the D8 verdict) and how to read it. It is
not a benchmark and nothing gates on it automatically. A person works normally
for a day and then reads the numbers against the pass bar.

## The pass bar

Quoted verbatim from the
[design spec](../superpowers/specs/2026-10-05-workspace-auto-capture-design.md):

> **Real-use check (P6, the D8 verdict).** Sixteen workspaces recording, with
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
3. Make sure 16 Conductor workspaces exist and aren't archived. `slipstream
   status` must show `captures: 16`, every one `state: recording`. Any
   `not_recording` row has a reason on it; fix that before starting.
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
| Sixteen workspaces recording, with linked chats | `slipstream status` at the start and the end of the day | 16 rows `state: recording`, with the chats you linked `connected` |
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

## Two checks of Conductor's order

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
  creating a new file that isn't in the repo. A file that existed before
  recording began appears as `file.baselined`; one created after appears as
  `file.changed` with no earlier content. So if the new file's first event is
  `file.baselined`, recording started after the agent created it, and its
  creation was recorded only as the starting state. That is honest but worth
  knowing. (Editing an existing file can't answer this: it is baselined either
  way.)
