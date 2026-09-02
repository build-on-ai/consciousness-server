#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT="test-sign-outbound"
AGENT_PUB="$ROOT/key-server/keys/agents/$AGENT.pub"
REDIS_NAME="cs-test-sign-redis-$$"
TMP="$(mktemp -d)"
KS_PID=""

pass_cnt=0; fail_cnt=0
pass() { printf '  \xE2\x9C\x93  %s\n' "$1"; pass_cnt=$((pass_cnt+1)); }
fail() { printf '  \xE2\x9C\x97  %s  — %s\n' "$1" "$2" >&2; fail_cnt=$((fail_cnt+1)); }

cleanup() {
  [ -n "$KS_PID" ] && kill "$KS_PID" 2>/dev/null
  docker rm -f "$REDIS_NAME" >/dev/null 2>&1
  rm -f "$AGENT_PUB"
  rm -rf "$TMP"
}
trap cleanup EXIT

for cmd in node docker ssh-keygen curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "test-sign-outbound: missing required command: $cmd" >&2
    exit 1
  fi
done

if [ ! -d "$ROOT/key-server/node_modules/sshpk" ]; then
  echo "test-sign-outbound: run (cd key-server && npm ci) first" >&2
  exit 1
fi
if [ ! -d "$ROOT/core/node_modules/sshpk" ]; then
  echo "test-sign-outbound: run (cd core && npm ci) first (sshpk is a core dep)" >&2
  exit 1
fi

ssh-keygen -t ed25519 -C "$AGENT@e2e" -N "" -q -f "$TMP/key"
cp "$TMP/key.pub" "$AGENT_PUB"

if ! docker run -d --rm --name "$REDIS_NAME" -p 127.0.0.1::6379 redis:7-alpine >/dev/null; then
  echo "test-sign-outbound: cannot start redis container" >&2
  exit 1
fi
REDIS_PORT="$(docker port "$REDIS_NAME" 6379/tcp | head -1 | awk -F: '{print $NF}')"

NM="${KEY_SERVER_NODE_MODULES:-$(cd "$(dirname "$0")/.." && pwd)/key-server/node_modules}"
if [ ! -d "$NM/sshpk" ]; then
  echo "test-sign-outbound: sshpk not found in $NM" >&2
  echo "  run: (cd key-server && npm install)" >&2
  exit 2
fi
export NODE_PATH="$NM"

KS_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
KEY_SERVER_PORT="$KS_PORT" KEY_SERVER_HOST=127.0.0.1 \
  REDIS_HOST=127.0.0.1 REDIS_PORT="$REDIS_PORT" \
  node "$ROOT/key-server/server.js" >"$TMP/ks.log" 2>&1 &
KS_PID=$!

KS="http://127.0.0.1:$KS_PORT"

ready=""
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 2 -X POST "$KS/api/verify" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  if [ "$code" = "400" ]; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "test-sign-outbound: key-server did not become ready — $TMP/ks.log:" >&2
  tail -5 "$TMP/ks.log" >&2
  exit 1
fi

sign_payload() {
  CS_SIGNING_KEY="$TMP/key" CS_AGENT_ID="$AGENT" node -e '
    const crypto = require("crypto");
    const { signHeaders } = require(process.argv[1]);
    const signedBody = process.argv[2];
    const claimedBody = process.argv[3];
    const h = signHeaders(null, "POST", "/api/embed", signedBody);
    if (!h["X-Signature"]) { console.error("no signature produced"); process.exit(1); }
    process.stdout.write(JSON.stringify({
      agent_id: h["X-Agent-Id"],
      timestamp: h["X-Timestamp"],
      nonce: h["X-Nonce"],
      method: "POST",
      path: "/api/embed",
      body_sha256: crypto.createHash("sha256").update(Buffer.from(claimedBody, "utf8")).digest("hex"),
      signature: h["X-Signature"],
    }));
  ' "$ROOT/core/middleware/sign-outbound.js" "$1" "$2"
}

echo "sign-outbound E2E (key-server :$KS_PORT, redis :$REDIS_PORT)"

BODY='{"collection":"notes","id":"e2e-1","text":"sign-outbound e2e"}'
payload="$(sign_payload "$BODY" "$BODY")"
resp=$(curl -s -m 5 -X POST "$KS/api/verify" -H 'Content-Type: application/json' -d "$payload")
if echo "$resp" | grep -q '"valid": *true'; then
  pass "T1 signHeaders → key-server /api/verify valid:true"
else
  fail "T1 valid signature" "response=${resp:0:120}"
fi

payload="$(sign_payload "$BODY" '{"collection":"notes","id":"e2e-1","text":"TAMPERED"}')"
resp=$(curl -s -m 5 -X POST "$KS/api/verify" -H 'Content-Type: application/json' -d "$payload")
if echo "$resp" | grep -q '"valid": *false'; then
  pass "T2 tampered body → valid:false ($(echo "$resp" | grep -o '"reason": *"[^"]*"'))"
else
  fail "T2 tampered body" "response=${resp:0:120}"
fi

out=$(env -u CS_SIGNING_KEY node -e '
  const { signHeaders } = require(process.argv[1]);
  process.stdout.write(JSON.stringify(signHeaders(null, "POST", "/api/embed", "{}")));
' "$ROOT/core/middleware/sign-outbound.js")
if [ "$out" = "{}" ]; then
  pass "T3 unset CS_SIGNING_KEY → signHeaders() === {}"
else
  fail "T3 unconfigured fallback" "got $out"
fi

echo "test-sign-outbound: $pass_cnt passed, $fail_cnt failed"
[ "$fail_cnt" -eq 0 ]
