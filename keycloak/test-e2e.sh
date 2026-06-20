#!/bin/bash
# E2E: New login flow through proxy
#   device flow -> JWT -> /auth/check -> LLM call
# Usage: bash keycloak/test-e2e.sh

set -euo pipefail

PROXY="http://localhost:4000"
KC_BASE="http://localhost:8080"
REALM="device-flow"
CLIENT_ID="device-flow-client"
USERNAME="${KC_USERNAME:-testuser}"
PASSWORD="${KC_PASSWORD:-testpass}"

COOKIE_FILE=$(mktemp /tmp/kc_e2e.XXXXXX)
trap "rm -f $COOKIE_FILE /tmp/kc_e2e_*.html auth_resp.json auth_code.txt" EXIT

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   E2E: Device Flow -> Proxy -> LiteLLM                 ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── 1. Request Device Code (through proxy) ──
echo ""
echo ">>> [1/6] Request device authorization..."
DEVICE_RESP=$(curl -s -X POST "${PROXY}/auth/device" -d "client_id=${CLIENT_ID}")
DEVICE_CODE=$(echo "$DEVICE_RESP" | python -c "import sys,json; print(json.load(sys.stdin)['device_code'])")
USER_CODE=$(echo "$DEVICE_RESP" | python -c "import sys,json; print(json.load(sys.stdin)['user_code'])")
echo "    device_code = ${DEVICE_CODE:0:20}..."
echo "    user_code   = $USER_CODE"
echo "    interval    = $(echo "$DEVICE_RESP" | python -c "import sys,json; print(json.load(sys.stdin).get('interval',5))")"

# ── 2. Open browser (simulated) ──
echo ""
echo ">>> [2/6] Open device verification page..."
curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /tmp/kc_e2e_p2.html \
  "${KC_BASE}/realms/${REALM}/device?user_code=${USER_CODE}"

FORM_ACTION=$(grep -o 'action="[^"]*login-actions[^"]*"' /tmp/kc_e2e_p2.html \
  | sed 's/action="//;s/"//' | head -1)
echo "    Login form: $([ -n "$FORM_ACTION" ] && echo 'YES' || echo 'NO')"

# ── 3. Login ──
echo ""
echo ">>> [3/6] Login as ${USERNAME}..."
curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /tmp/kc_e2e_p3.html \
  -X POST "$FORM_ACTION" \
  --data-urlencode "username=${USERNAME}" \
  --data-urlencode "password=${PASSWORD}" \
  --data-urlencode "credentialId="

CONSENT=$(grep -c 'consent' /tmp/kc_e2e_p3.html 2>/dev/null || true)
echo "    Consent page: $([ "$CONSENT" -gt 0 ] && echo 'YES' || echo 'no')"

# ── 4. Consent ──
if [ "$CONSENT" -gt 0 ]; then
  echo ""
  echo ">>> [4/6] Approve device consent..."
  CONSENT_FORM=$(grep -o 'action="[^"]*consent[^"]*"' /tmp/kc_e2e_p3.html \
    | sed 's/action="//;s/"//' | head -1)
  curl -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" -o /tmp/kc_e2e_p4.html \
    -X POST "http://localhost:8080${CONSENT_FORM}"
  echo "    Consent submitted"
else
  echo ">>> [4/6] (No consent required)"
fi

# ── 5. Poll for JWT (through proxy) ──
echo ""
echo ">>> [5/6] Poll for JWT..."
JWT=""
for i in $(seq 1 15); do
  sleep 2
  TOKEN_RESP=$(curl -s -X POST "${PROXY}/auth/token" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
    -d "device_code=${DEVICE_CODE}" \
    -d "client_id=${CLIENT_ID}")
  
  JWT=$(echo "$TOKEN_RESP" | python -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  if [ -n "$JWT" ]; then
    echo "    JWT received! (poll #${i})"
    break
  fi
  
  ERROR=$(echo "$TOKEN_RESP" | python -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
  if [ "$ERROR" = "authorization_pending" ]; then
    echo "    Pending... (poll ${i}/15)"
  else
    echo "    Error: $ERROR"
    exit 1
  fi
done

if [ -z "$JWT" ]; then
  echo "    Timed out"
  exit 1
fi

# ── Show JWT claims ──
echo ""
echo "────── JWT Claims ──────"
python << ENDPY
import base64, json
payload = "${JWT}".split('.')[1]
pad = 4 - len(payload) % 4
if pad != 4: payload += '=' * pad
d = json.loads(base64.b64decode(payload))
for k in ['sub','preferred_username','email','iss','azp','scope']:
    print(f'    {k:20} = {d.get(k, "")}')
if 'realm_access' in d:
    print(f'    {"roles":20} = {d["realm_access"].get("roles", [])}')
ENDPY
echo "────────────────────────"

# ── 6. Check LiteLLM authorization ──
echo ""
echo ">>> [6/6] Check LiteLLM authorization..."
curl -s -o auth_resp.json -w "%{http_code}" "${PROXY}/auth/check" \
  -H "Authorization: Bearer ${JWT}" > auth_code.txt
HTTP_CODE=$(cat auth_code.txt)

python << ENDPY
import json
with open('auth_resp.json') as f:
    d = json.load(f)
for k in ['authorized','has_key']:
    print(f'    {k:20} = {d.get(k, "")}')
u = d.get('user', {})
if u:
    print(f'    {"user.sub":20} = {u.get("sub", "")}')
    print(f'    {"user.username":20} = {u.get("username", "")}')
ENDPY

if [ "$HTTP_CODE" = "200" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║          ✅  FLOW COMPLETE                  ║"
  echo "╠══════════════════════════════════════════════╣"
  echo "║  Keycloak token  ✅                          ║"
  echo "║  LiteLLM auth    ✅                          ║"
  echo "╠══════════════════════════════════════════════╣"
  echo "║  Proxy:     ${PROXY}                    ║"
  echo "║  Username:  ${USERNAME}                      ║"
  echo "╚══════════════════════════════════════════════╝"
else
  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║          ❌  ACCESS DENIED                   ║"
  echo "╠══════════════════════════════════════════════╣"
  echo "║  Keycloak token  ✅                          ║"
  echo "║  LiteLLM auth    ❌                          ║"
  echo "╠══════════════════════════════════════════════╣"
  echo "║  Admin must create a LiteLLM key with        ║"
  echo "║  key_alias = ${USERNAME}                    ║"
  echo "╚══════════════════════════════════════════════╝"
fi

echo ""
echo "RAW_TOKEN:${JWT}"
