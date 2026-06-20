# LiteLLM Login — Pi Extension

One URL. One command. Zero API keys.

## Install

```bash
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/
```

## Start

```bash
docker compose up -d --build
```

## Usage

Inside Pi:

```
/login litellm
```

Browser opens → log in as `testuser` / `testpass` → done.

```
/model litellm/gpt-4
```

Start coding.

## Architecture

```
Pi Extension              Proxy (:4000)                Backend
─────────────             ─────────────                ───────
/login litellm
  │ POST /auth/device ──→ │ ──proxy──→ Keycloak
  │← verification_uri ────│
  │ (browser opens)       │
  │ POST /auth/token  ───→│ ──proxy──→ Keycloak
  │←─ JWT ───────────────│
  │ POST /chat/        ───→│ validate JWT
  │   completions          │ ──master key──→ LiteLLM
  │   (Bearer JWT)         │                  │
  │←─ response ←──────────│←─────────────────│
```

The client only sees `http://localhost:4000`. Everything else is internal.
