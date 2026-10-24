# Workspace auto-capture: release acceptance (daemon half)

Each acceptance requirement in the
[design spec](../superpowers/specs/2026-10-05-workspace-auto-capture-design.md#pr-graph)
("Acceptance requirements"), with the tests that prove it. Every named test was
run for this table, in `npm test`, on 2026-10-19. Rows that no test can prove
say so.

The native app's half (P6a) and the real-use day are not proven here. Neither is
marked done.

Files: `A` = `src/autocapture-acceptance.test.ts`,
`D` = `src/daemon.test.ts`, `R` = `src/daemon-recovery.test.ts`,
`M` = `src/daemon-maintenance.test.ts`, `C` = `src/cli.test.ts`,
`W` = `src/attach-workflow.test.ts`.

| Requirement | Proven by | Status |
|---|---|---|
| Flip between at least two native-app workspaces and Ask Agent in each; only the intended chat receives and answers each question | A `delivers each workspace's question only to that workspace's chat, which alone can answer it` (a question asked in each of two workspaces; each chat receives only its own, the other chat's answer is refused, each session holds only its own answer); D `routes tasks, questions and answers by chat identity across captures`; A `traces Conductor setup, the Codex refusal, a Claude attach, a setup check, and Ask Agent through to both readers` (a real `slipstream ask` goes to one workspace; the same chat calling back from the other workspace and a different chat in the same workspace get nothing; the answer lands in that session only) | Daemon half covered. The native-app flip is P6a. |
| Restart the daemon: both captures resume; both bindings show pending; each reconnects after its own next eligible callback and answer | R `restores each link pending, and each reconnects only through its own chat`; R `resumes every running capture under its own session id, disclosing the restart` | Covered |
| Repeat through GC quiescence; stale checks cannot connect a new activation | M `stops every capture for maintenance, sweeps, then resumes each under its own id with linked chats pending`; A `lets no setup check issued before gc connect either chat after it; each connects only through a new check of its own` (both chats; each pre-gc check refused with `QUESTION_NOT_FOUND`; the new check ids differ; a cross-chat answer is refused) | Covered |
| Cross-chat answers | D `routes tasks, questions and answers by chat identity across captures`; D `accepts the setup check only from the bound chat`; R `restores each link pending, and each reconnects only through its own chat`; A gc test above | Covered |
| Subagent callbacks | D ``attaches only to the verified Claude ${version}/${entrypoint} root and lets only that root claim once``; D `binds a Codex root transcript and refuses child, other chat, Claude, or absent identity claims`; D `routes tasks, questions and answers by chat identity across captures`; A `never offers a setup check to a subagent callback, and a refused one does not use up the root chat's offer` | Covered for callbacks (claims). An *answer* through the MCP tool cannot tell a subagent from its root chat; the daemon says so in `answerQuestion`'s comment. |
| Unlink/relink races | D `fences an unlinked chat: its old setup check and generation are refused after a relink`; D `does not acknowledge a task to a chat unlinked while it was being recorded`; A `settles a concurrent unlink and relink of one chat into a single consistent link` | Covered |
| Concurrent attempts for the tenth slot | D `gives the tenth chat slot to exactly one of two racing chats` | Covered |
| Same-id chat resume | D `reports the same capture when the same chat attaches again, re-arming a pending check`; C `starts a stopped daemon, records once, and reuses the capture on a repeat` | Covered |
| New-chat refusal | D `refuses another chat in the same workspace with BINDING_EXISTS and keeps the existing link` | Covered |
| Missing transcripts | R `keeps a link whose transcript vanished as unavailable, holding its slot, until the chat attaches again`; R `reconnects a link whose transcript comes back, without the chat attaching again`; W `refuses when the chat transcript cannot be found` ; A `reads a link whose transcript vanished as unavailable to both readers` and A `reads a link whose Codex version changed as unavailable to both readers` (a Codex link after a restart: `transcript-missing` and `identity-changed`, the same in `/v1/captures` and the offline fold) | Covered |
| Archive during recovery | R `honors an archive recorded while no daemon ran: not resumed, and the stop is not backfilled`; R `stops a capture with reason archived when the archive reaches a running daemon`; M `lets a detach during gc withdraw its capture, which then stays stopped`; A `honors an archive that arrives while a restarted capture is still failing to resume` (no further start attempt, the log untouched, the chat unlinked, shown as `not_recording`/`stop-unconfirmed` rather than cleanly stopped) | Covered |
| Lost setup-check responses | R `offers an unanswered setup check again after its throttle`; D `starts a bound capture setup-pending and refuses questions until the setup check returns`; A `connects a chat exactly once when its setup-check answer is lost and it answers the re-offered check` | Covered |
| Failed setup stays visible | D `does not report a failed baseline as cleanly stopped after detach`; R `retries a transient start failure with backoff and shows when it will retry`; A `stays visible while failed, and the retry baselines current bytes without presenting earlier edits as history` (`baseline-failed` with its retry time in `status`, `/v1/captures` and the offline fold; the failure message appears in `status` only, since `/v1/captures` carries no message) | Covered |
| Later readiness baselines current bytes without presenting earlier edits as captured history | A `stays visible while failed, and the retry baselines current bytes without presenting earlier edits as history` (a file edited and a file created while failing appear only as `file.baselined` with the current bytes' hash; zero `file.changed`) | Covered |
| Public-reader parity | A `agree on capture and binding states as the table fills, a slot frees, a heartbeat goes stale, and a transcript goes missing` (`/v1/captures` equals an independent fold of `control/intent.json`, the session logs and the heartbeats, for `recording`, `capture-limit-reached`, `stopped`/`detached`, `queued` and `daemon-unavailable` as heartbeats go stale, and chats `setup_pending`, `connected`, `unlinked` and `unavailable`; the `status` verb shows the same states); A `reads as baselining to both readers until its baseline finishes`; A `reads as queued to both readers while the daemon holds the store`; A `reads as daemon-unavailable to both readers once the store heartbeat goes stale, and with the daemon gone`; A `reads a restarted capture still waiting to resume as queued to both readers`; A `read root-missing, watcher-failed and storage-unavailable the same to both readers` (including recovery back to `recording`); A `keeps showing a recovered outage to both readers while the intent record cannot be written`; A `reads a chat connected before the restart as setup pending to both readers while its capture waits to resume`; A `reads a connected chat as setup pending to both readers once its session heartbeat goes stale under a live daemon`; the two Codex tests above; D `lets independent readers follow each capture and lists every capture` | Covered |
| Native parity | none | P6a (native client), not this PR |
| Real-use overhead check at 16 captures with linked chats (the D8 verdict) | none; [real-use-check.md](real-use-check.md) is the runbook | Real-use day, not run |
| The 17th workspace is visibly NOT recording (`capture-limit-reached`) | D `holds a seventeenth workspace waiting and starts the oldest waiting one when a slot frees`; A `agree on capture and binding states …` (in `status`, `/v1/captures` and the fold) | Covered |
| … and starts automatically when a slot frees | D `holds a seventeenth workspace waiting and starts the oldest waiting one when a slot frees`; R `keeps waiting captures waiting across a restart and promotes them in admission order`; A `agree on capture and binding states …` | Covered |
| Trace CLI → control → session/log → reader → Ask Agent end to end | A `traces Conductor setup, …` (spawned daemon, real watcher, `conductor setup`, `slipstream attach`, the hook and answer-tool commands exactly as `attach` installed them, `slipstream ask`, `/v1/sessions/:id/events` equal to the log on disk) | Covered |
| Exercise both independent readers | A `agree on capture and binding states …` and A `traces Conductor setup, …` (`/v1/captures` against the offline fold at every step) | Covered |
| The existing Conductor Claude attach workflow | A `traces Conductor setup, …` (`slipstream attach` from a Conductor chat links to the capture `conductor setup` started: same session, setup pending, then connected); C `records the workspace on setup, stops it as archived on archive, and archives an unknown one quietly` | Covered |
| Codex's unsupported version stays an explicit refusal | A `traces Conductor setup, …` (Codex 0.156.1, the version Conductor bundles: exit 1, "not a runtime Slipstream has verified … nothing was installed or recorded", no Codex config written, no link); D `binds a Codex root transcript and refuses child, other chat, Claude, or absent identity claims`; W `refuses an unverified runtime honestly, with nothing installed or recorded` | Covered |

## Uncovered

- **Native-app flip and native parity**: P6a.
- **The real-use day (D8 verdict)**: not run; see [real-use-check.md](real-use-check.md).

## Known gap: Conductor starts the agent before setup finishes

Edits the agent makes before the first starting state is read appear as that
starting state (`file.baselined`), not as changes. Accepted as is: no hook, no
second capture source, no wait. The timings observed on 2026-10-18 are in the
README ("Capture every Conductor workspace").

## Found while testing

Product code changed in P6d; each change was a test seen failing first.

- **A queued capture read differently to the two readers** (fixed in P6d). While
  a capture waited for the one baseline slot, or after a restart waited to
  resume, `/v1/captures` said `queued` but a reader applying contracts §6 to the
  files saw `not_recording`/`daemon-unavailable`: it had no session `owner.lock`
  yet. Contracts §6 rules 6–8 and §7 now use the store's `owner.lock` heartbeat
  for a running capture with no live session owner: live → `queued`, stale →
  `daemon-unavailable` (Brian, 2026-10-18 and 2026-10-19). No new lock file and
  no new on-disk state.
- **Who holds the store's `owner.lock`** (audited in P6d; the holders are listed
  in contracts §7). Standalone `watch`/`serve` pointed at a daemon's store
  could have made a waiting capture read `queued`; they now refuse a store that
  has `control/intent.json`.
- **A chat connected before a restart read `connected` offline while its
  capture waited to resume** (fixed in P6d). The daemon shows it
  `setup_pending`; the fold took `connected` from the previous activation. A
  capture read `queued` under §6 rule 7 has no current activation, so both
  readers now read a connected binding there as `setup_pending`, including the
  daemon when a live capture's session heartbeat goes stale.
- **A store failing mid-recording read as `recording` offline** (fixed in P6d).
  The daemon showed `storage-unavailable` from the session's live health but
  wrote nothing to disk. It now records the outage as the capture's
  `last_failure` in the intent record and clears it when the session recovers,
  unless the capture is already stopping or the clear cannot be written (then
  both readers keep showing the outage). If the intent record cannot be written
  when the outage begins, an offline reader cannot see it; the session's
  `capture.gap{storage}` appended on recovery discloses it. A clear whose file
  was renamed into place but whose directory sync then failed reads `recording`
  offline while the daemon still shows the outage, until the daemon restarts;
  that errs toward showing less coverage, and is left as is.
- **The daemon is a moment ahead of the files.** When a capture fails or starts
  baselining, `/v1/captures` and `status` show it a few milliseconds before the
  intent record, heartbeat or `session.started` that let an offline reader see
  it. The readers then agree. The parity tests compare once the files catch up.
- **Right after gc, a linked chat's callback can read `SESSION_NOT_SELECTED`**
  for a moment while its link is being re-published. The hook calls again on
  the next tool call, so nothing is lost.
