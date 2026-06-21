"""
Thin proxy: one URL for the client.
  POST /auth/device        → Keycloak device authorization
  POST /auth/token         → Keycloak token polling
  POST /v1/chat/completions → validate JWT → per-user LiteLLM key → forward
  GET  /health

Each authenticated user gets their own LiteLLM virtual key on first request.
LiteLLM tracks spend, rate limits, and budgets per user.
The master key never leaves the proxy.
"""

import os
import httpx
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from jwt import PyJWKClient, InvalidTokenError

# ── Config ────────────────────────────────────────────────────
PROXY_PORT = int(os.getenv("PROXY_PORT", "4000"))
KC_URL = os.getenv("KC_URL", "http://keycloak:8080")
KC_REALM = os.getenv("KC_REALM", "device-flow")
KC_ISSUER = os.getenv("KC_ISSUER", f"{KC_URL}/realms/{KC_REALM}")
KC_JWKS_URI = f"{KC_URL}/realms/{KC_REALM}/protocol/openid-connect/certs"
LITELLM_URL = os.getenv("LITELLM_URL", "http://litellm:4000")
LITELLM_MASTER_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-litellm-master-key-change-me")

_jwks = PyJWKClient(KC_JWKS_URI, cache_keys=True)
app = FastAPI(title="LLM Auth Proxy")

# In-memory cache: JWT sub → LiteLLM sk- key
# On first request from a user, a key is created via /key/generate.
_key_cache: dict[str, str] = {}


# ── JWT validation ────────────────────────────────────────────

def validate_jwt(token: str) -> dict:
    try:
        key = _jwks.get_signing_key_from_jwt(token)
        from jwt import decode as jwt_decode
        return jwt_decode(
            token, key.key, algorithms=["RS256"],
            issuer=KC_ISSUER, options={"verify_exp": True, "verify_aud": False},
        )
    except InvalidTokenError as e:
        raise PermissionError(f"Invalid token: {e}")


# ── Registration check (LiteLLM user with matching user_alias) ──

async def _find_registered_user(username: str) -> dict | None:
    """Look up a user in LiteLLM by user_alias.

    Admin registers users via LiteLLM UI (/user/new) with
    user_alias = Keycloak username (preferred_username).
    Returns the user dict or None if not found.
    """
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{LITELLM_URL}/user/list",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
        )
        if r.status_code != 200:
            return None
        for user in r.json().get("users", []):
            if user.get("user_alias") == username:
                return user
    return None


# ── Per-user LiteLLM session key management ──────────────────

async def _ensure_litellm_key(claims: dict) -> str:
    """Get or create a LiteLLM session key for a registered user.

    1. Check cache for existing session key.
    2. Look up user by user_alias in LiteLLM (admin-registered).
    3. Auto-create a virtual key for that user on first request.
    Session key is cached in memory and blocked on logout.
    """
    user_sub = claims.get("sub", "unknown")
    username = claims.get("preferred_username", user_sub)
    # Fast path: already have a cached session key
    cached = _key_cache.get(user_sub)
    if cached:
        return cached

    # Look up user in LiteLLM by user_alias (matches Keycloak username)
    user = await _find_registered_user(username)
    if not user:
        raise PermissionError(
            f"No LLM access for '{username}'. "
            "Contact admin to register your account in LiteLLM."
        )

    # Auto-create a virtual key bound to this registered user.
    # user_id = Keycloak username (matches user_alias in LiteLLM).
    # models=[] gives the key access to all models the proxy routes.
    import uuid
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{LITELLM_URL}/key/generate",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}", "Content-Type": "application/json"},
            json={
                "key_alias": f"session-{uuid.uuid4().hex[:8]}",
                "user_id": username,
                "models": [],
                "max_budget": None,
            },
        )
        if r.status_code == 200:
            data = r.json()
            sk = data["key"]
            _key_cache[user_sub] = sk
            return sk

    raise RuntimeError(f"Failed to create session key: {r.status_code}")


# ── Auth endpoints (proxy to Keycloak) ────────────────────────


