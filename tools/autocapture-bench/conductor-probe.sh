#!/bin/sh
# Conductor launch-behavior probe (P1, documentation only). Run BY CONDUCTOR as a
# setup or archive script, never by Slipstream. It changes nothing: it logs when it
# started, where it ran, which Conductor variables it saw, sleeps, logs when it
# ended, and exits with the requested status.
#
# Usage (as a Conductor script command):
#   /abs/path/conductor-probe.sh <label> [sleep-seconds] [exit-status]
#   label         which settings layer configured this run, e.g. user or repo-local
#   sleep-seconds default 60
#   exit-status   default 0; use 3 to test how a failed setup is shown
#
# Logs go to ~/slipstream-conductor-probe/, one file per run. Only CONDUCTOR_*
# variable values are written; every other variable is recorded by name only, so
# no secret from the environment reaches the log.
set -u

label=${1:-unlabeled}
sleep_s=${2:-60}
status=${3:-0}
dir="$HOME/slipstream-conductor-probe"
mkdir -p "$dir"
log="$dir/$(date -u +%Y%m%dT%H%M%SZ)-$label-$$.log"

stamp() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

{
  echo "label=$label"
  echo "started=$(stamp)"
  echo "pid=$$ ppid=$PPID"
  echo "pwd=$(pwd -P)"
  echo "sleep_s=$sleep_s exit_status=$status"
  echo "--- CONDUCTOR_* values"
  env | grep '^CONDUCTOR_' | sort
  echo "--- all variable names"
  env | sed 's/=.*//' | sort | tr '\n' ' '
  echo
} >"$log"

i=0
while [ "$i" -lt "$sleep_s" ]; do
  sleep 1
  i=$((i + 1))
  if [ $((i % 10)) -eq 0 ]; then echo "tick=$i at=$(stamp)" >>"$log"; fi
done

echo "ended=$(stamp) exit=$status" >>"$log"
echo "slipstream conductor probe: label=$label slept ${sleep_s}s, exiting $status (log: $log)"
exit "$status"
