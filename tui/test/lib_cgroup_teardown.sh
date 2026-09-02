#!/usr/bin/env bash

set -euo pipefail

UNIT="boa-agent@selftest"

REAL_HOME="$(systemctl --user show-environment | sed -n 's/^HOME=//p')"
DROPIN_DIR="${REAL_HOME}/.config/systemd/user/${UNIT}.service.d"

install_selftest_dropin() {
  local killmode="$1"
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  mkdir -p "$DROPIN_DIR"
  cat > "$DROPIN_DIR/override.conf" <<EOF
[Service]
ExecStart=
ExecStart=${repo_root}/tui/bin/boa-runner --role selftest --core \${BOA_CORE} --selftest
KillMode=
KillMode=${killmode}
EOF
  systemctl --user daemon-reload
}

collect_pids() {
  systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  systemctl --user start "$UNIT"

  sleep 3

  local cgrel cgabs
  cgrel=$(systemctl --user show -p ControlGroup --value "$UNIT")
  cgabs="/sys/fs/cgroup${cgrel}"
  CGABS="$cgabs"

  if [ ! -e "$cgabs/cgroup.procs" ]; then
    echo "FAIL: brak $cgabs/cgroup.procs — jednostka nie wystartowała jak trzeba?" >&2
    return 1
  fi
  mapfile -t PIDS < "$cgabs/cgroup.procs"
  echo "PID-y w cgroup: ${PIDS[*]}" >&2

  if [ "${#PIDS[@]}" -lt 3 ]; then
    echo "FAIL: <3 PID-ów, wnuk nie wpadł do cgroup?" >&2
    return 1
  fi
}

stop_and_check_survivors() {
  systemctl --user stop "$UNIT"

  for _ in $(seq 1 60); do [ -e "$CGABS" ] || break; sleep 0.25; done

  ALIVE=()
  for p in "${PIDS[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      ALIVE+=("$p")
    fi
  done

  CGROUP_GONE=1
  if [ -e "$CGABS" ]; then
    CGROUP_GONE=0
  fi
}
