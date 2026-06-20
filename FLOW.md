# Usage Flow

## Admin: provision a user

```bash
curl -X POST http://localhost:4001/key/generate \
  -H "Authorization: Bearer $MASTER_KEY" \
  -d '{
    "key_alias": "testuser",
    "max_budget": 50.0,
  }'
```

Key must have `key_alias` matching the Keycloak username (`preferred_username` claim).

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
    P->>L: Scan keys for alias = username
    alt Key exists
        L-->>P: found
        P-->>C: authorized: true
    else No key
        L-->>P: not found
        P-->>C: 403 No LLM access
    end

    Note over U,O: FIRST CHAT REQUEST

    C->>P: POST /v1/chat/completions (Bearer JWT)
    P->>P: Validate JWT
    P->>L: Check admin key still exists
    L-->>P: confirmed
    P->>L: POST /key/generate (session key)
    L-->>P: sk-xxx (full key)
    P->>P: Cache in memory

    P->>L: POST /chat (Bearer sk-xxx)
    L->>O: POST /chat
    O-->>L: Response
    L-->>P: Response
    P-->>C: Response

    Note over U,O: SUBSEQUENT REQUESTS

    C->>P: POST /v1/chat/completions (Bearer JWT)
    P->>P: Validate JWT
    P->>P: Cache hit, reuse sk-xxx
    P->>L: POST /chat (Bearer sk-xxx)
    L->>O: POST /chat
    O-->>L: Response
    L-->>P: Response
    P-->>C: Response
```

---

## Token Lifecycle

| Token | Source | Expiry | Notes |
|-------|--------|--------|-------|
| Keycloak JWT | Device flow | 1 hour | Auto-refreshed by extension |
| Admin key (alias = username) | Admin `/key/generate` | Permanent | Authorization only, not used for requests |
| Session key (sk-xxx) | Proxy on first request | Session lifetime | Cached in proxy memory, full key for API calls |

## Permission checks

| Point | What happens | If denied |
|-------|-------------|-----------|
| `/auth/check` | Proxy scans LiteLLM for key with `key_alias = username` | `403 No LLM access. Contact admin.` |
| Chat request | Proxy verifies JWT signature locally (JWKS) | `403 Invalid token` |
| LiteLLM per request | LiteLLM checks budget and rate limits | `429 Budget exceeded` |
