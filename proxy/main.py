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


# ── Per-user LiteLLM key management ───────────────────────────

async def _ensure_litellm_key(claims: dict) -> str:
    """Get the LiteLLM key for this user (admin must pre-create it).

    Admin provisions users by creating a LiteLLM key with
    key_alias = Keycloak username.
    """
    user_sub = claims.get("sub", "unknown")
    username = claims.get("preferred_username", user_sub)

    # Fast path: already cached from /auth/check
    cached = _key_cache.get(user_sub)
    if cached:
        return cached

    # Slow path: check if admin created a key with alias = username,
    # then create a session key (full key only returned by /key/generate)
    authorized = False
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{LITELLM_URL}/key/list",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
        )
        if r.status_code == 200:
            for kh in r.json().get("keys", [])[:200]:
                try:
                    kr = await c.get(
                        f"{LITELLM_URL}/key/info?key={kh}",
                        headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
                    )
                    if kr.status_code == 200:
                        ki = kr.json()
                        info = ki.get("info", {})
                        if info.get("key_alias") == username:
                            authorized = True
                            break
                except Exception:
                    continue

    if not authorized:
        raise PermissionError("No LLM access. Contact admin to provision your account.")

    # Create a session key (full sk-xxx returned only from /key/generate)
    import uuid
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{LITELLM_URL}/key/generate",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}", "Content-Type": "application/json"},
            json={
                "key_alias": f"session-{uuid.uuid4().hex[:8]}",
                "user_id": username,
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
    """Check if a user is authorized to use the LLM.

    After Keycloak login succeeds, the client calls this endpoint
    to verify the user has a LiteLLM account.

    Returns:
      200: { authorized: true, has_key: bool, user: {...} }
      401: missing token
      403: unauthorized or invalid token
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

    # Check if a LiteLLM key exists with alias = Keycloak username
    # Admin pre-creates keys via: /key/generate with key_alias = username
    has_key = False
    skey = ""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{LITELLM_URL}/key/list",
            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
        )
        if r.status_code == 200:
            keys = r.json().get("keys", [])
            # Check cache first
            if user_sub in _key_cache:
                has_key = True
                skey = _key_cache[user_sub]
            else:
                # Scan LiteLLM keys for a matching alias
                for kh in keys[:200]:
                    try:
                        kr = await c.get(
                            f"{LITELLM_URL}/key/info?key={kh}",
                            headers={"Authorization": f"Bearer {LITELLM_MASTER_KEY}"},
                        )
                        if kr.status_code == 200:
                            ki = kr.json()
                            k = ki.get("info", {})
                            if k.get("key_alias") == username:
                                has_key = True
                                break
                    except Exception:
                        continue

    if not has_key:
        return JSONResponse(status_code=403, content={
            "error": "No LLM access. Contact admin to provision your account.",
            "user": username,
        })

    return {
        "authorized": True,
        "has_key": True,
        "user": {
            "sub": user_sub,
            "username": username,
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
    if not auth.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"error": "Missing Bearer token"})

    token = auth.removeprefix("Bearer ")

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
