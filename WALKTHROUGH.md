# Walkthrough — Login to LLM in One Command

## Start

```bash
docker compose up -d --build
```

Wait ~60s for all services to be healthy.

## Get an LLM Response

```bash
bash keycloak/test-full-e2e.sh
```

This runs the full pipeline:
1. Device flow login → Keycloak JWT
2. Authorization check → LiteLLM
3. Session key created → forwarded to DeepSeek V4 Flash
4. LLM response printed

## For Pi Users

```bash
# Install extension once
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/

# Inside pi
/login litellm
/model litellm/deepseek-v4-flash
# Start coding
```

## Admin: Provision a User

```bash
# 1. Create LiteLLM key (key_alias = Keycloak username)
curl -X POST http://localhost:4001/key/generate \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -d '{"key_alias": "testuser", "max_budget": 50.0}'

# 2. User logs in via pi → /auth/check finds the key → authorized
```

## Useful Commands

```bash
# View logs
docker compose logs -f proxy

# Check all running services
docker compose ps

# Stop everything
docker compose down --volumes

# Keycloak admin
open http://localhost:8080/admin   # admin / admin

# Test login without pi
bash keycloak/test-e2e.sh
```

## .env Setup

```bash
OPENCODE_GO_API_KEY=oc_...   # for DeepSeek V4 Flash via OpenCode Go
```
