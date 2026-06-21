# Usage Flow

## Admin: Register a user in LiteLLM

Admin creates a user in LiteLLM admin UI (`http://localhost:4001`) or via API:

```bash
curl -X POST http://localhost:4001/user/new \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_alias": "jkyangc",
    "user_email": "user@example.com",
    "models": []
  }'
```

`user_alias` must match the Keycloak username (`preferred_username` claim).
`models: []` gives access to all models the proxy routes.

---

## User: login and use LLM

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client (Pi)
    participant P as Proxy
    participant K as Keycloak
    participant L as LiteLLM
    participant O as LLM Provider

    Note over U,O: LOGIN

    C->>P: POST /auth/device
    P->>K: forward
    K-->>P: device_code, user_code
    P-->>C: device_code, user_code
    C->>U: Open browser
    U->>K: Login
    K-->>U: Authorized

    loop Poll
        C->>P: POST /auth/token
        P->>K: forward
        K-->>P: pending
        P-->>C: pending
    end

    K-->>P: JWT
    P-->>C: JWT

    Note over C,P: CHECK AUTHORIZATION

    C->>P: GET /auth/check (Bearer JWT)
    P->>P: Validate JWT
    P->>L: GET /user/list → find user_alias == username
    alt User exists
        L-->>P: found
        P-->>C: authorized: true
    else Not registered
        L-->>P: not found
        P-->>C: 403 No LLM access
    end

    Note over U,O: FIRST CHAT REQUEST

    C->>P: POST /v1/chat/completions (Bearer JWT)
    P->>P: Validate JWT
    P->>L: GET /user/list → confirm user exists
    L-->>P: registered user
    P->>L: POST /key/generate (session key)
    Note right of P: user_id = username<br/>models = [] (all)<br/>key_alias = session-{uuid}
    L-->>P: sk-xxx (full key)
    P->>P: Cache in memory (by JWT sub)

    P->>L: POST /v1/chat/completions (Bearer sk-xxx)
    L->>O: forward to LLM provider
    O-->>L: Response
    L-->>P: Response
    P-->>C: Response

    Note over U,O: SUBSEQUENT REQUESTS

    C->>P: POST /v1/chat/completions (Bearer JWT)
    P->>P: Cache hit, reuse sk-xxx
    P->>L: POST /v1/chat/completions (Bearer sk-xxx)
    L->>O: forward
    O-->>L: Response
    L-->>P: Response
    P-->>C: Response
```

---

## Stale Key Recovery

If the session key is manually deleted from LiteLLM admin UI:

```
chat request → cache hit (stale key) → LiteLLM returns 401
    → proxy clears cache
    → re-validates user registration (user_alias check)
    → creates new session key
    → retries request → 200 OK
```

---

## Token Lifecycle

| Token | Source | Expiry | Notes |
|-------|--------|--------|-------|
| Keycloak JWT | Device flow | 1 hour | Auto-refreshed by extension |
| LiteLLM user (user_alias) | Admin `/user/new` | Permanent | Registration only, maps to Keycloak username |
| Session key (sk-xxx) | Proxy on first request | Until blocked | Cached in proxy memory, bound to `user_id = username` |

## Permission checks

| Point | What happens | If denied |
|-------|-------------|-----------|
| `/auth/check` | Proxy looks up user by `user_alias` in `/user/list` | `403 No LLM access. Contact admin to register your account.` |
| Chat request | Proxy verifies JWT signature locally (JWKS) | `403 Invalid token` |
| First chat / key create | Proxy re-checks user registration | `403 No LLM access` |
| Stale key recovery | Proxy re-checks user registration | `403 No LLM access` (user deleted from LiteLLM) |
| LiteLLM per request | LiteLLM checks budget and rate limits | `429 Budget exceeded` |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/auth/device` | POST | None | Keycloak device authorization |
| `/auth/token` | POST | None | Keycloak token polling |
| `/auth/check` | GET | Bearer JWT | Validate JWT + check user registration |
| `/v1/chat/completions` | POST | Bearer JWT | Chat via proxy → LiteLLM |
| `/chat/completions` | POST | Bearer JWT | Same as above (alternative path) |
| `/v1/models` | GET | Master key | List models from LiteLLM |
| `/logout` | POST | Bearer JWT | Block session key |
| `/health` | GET | None | Health check |
