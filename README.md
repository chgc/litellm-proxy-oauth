# LLM Login — Architecture Overview

One URL. One command. Zero API keys.

```
http://localhost:4000
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| **proxy** | `:4000` | **One URL for clients.** JWT validation, auth check, LLM forwarding |
| **keycloak** | `:8080` | SSO / device flow login, admin console |
| **litellm** | `:4001` | LLM proxy with key management, spend tracking, model routing |
| **postgres** | — | LiteLLM database (keys, budget, spend) |

## Quick Start

```bash
# 1. Start everything
docker compose up -d --build

# 2. Get a DeepSeek V4 Flash response immediately
bash keycloak/test-full-e2e.sh
```

## Developer Setup

```bash
# Install pi extension
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/

# In pi:
#   /login litellm       ← browser opens, log in, done
#   /model litellm/deepseek-v4-flash
#   start coding!
```

## Admin Tasks

```bash
# Keycloak admin
open http://localhost:8080/admin   # admin / admin

# Create a user's LLM key
curl -X POST http://localhost:4001/key/generate \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -d '{"key_alias": "testuser", "max_budget": 50.0}'

# List keys
curl http://localhost:4001/key/list \
  -H "Authorization: Bearer sk-litellm-master-key-change-me"
```

## Architecture Flow

```
User → Proxy (:4000) → Keycloak (:8080)  — login / JWT
User → Proxy (:4000) → LiteLLM (:4001)   — LLM calls (JWT auth)
LiteLLM → OpenCode Go / OpenAI / Anthropic — model providers
```

## Required Environment

Create `.env`:

```bash
OPENAI_API_KEY=sk-...                 # optional
ANTHROPIC_API_KEY=sk-ant-...          # optional
OPENCODE_GO_API_KEY=oc_...            # optional — for deepseek-v4-flash etc.
```

## File Map

```
├── docker-compose.yml        # All services
├── proxy/                    # Thin auth/LLM proxy (port 4000)
│   ├── main.py
│   └── Dockerfile
├── litellm/
│   ├── config.yaml           # Model definitions
│   └── HOWTO.md
├── keycloak/
│   ├── realm-export.json     # Pre-configured realm
│   ├── test-e2e.sh           # Login flow test
│   └── test-full-e2e.sh      # Full pipeline test
├── pi-ext/litellm-login/     # Pi extension
│   ├── index.ts
│   └── package.json
└── FLOW.md                   # Sequence diagrams
```
