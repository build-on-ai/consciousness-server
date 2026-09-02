#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
. ./lib_cgroup_teardown.sh

install_selftest_dropin control-group
collect_pids
stop_and_check_survivors

if [ "${#ALIVE[@]}" -ne 0 ]; then
  echo "FAIL: przeżyły PID-y: ${ALIVE[*]}"
  exit 1
fi
if [ "$CGROUP_GONE" -ne 1 ]; then
  echo "FAIL: cgroup nadal istnieje ($CGABS)"
  exit 1
fi

echo "PASS: cgroup pusty, żaden PID nie żyje — wnuk po setsid też."
