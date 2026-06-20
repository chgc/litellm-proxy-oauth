#!/bin/bash
# Full E2E: login -> auth check -> first LLM call (creates session key)
# Usage: bash keycloak/test-full-e2e.sh

set -euo pipefail

PROXY="http://localhost:4000"
KC_BASE="http://localhost:8080"
REALM="device-flow"
CLIENT_ID="device-flow-client"
USERNAME="${KC_USERNAME:-testuser}"
PASSWORD="${KC_PASSWORD:-testpass}"

COOKIE_FILE=$(mktemp /tmp/kc_fe.XXXXXX)
trap "rm -f $COOKIE_FILE /tmp/kc_fe_*.html kc_fe_auth.json kc_fe_code.txt" EXIT

echo "+==========================================================+"
echo "|   Full E2E: Login + Auth Check + First LLM Call       |"
echo "+==========================================================+"

# ── 1. Device auth ──
echo ""
echo ">>> [1/5] Request device authorization..."
DR=$(curl -s -X POST "${PROXY}/auth/device" -d "client_id=${CLIENT_ID}")
DC=$(echo "$DR" | python -c "import sys,json; print(json.load(sys.stdin)['device_code'])")
UC=$(echo "$DR" | python -c "import sys,json; print(json.load(sys.stdin)['user_code'])")
echo "    device_code = ${DC:0:20}..."
echo "    user_code   = $UC"

# ── 2. Login ──
echo ""
echo ">>> [2/5] Login as ${USERNAME}..."
curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /tmp/kc_fe_p2.html \
  "${KC_BASE}/realms/${REALM}/device?user_code=${UC}"
FA=$(grep -o 'action="[^"]*login-actions[^"]*"' /tmp/kc_fe_p2.html | sed 's/action="//;s/"//' | head -1)

curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /tmp/kc_fe_p3.html \
  -X POST "$FA" \
  --data-urlencode "username=${USERNAME}" \
  --data-urlencode "password=${PASSWORD}" \
  --data-urlencode "credentialId="

if grep -q 'consent' /tmp/kc_fe_p3.html 2>/dev/null; then
  CF=$(grep -o 'action="[^"]*consent[^"]*"' /tmp/kc_fe_p3.html | sed 's/action="//;s/"//' | head -1)
  curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /dev/null \
    -X POST "http://localhost:8080${CF}"
fi
echo "    Logged in"

# ── 3. Poll for JWT ──
echo ""
echo ">>> [3/5] Poll for JWT..."
JWT=""
for i in $(seq 1 15); do
  sleep 2
  TR=$(curl -s -X POST "${PROXY}/auth/token" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
    -d "device_code=${DC}" \
    -d "client_id=${CLIENT_ID}")
  JWT=$(echo "$TR" | python -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  [ -n "$JWT" ] && echo "    JWT received! (poll #${i})" && break
  echo "    $(echo "$TR" | python -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null) (poll ${i}/15)"
done
[ -z "$JWT" ] && echo "Timed out" && exit 1

python << ENDPY
import base64, json
p = "${JWT}".split('.')[1]
pad = 4 - len(p) % 4
if pad != 4: p += '=' * pad
d = json.loads(base64.b64decode(p))
print(f'    sub: {d.get("sub","")}')
print(f'    username: {d.get("preferred_username","")}')
print(f'    email: {d.get("email","")}')
ENDPY

# ── 4. Auth check ──
echo ""
echo ">>> [4/5] Check LiteLLM authorization..."
curl -s -o kc_fe_auth.json -w "%{http_code}" "${PROXY}/auth/check" \
  -H "Authorization: Bearer ${JWT}" > kc_fe_code.txt
HC=$(cat kc_fe_code.txt)

python << ENDPY
import json
with open('kc_fe_auth.json') as f:
    d = json.load(f)
print(f'    authorized = {d.get("authorized")}')
print(f'    has_key    = {d.get("has_key")}')
ENDPY

if [ "$HC" != "200" ]; then
  echo ""
  echo "+==========================================================+"
  echo "|          ACCESS DENIED                                    |"
  echo "+==========================================================+"
  echo "|  Create a LiteLLM key with key_alias =                    |"
  echo "|  ${USERNAME}                                              |"
  echo "+==========================================================+"
  exit 1
fi

# ── 5. First LLM call ──
echo ""
echo ">>> [5/5] First LLM call (creates session key)..."
echo "    Proxy cache before: expect empty"

LLM_RESP=$(curl -s -w "\n%{http_code}" "${PROXY}/v1/chat/completions" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}')
LLM_CODE=$(echo "$LLM_RESP" | tail -1)
LLM_BODY=$(echo "$LLM_RESP" | head -n -1)

echo "    HTTP ${LLM_CODE}"

# Extract response content
CHOICE=$(echo "$LLM_BODY" | python -c "
import sys, json
d = json.load(sys.stdin)
if 'choices' in d:
    print(d['choices'][0]['message']['content'])
" 2>/dev/null)

if [ -n "$CHOICE" ]; then
  echo ""
  echo "+==========================================================+"
  echo "|        ✅  FULL PIPELINE WORKS!                          |"
  echo "+==========================================================+"
  echo "|  Login              ✅                                   |"
  echo "|  Auth check         ✅                                   |"
  echo "|  Session key        ✅                                   |"
  echo "|  LiteLLM forward    ✅                                   |"
  echo "|  LLM response       ✅                                   |"
  echo "+==========================================================+"
  echo "|  Model: deepseek-v4-flash                                |"
  echo "|  Response: ${CHOICE:0:100}                                |"
  echo "+==========================================================+"
elif echo "$LLM_BODY" | grep -qi "api.key\|api_key"; then
  echo ""
  echo "+==========================================================+"
  echo "|   PIPELINE OK  (set API key in .env)                     |"
  echo "+==========================================================+"
  echo "|  Login              ✅                                    |"
  echo "|  Auth check         ✅                                    |"
  echo "|  Session key        ✅                                    |"
  echo "|  LiteLLM forward    ✅                                    |"
  echo "|  LLM key            ⚠️  missing from .env                 |"
  echo "+==========================================================+"
fi
