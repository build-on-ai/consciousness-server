#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
. ./lib_cgroup_teardown.sh

install_selftest_dropin process
collect_pids
stop_and_check_survivors

status=0
if [ "${#ALIVE[@]}" -eq 0 ] && [ "$CGROUP_GONE" -eq 1 ]; then
  echo "FAIL (meta): KillMode=process nie zostawiło niczego przy życiu —"
  echo "  cgroup_teardown_test.sh nie mierzy właściwości, którą deklaruje."
  status=1
else
  echo "PASS: KillMode=process zostawił przy życiu: ${ALIVE[*]:-brak PID-ów, ale cgroup ($CGABS) też przeżył} — dokładnie tego oczekujemy od trybu, który nie rozgłasza do cgroup."
fi

for p in "${ALIVE[@]:-}"; do
  [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
done
systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true

exit "$status"
