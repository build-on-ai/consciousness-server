#!/bin/bash
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH="$HERE/memory_search.py"
LOG="${RECALL_LOG:-$HOME/.cache/cs-recall/hook.log}"
MIN_LEN="${MEMORY_MIN_LEN:-15}"
TIMEOUT="${MEMORY_TIMEOUT:-3}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null) || exit 0

[[ "$PROMPT" =~ ^[[:space:]]*/ ]] && exit 0
[[ ${#PROMPT} -lt $MIN_LEN ]] && exit 0

OUT=$(timeout "$TIMEOUT" python3 "$SEARCH" "$PROMPT" 2>/dev/null) || exit 0

if [[ -n "${OUT:-}" ]]; then
  echo "Powiazane wspomnienia z pamieci systemu (trafnosc niepewna — zignoruj, jesli nie pasuja):"
  echo "$OUT"
  echo "[$(date '+%F %T')] hit | ${PROMPT:0:60}" >> "$LOG" 2>/dev/null
else
  echo "[$(date '+%F %T')] miss | ${PROMPT:0:60}" >> "$LOG" 2>/dev/null
fi
exit 0
