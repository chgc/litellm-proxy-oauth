# Proxy Performance Tests

Isolated performance testing for the LLM Auth Proxy (`proxy/main.py`).

## Architecture

```
┌─────────────┐     HTTP      ┌──────────┐     HTTP     ┌──────────────┐
│  k6         │ ────────────→ │  Proxy   │ ───────────→ │  Mock Server │
│  (load gen) │ ←──────────── │  (:4000) │ ←────────── │  (:9999)     │
└─────────────┘               └──────────┘              └──────────────┘
                                                         ├─ JWKS endpoint
                                                         ├─ /generate-token
                                                         ├─ /user/list
                                                         ├─ /key/generate
                                                         ├─ /key/block
                                                         └─ /v1/chat/completions
```

- **k6** — generates HTTP load with configurable scenarios
- **Proxy** — the service under test (JWT validation, key caching, LiteLLM forwarding)
- **Mock Server** — replaces Keycloak + LiteLLM with controlled latency, no external dependencies

## Quick Start

### Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) (or use the Docker image `grafana/k6`)
- Docker & Docker Compose

### 1. Start the perf stack

```bash
cd proxy/test
docker compose -f docker-compose.perf.yml up -d --build
```

Wait for both services to be healthy:

```bash
docker compose -f docker-compose.perf.yml ps
```

### 2. Run the tests

```bash
# Full test suite (all scenarios)
k6 run k6/run-all.js

# Custom VUs / duration for a quick smoke test
k6 run --vus 10 --duration 30s k6/run-all.js

# Point at a different proxy/mock (e.g., if running in CI)
PROXY_URL=http://proxy:4000 MOCK_URL=http://mock:9999 k6 run k6/run-all.js
```

### 3. View results

k6 outputs real-time metrics to stdout:

```
scenario: chat_warm
  ✓ chat warm ok
  ✓ chat warm ok

     chat_warm_ms..............: avg=12.3   min=8.1   med=11.5   max=45.2   p(90)=18.7   p(95)=22.1
     errors....................: 0.2%  ✓ 340      ✗ 2
```

### 4. Clean up

```bash
docker compose -f docker-compose.perf.yml down
```

## Test Scenarios

| # | Scenario | Description | Key Metric |
|---|----------|-------------|------------|
| 1 | `health` | Smoke test `/health` | Baseline latency |
| 2 | `auth_check` | JWT validation + `/user/list` lookup | Auth overhead |
| 3 | `chat_cold` | First request per user: JWT → user list → key generate → forward | Cold start latency (worst case) |
| 4 | `chat_warm` | Subsequent requests: cached session key → forward | Fast path latency (most common) |
| 5 | `stale_key` | Block key → auto-recovery flow | Recovery path latency |
| 6 | `mixed` | 70% warm + 20% cold + 10% auth check | Realistic combined latency |

## Understanding the Metrics

| Metric | Description | (example) Target |
|--------|-------------|-----------------|
| `health_ms` | `/health` response time | p95 < 200ms |
| `auth_check_ms` | `/auth/check` response time | p95 < 1000ms |
| `chat_cold_ms` | First chat request (full pipeline) | p95 < 2000ms |
| `chat_warm_ms` | Cached-key chat request | p95 < 800ms |
| `stale_key_ms` | Stale key recovery request | p95 < 2000ms |
| `errors` | HTTP error rate across all requests | < 5% |

> **Calibrate targets for your environment.** Running in bare-metal Linux vs Docker Desktop (Windows) can show 3-10x difference in latency due to network stack overheads.

## Customizing the Mock Latency

To simulate different backend latencies, set these env vars on the mock service:

```yaml
services:
  mock:
    environment:
      LITELLM_DELAY_MS: "20"   # Simulated LiteLLM latency (default: 5ms)
      KC_DELAY_MS: "30"        # Simulated Keycloak latency (default: 10ms)
      MAX_USERS: "1000"        # Users in /user/list response (default: 500)
```

## Running in CI

```bash
# GitHub Actions / GitLab CI example
docker compose -f proxy/test/docker-compose.perf.yml up -d --build
sleep 10

# Run k6 from Docker
docker run --rm --network=host grafana/k6 run - < proxy/test/k6/run-all.js

# Or if k6 is installed natively
k6 run proxy/test/k6/run-all.js
```

## What's Not Tested

- **Real LiteLLM latency** — the mock adds controlled delay, but real LiteLLM/PostgreSQL latency varies
- **Keycloak token refresh** — the mock generates JWTs directly, skipping the OAuth flow
- **Concurrent key creation** — the proxy serializes key creation per user; concurrent requests from the same user are not tested
- **Memory leak** — long-running tests (>1 hour) to detect `_key_cache` growth
