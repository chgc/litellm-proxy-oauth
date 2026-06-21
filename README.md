# LLM Login — Architecture Overview

One URL. One command. Zero manual API keys.

```
http://localhost:4000
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| **proxy** | `:4000` | **One URL for clients.** JWT validation, auth check, user registration check, LLM forwarding |
| **keycloak** | `:8080` | SSO / device flow login, admin console |
| **litellm** | `:4001` | LLM proxy with user management, key management, spend tracking, model routing |
| **postgres** | — | LiteLLM database (users, keys, budget, spend) |

## Quick Start

```bash
# 1. Start everything
docker compose up -d --build

# 2. Get a DeepSeek V4 Flash response immediately
bash keycloak/test-full-e2e.sh
```

## Admin: Register a User

Before a user can access LLMs, an admin must register them in LiteLLM:

```bash
curl -X POST http://localhost:4001/user/new \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "user_alias": "jkyangc",
    "user_email": "user@example.com",
    "models": []
  }'
```

- `user_alias` must match the Keycloak username (`preferred_username`)
- `models: []` gives access to all models the proxy routes

> The registration is a one-time step. After that, session keys are auto-created on each login.

## Pi Extension Setup

```bash
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/

# In pi:
#   /reload
#   /login litellm       ← browser opens, log in via Keycloak
#   /model litellm/flash
#   start coding!
```

## Architecture

```
User → Proxy (:4000) → Keycloak (:8080)  — OAuth device flow → JWT
User → Proxy (:4000) → LiteLLM (:4001)   — chat requests (JWT auth)
       Proxy ──checks──→ LiteLLM /user/list — verify user_alias matches
       Proxy ──creates──→ LiteLLM /key/generate — auto session key
LiteLLM → OpenCode Go / OpenAI / Anthropic — model providers
```

## How Session Keys Work

1. **User logs in** → Keycloak device flow → JWT stored in `auth.json`
2. **First chat request** → Proxy validates JWT → checks `/user/list` for `user_alias = username` → creates a session key (bound by `user_id`, `models: []`)
3. **Subsequent requests** → Proxy reuses cached session key
4. **Logout** → Session key is blocked
5. **Stale key recovery** → If key deleted from admin UI, proxy auto-detects 401 → re-checks registration → creates new key → retries

## Required Environment

Create `.env` in the project root:

```bash
OPENCODE_GO_API_KEY=sk-...            # for DeepSeek V4 Flash
# Optional:
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
```

## File Map

```
├── docker-compose.yml        # All services
├── proxy/                    # Thin auth/LLM proxy (port 4000)
│   ├── main.py               # ← core logic: auth, key mgmt, forwarding
│   └── Dockerfile
├── litellm/
│   ├── config.yaml           # Model definitions & routing
│   └── HOWTO.md
├── keycloak/
│   ├── realm-export.json     # Pre-configured Keycloak realm
│   ├── test-e2e.sh           # Login flow test
│   └── test-full-e2e.sh      # Full pipeline test
├── pi-ext/litellm-login/     # Pi extension
│   ├── index.ts              # OAuth provider + model list
│   └── package.json
├── FLOW.md                   # Sequence diagrams & detailed flow
└── WALKTHROUGH.md            # Step-by-step guide
```

## Doc Index

| File | What it covers |
|------|---------------|
| [FLOW.md](./FLOW.md) | Sequence diagrams, token lifecycle, API endpoints |
| [WALKTHROUGH.md](./WALKTHROUGH.md) | Step-by-step setup, admin tasks, commands |
| `litellm/HOWTO.md` | LiteLLM config & model management |
