# Walkthrough — Login to LLM in One Command

## Start

```bash
docker compose up -d --build
```

Wait ~60s for all services to be healthy.

## Admin: Register a User

Open LiteLLM admin UI at `http://localhost:4001`, or use the API:

```bash
# Register a user (user_alias = Keycloak username)
curl -X POST http://localhost:4001/user/new \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "user_alias": "jkyangc",
    "user_email": "user@example.com",
    "models": []
  }'
```

`models: []` gives access to all models the proxy routes.

> **Note:** The registration is a one-time step. Once a user is created in LiteLLM with `user_alias` matching the Keycloak username, the proxy will auto-create session keys on each login.

## Get an LLM Response

```bash
bash keycloak/test-full-e2e.sh
```

This runs the full pipeline:
1. Device flow login → Keycloak JWT
2. Authorization check → LiteLLM user lookup by `user_alias`
3. Session key auto-created → forwarded to DeepSeek V4 Flash
4. LLM response printed

## For Pi Users

```bash
# Install extension once
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/

# Inside pi
/reload
/login litellm          # OAuth device flow → stores JWT
/model litellm/flash    # Select model
# Start coding
```

Each `/login litellm` creates a new session key on first request.
`/logout` blocks the session key.

## Useful Commands

```bash
# View proxy logs
docker compose logs -f proxy

# View LiteLLM logs
docker compose logs -f litellm

# Check all running services
docker compose ps

# Stop everything (preserves data)
docker compose down

# Full reset (clears DB)
docker compose down --volumes

# Keycloak admin console
open http://localhost:8080/admin   # admin / admin

# LiteLLM admin UI
open http://localhost:4001         # use master key to log in

# Test login without pi
bash keycloak/test-e2e.sh
```

## .env Setup

```env
# Required: API key for the LLM provider (OpenCode Go)
OPENCODE_GO_API_KEY=sk-...

# Optional overrides
# PROXY_PORT=4000
# KC_URL=http://keycloak:8080
# KC_REALM=device-flow
# LITELLM_URL=http://litellm:4000
# LITELLM_MASTER_KEY=sk-litellm-master-key-change-me
```

## Architecture Overview

```
┌──────────┐   http://localhost:4000   ┌──────────┐
│   Pi     │ ────────────────────────→ │  Proxy   │
│ (Client) │ ←──────────────────────── │ (:4000)  │
└──────────┘                           └────┬─────┘
                                            │
                     ┌──────────────────────┼──────────────┐
                     │                      │              │
                     ▼                      ▼              ▼
              ┌──────────┐          ┌──────────┐    ┌──────────┐
              │ Keycloak │          │ LiteLLM  │    │   LLM    │
              │ (:8080)  │          │ (:4000)  │    │ Provider │
              └──────────┘          └──────────┘    └──────────┘
```

The client only sees `http://localhost:4000`. Everything else is internal to Docker.
