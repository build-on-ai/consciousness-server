#!/bin/bash
set -u

PORTS() { "$(dirname "$0")/../lib/ports.py" "$@"; }

CS_URL="${CS_URL:-http://127.0.0.1:$(PORTS consciousness-server 3032)}"

REDIS_HOST_PORT="$(PORTS redis 6380)"
TIMEOUT=3
OUTPUT_FORMAT="${1:-table}"   # table | json | prom

declare -A checks=(
  [consciousness]="$CS_URL/health"
  [semantic-search]="http://127.0.0.1:$(PORTS semantic-search 3037)/health"
  [machines]="http://127.0.0.1:$(PORTS machines-server 3038)/health"
  [key-server]="http://127.0.0.1:$(PORTS key-server 3040)/health"
  [redis]="redis-ping"
  [ollama]="http://127.0.0.1:11434/api/tags"
)

declare -a order=(
  consciousness
  semantic-search machines key-server
  redis ollama
)

declare -A results

ts=$(date -Iseconds)
pass=0; fail=0

for name in "${order[@]}"; do
  target="${checks[$name]}"
  if [ "$target" = "redis-ping" ]; then
    if command -v redis-cli >/dev/null 2>&1; then
      reply=$(timeout $TIMEOUT redis-cli -h 127.0.0.1 -p "$REDIS_HOST_PORT" PING 2>/dev/null || echo "")
      [ "$reply" = "PONG" ] && results[$name]="OK" || results[$name]="FAIL"
    else
      (echo > "/dev/tcp/127.0.0.1/$REDIS_HOST_PORT") >/dev/null 2>&1 && results[$name]="OK" || results[$name]="FAIL"
    fi
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" -m $TIMEOUT "$target" 2>/dev/null)
    code="${code:-000}"
    if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 400 ] 2>/dev/null; then
      results[$name]="OK"
    else
      results[$name]="FAIL($code)"
    fi
  fi
  if [[ "${results[$name]}" == OK* ]]; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
  fi
done

case "$OUTPUT_FORMAT" in
  json)
    printf {timestamp:%s,pass:%d,fail:%d,checks:{ "$ts" "$pass" "$fail"
    first=1
    for name in "${order[@]}"; do
      [ $first -eq 0 ] && printf ","
      printf "\"%s\":\"%s\"" "$name" "${results[$name]}"
      first=0
    done
    printf "}}\n"
    ;;
  prom)
    for name in "${order[@]}"; do
      val=0; [[ "${results[$name]}" == OK* ]] && val=1
      echo "ecosystem_block_up{block=\"$name\"} $val"
    done
    ;;
  *)
    printf "=== Ecosystem Health Matrix %s ===\n" "$ts"
    for name in "${order[@]}"; do
      status="${results[$name]}"
      if [[ "$status" == OK* ]]; then
        printf "  %-22s \xE2\x9C\x93 %s\n" "$name" "$status"
      else
        printf "  %-22s \xE2\x9C\x97 %s\n" "$name" "$status"
      fi
    done
    printf "\nTotal: %d OK / %d FAIL\n" "$pass" "$fail"
    ;;
esac

if [ "$fail" -gt 0 ] && [ "$OUTPUT_FORMAT" = "table" ] && [ -z "${TERM:-}" -o "${TERM}" = "dumb" ]; then
  failed_list=""
  for name in "${order[@]}"; do
    [[ "${results[$name]}" != OK* ]] && failed_list="$failed_list $name=${results[$name]}"
  done
  curl -s -m 5 -X POST "$CS_URL/api/logs/append" \
    -H "Content-Type: application/json" \
    -d "{\"project\":\"ecosystem\",\"agent\":\"monitor\",\"level\":\"WARN\",\"message\":\"Health matrix: $fail block(s) down:$failed_list\"}" \
    >/dev/null 2>&1 || true
fi

exit 0
