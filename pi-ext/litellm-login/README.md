# LiteLLM Login — Pi Extension

One URL. One command. Zero manual API keys.

## Install

```bash
cd pi-ext/litellm-login
npm install
mkdir -p ~/.pi/agent/extensions/litellm-login
cp -r * ~/.pi/agent/extensions/litellm-login/
```

For development (project root has a build script):
```bash
cd pi-ext/litellm-login
npm install
npm run build    # if a build step is needed
```

## Start Services

```bash
docker compose up -d --build
```

## Admin: Register a User

Users must be registered in LiteLLM before they can access models.
Open `http://localhost:4001` (LiteLLM admin UI) → create user with:

- `user_alias` = Keycloak username (e.g., `jkyangc`)
- `models` = `[]` (all models) or specific model IDs

Or via API:
```bash
curl -X POST http://localhost:4001/user/new \
  -H "Authorization: Bearer sk-litellm-master-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"user_alias": "jkyangc", "models": []}'
```

## Usage

Inside Pi:

```
/reload
/login litellm
```

Browser opens → log in via Keycloak → JWT stored in `auth.json`.

```
/model litellm/flash
```

Start coding. The proxy auto-creates a session key on the first request.

## How It Works

```
Pi                      Proxy (:4000)                LiteLLM / Keycloak
─                        ────────────                ──────────────────

/login litellm
  │ POST /auth/device ──→ │ ──proxy──→ Keycloak
  │← verification_uri ────│
  │ (browser)             │
  │ POST /auth/token  ───→│ ──proxy──→ Keycloak
  │←─ JWT ───────────────│

/model + message
  │ POST /chat/         ───→│ validate JWT (JWKS)
  │   completions            │ GET /user/list → check user_alias
  │   (Bearer JWT)           │ POST /key/generate → create session key
  │                          │   user_id = username, models = []
  │                          │ POST /v1/chat/completions (Bearer sk-xxx)
  │←─ response ←────────────│←────────────────── LiteLLM
```

## Key Features

- **No API keys in config** — JWT-based auth via Keycloak
- **Auto session keys** — created on first request per login
- **User registration** — check via `user_alias` in `/user/list`
- **Stale key recovery** — if a key is deleted from admin UI, proxy auto-creates a new one
- **Logout** — blocks the session key via `/logout`

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROXY_URL` | `http://localhost:4000` | Proxy base URL |
| `CLIENT_ID` | `device-flow-client` | Keycloak client ID |