@app.get("/auth/check")
async def auth_check(request: Request):
    """Check if a user is registered in LiteLLM.

    Validates JWT and looks up the user by user_alias in LiteLLM.
    Admin registers users via LiteLLM UI (/user/new) with
    user_alias = Keycloak username.

    Returns:
      200: { authorized: true, user: {...} }
      401: missing token
      403: unauthorized or not registered in LiteLLM
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"error": "Missing Bearer token"})

    token = auth.removeprefix("Bearer ")
    try:
        claims = validate_jwt(token)
    except PermissionError as e:
        return JSONResponse(status_code=403, content={"error": str(e)})

    user_sub = claims.get("sub", "")
    username = claims.get("preferred_username", user_sub)

    # Check if user is registered in LiteLLM (user_alias matches)
    user = await _find_registered_user(username)
    if not user:
        return JSONResponse(status_code=403, content={
            "error": f"No LLM access for '{username}'. Contact admin to register your account in LiteLLM.",
            "user": username,
        })

    return {
        "authorized": True,
        "user": {
            "sub": user_sub,
            "username": username,
            "user_id": user["user_id"],
        },
    }


@app.post("/auth/device")
async def device_auth(request: Request):
    body = await request.body()
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{KC_URL}/realms/{KC_REALM}/protocol/openid-connect/auth/device",
            content=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        return Response(content=r.content, status_code=r.status_code, media_type="application/json")


@app.post("/auth/token")
async def token(request: Request):
    body = await request.body()
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{KC_URL}/realms/{KC_REALM}/protocol/openid-connect/token",
            content=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        return Response(content=r.content, status_code=r.status_code, media_type="application/json")


# ── LLM endpoint ──────────────────────────────────────────────

@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(request: Request):
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ")
    if not auth.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"error": "Missing Bearer token"})

    # If token looks like a JWT (starts with eyJ), validate it
    if token.startswith("eyJ"):
        try:
            claims = validate_jwt(token)
            user_key = await _ensure_litellm_key(claims)
        except PermissionError as e:
            return JSONResponse(status_code=403, content={"error": str(e)})
        except RuntimeError as e:
            return JSONResponse(status_code=502, content={"error": str(e)})
        # Forward using per-user session key
        body = await request.body()
        headers = {
            "Authorization": f"Bearer {user_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{LITELLM_URL}/v1/chat/completions", content=body, headers=headers)

        # If LiteLLM rejects the key (deleted/blocked from admin UI),
        # clear cache and retry once with a fresh key.
        if r.status_code == 401:
            # Stale key — remove from cache and create a new one
            _key_cache.pop(claims.get("sub", ""), None)
            user_key = await _ensure_litellm_key(claims)
            headers["Authorization"] = f"Bearer {user_key}"
            async with httpx.AsyncClient(timeout=120) as c2:
                r = await c2.post(f"{LITELLM_URL}/v1/chat/completions", content=body, headers=headers)

        return Response(content=r.content, status_code=r.status_code, media_type="application/json")

    # Non-JWT: not authenticated
    return JSONResponse(status_code=403, content={"error": "Not authenticated. Run /login-litellm first."})


@app.get("/v1/models")
@app.get("/models")
async def list_models(request: Request):
    """Forward model list from LiteLLM."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{LITELLM_URL}/models",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
        )
        return Response(content=r.content, status_code=r.status_code, media_type="application/json")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/logout")
async def logout(request: Request):
    """Block the user's LiteLLM key on logout."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"error": "Missing Bearer token"})

    token = auth.removeprefix("Bearer ")
    try:
        claims = validate_jwt(token)
    except PermissionError:
        return JSONResponse(status_code=403, content={"error": "Invalid token"})

    user_sub = claims.get("sub")
    if not user_sub:
        return JSONResponse(status_code=400, content={"error": "No sub in JWT"})

    # Block the LiteLLM key
    sk = _key_cache.pop(user_sub, None)
    if sk:
        async with httpx.AsyncClient() as c:
            await c.post(
                f"{LITELLM_URL}/key/block",
                headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}", "Content-Type": "application/json"},
                json={"key": sk},
            )

    return {"status": "logged_out"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PROXY_PORT)
