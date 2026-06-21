"""
Mock server for proxy performance testing.

Replaces Keycloak + LiteLLM so we can isolate proxy performance:
  - JWKS endpoint         → /realms/<realm>/protocol/openid-connect/certs
  - Token generation      → /generate-token (for test clients)
  - LiteLLM user list     → GET /user/list
  - LiteLLM key generate  → POST /key/generate
  - LiteLLM key block     → POST /key/block
  - LiteLLM chat          → POST /v1/chat/completions
  - LiteLLM models        → GET /models
  - Health                → GET /health
"""

import os
import json
import base64
import time
import uuid
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.backends import default_backend

# ── Config ────────────────────────────────────────────────────
PORT = int(os.getenv("PORT", "9999"))
KC_REALM = os.getenv("KC_REALM", "device-flow")
KC_ISSUER = os.getenv("KC_ISSUER", f"http://mock:{PORT}/realms/{KC_REALM}")
MAX_USERS = int(os.getenv("MAX_USERS", "500"))  # users in the /user/list response
KEY_DIR = "/app/keys"
PRIVATE_KEY_PATH = os.path.join(KEY_DIR, "private.pem")
PUBLIC_KEY_PATH = os.path.join(KEY_DIR, "public.pem")

# Simulated delay in ms for each LiteLLM endpoint (to mimic real latency)
LITELLM_DELAY_MS = float(os.getenv("LITELLM_DELAY_MS", "5"))
# Simulated delay in ms for Keycloak JWKS fetch
KC_DELAY_MS = float(os.getenv("KC_DELAY_MS", "10"))


# ── RSA key pair management ───────────────────────────────────

def _ensure_keys():
    os.makedirs(KEY_DIR, exist_ok=True)
    if not os.path.exists(PRIVATE_KEY_PATH):
        key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend(),
        )
        with open(PRIVATE_KEY_PATH, "wb") as f:
            f.write(key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            ))
        with open(PUBLIC_KEY_PATH, "wb") as f:
            f.write(key.public_key().public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ))

    with open(PRIVATE_KEY_PATH, "rb") as f:
        pk = serialization.load_pem_private_key(f.read(), password=None)
    with open(PUBLIC_KEY_PATH, "rb") as f:
        pub = serialization.load_pem_public_key(f.read())
    return pk, pub


private_key, public_key = _ensure_keys()


# ── JWKS construction (RFC 7517) ──────────────────────────────

def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _build_jwks():
    nums = public_key.public_numbers()
    n_bytes = nums.n.to_bytes((nums.n.bit_length() + 7) // 8, "big")
    e_bytes = nums.e.to_bytes((nums.e.bit_length() + 7) // 8, "big")
    return {
        "keys": [
            {
                "kty": "RSA",
                "n": _b64u(n_bytes),
                "e": _b64u(e_bytes),
                "alg": "RS256",
                "kid": "mock-key-1",
                "use": "sig",
            }
        ]
    }


JWKS = _build_jwks()


# ── JWT generation for test tokens ────────────────────────────

def generate_token(sub: str, username: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "preferred_username": username or sub,
        "iss": KC_ISSUER,
        "iat": now,
        "exp": now + timedelta(hours=1),
        "jti": uuid.uuid4().hex,
    }
    return pyjwt.encode(payload, private_key, algorithm="RS256", headers={"kid": "mock-key-1"})


# ── Pre-built LiteLLM user list ───────────────────────────────

def _build_user_list():
    users = []
    for i in range(MAX_USERS):
        users.append({
            "user_alias": f"perf-user-{i}",
            "user_id": f"perf-user-id-{i}",
            "models": [],
            "max_budget": None,
        })
    return {"users": users}


USER_LIST_RESPONSE = _build_user_list()

# Track generated session keys (for /key/block)
_generated_keys: dict[str, str] = {}


# ── FastAPI app ───────────────────────────────────────────────

app = FastAPI(title="Mock Perf Server")


async def _simulate_delay(ms: float):
    import asyncio
    if ms > 0:
        await asyncio.sleep(ms / 1000)


# ── Keycloak endpoints ────────────────────────────────────────

@app.get(f"/realms/{KC_REALM}/protocol/openid-connect/certs")
async def jwks():
    await _simulate_delay(KC_DELAY_MS)
    return JSONResponse(content=JWKS)


@app.post("/generate-token")
async def generate_token_endpoint(request: Request):
    """Generate a valid JWT for testing.

    Request body (JSON):
      { "sub": "...", "username": "..." }   (both optional)
    If omitted, a random sub and username are generated.
    """
    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    sub = body.get("sub", f"perf-user-{uuid.uuid4().hex[:6]}")
    username = body.get("username", sub)
    token = generate_token(sub, username)
    return {"access_token": token, "token_type": "bearer", "expires_in": 3600}


# ── LiteLLM endpoints ────────────────────────────────────────

@app.get("/user/list")
async def user_list():
    """Return all pre-built users. The proxy filters by user_alias locally."""
    await _simulate_delay(LITELLM_DELAY_MS)
    return JSONResponse(content=USER_LIST_RESPONSE)


@app.post("/key/generate")
async def key_generate(request: Request):
    """Mock LiteLLM key generation."""
    await _simulate_delay(LITELLM_DELAY_MS)
    body = await request.json()
    key_alias = body.get("key_alias", f"session-{uuid.uuid4().hex[:8]}")
    sk = f"sk-session-{uuid.uuid4().hex}"
    _generated_keys[key_alias] = sk
    return {
        "key": sk,
        "key_alias": key_alias,
        "user_id": body.get("user_id", ""),
    }


@app.post("/key/block")
async def key_block(request: Request):
    """Mock block a session key."""
    await _simulate_delay(LITELLM_DELAY_MS)
    body = await request.json()
    sk = body.get("key", "")
    # Remove from tracked keys
    to_remove = [k for k, v in _generated_keys.items() if v == sk]
    for k in to_remove:
        _generated_keys.pop(k, None)
    return {"status": "blocked"}


@app.post("/v1/chat/completions")
async def chat_completions():
    """Mock LLM chat response."""
    await _simulate_delay(LITELLM_DELAY_MS)
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "mock-model",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Mock response from performance test server."
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 10,
            "total_tokens": 20,
        },
    }


@app.get("/models")
async def list_models():
    return {
        "data": [
            {"id": "mock-model", "object": "model", "created": int(time.time()), "owned_by": "mock"}
        ]
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Entry point ───────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[mock] Starting perf mock server on port {PORT}")
    print(f"[mock] KC_ISSUER = {KC_ISSUER}")
    print(f"[mock] Pre-built {MAX_USERS} users in /user/list")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
