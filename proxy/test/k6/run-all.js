// ──────────────────────────────────────────────────────────────
//  k6 performance test suite for LLM Auth Proxy
//
//  Scenarios:
//    1. health       — smoke test for /health (no auth)
//    2. auth_check   — /auth/check with unique JWTs (cold /user/list)
//    3. chat_cold    — first /v1/chat/completions (full pipeline: JWT →
//                      user_list → key_generate → forward)
//    4. chat_warm    — subsequent /v1/chat/completions (cached session key)
//    5. stale_key    — key blocked then retried (stale-key recovery path)
//    6. mixed        — realistic mix of all the above
//
//  Usage:
//    k6 run run-all.js
//    k6 run --vus 30 --duration 2m run-all.js   (override defaults)
//
//  Environment variables:
//    PROXY_URL   — proxy base URL (default http://localhost:4000)
//    MOCK_URL    — mock server URL  (default http://localhost:9999)
//    K6_VUS      — max virtual users( default taken from scenarios)
// ──────────────────────────────────────────────────────────────

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ── Configuration ─────────────────────────────────────────────
const PROXY = __ENV.PROXY_URL || "http://localhost:4000";
const MOCK = __ENV.MOCK_URL || "http://localhost:9999";

// ── Custom metrics ────────────────────────────────────────────
const errRate = new Rate("errors");

const tHealth = new Trend("health_ms");
const tAuthCheck = new Trend("auth_check_ms");
const tChatCold = new Trend("chat_cold_ms");
const tChatWarm = new Trend("chat_warm_ms");
const tStaleKey = new Trend("stale_key_ms");

const iColdTokens = new Counter("cold_tokens_used");
const iWarmHits = new Counter("warm_cache_hits");
const iStaleRecoveries = new Counter("stale_key_recoveries");

// ── Thresholds ────────────────────────────────────────────────
export const options = {
  thresholds: {
    errors: ["rate<0.05"],             // overall error rate < 5%

    // These thresholds are sanity checks.  Adjust them to match
    // your target deployment environment (bare metal vs Docker vs k8s).
    // On Docker Desktop (Windows/Mac), expect 3-10x higher latency
    // due to the Linux VM networking layer.

    health_ms:     ["p(95)<500",  "avg<200" ],
    auth_check_ms: ["p(95)<2000", "avg<1000"],
    chat_cold_ms:  ["p(95)<5000", "avg<2000"],
    chat_warm_ms:  ["p(95)<2000", "avg<800" ],
    stale_key_ms:  ["p(95)<3000", "avg<1000"],
  },
  scenarios: {
    // ── 1. Health ───────────────────────────────────────────
    health: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 50 },
        { duration: "20s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      exec: "scenarioHealth",
      gracefulStop: "5s",
    },

    // ── 2. Auth check ───────────────────────────────────────
    auth_check: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 40 },
        { duration: "20s", target: 40 },
        { duration: "10s", target: 0 },
      ],
      exec: "scenarioAuthCheck",
      gracefulStop: "5s",
    },

    // ── 3. Chat completions — cold start ────────────────────
    // Each iteration uses a FRESH user → no cached session key.
    chat_cold: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "20s", target: 10 },
        { duration: "10s", target: 20 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 0 },
      ],
      exec: "scenarioChatCold",
      gracefulStop: "10s",
    },

    // ── 4. Chat completions — warm (cached key) ─────────────
    // Each VU reuses the SAME JWT so the proxy's key cache is hit.
    chat_warm: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 50 },
        { duration: "30s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      exec: "scenarioChatWarm",
      gracefulStop: "5s",
    },

    // ── 5. Stale key recovery ───────────────────────────────
    // Low volume — each iteration: warm call → block key → call again (recovery)
    stale_key: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 5,
      maxDuration: "2m",
      exec: "scenarioStaleKey",
      gracefulStop: "10s",
    },

    // ── 6. Mixed realistic load ─────────────────────────────
    // Simulates real usage: returning users (warm) + new users (cold)
    mixed: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 15 },
        { duration: "15s", target: 30 },
        { duration: "30s", target: 30 },
        { duration: "15s", target: 0 },
      ],
      exec: "scenarioMixed",
      gracefulStop: "10s",
    },
  },
};

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════

// ── Token generation ──────────────────────────────────────────
// The mock server signs RS256 JWTs with the same key the proxy
// fetches from its JWKS endpoint.  This gives us valid tokens.
function fetchToken(sub, username) {
  const res = http.post(
    `${MOCK}/generate-token`,
    JSON.stringify({ sub, username }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "fetch_token" } }
  );
  if (res.status !== 200) {
    console.error(`[WARN] Token fetch failed: ${res.status} ${res.body}`);
    return null;
  }
  return res.json("access_token");
}

// ── Chat request body ─────────────────────────────────────────
const CHAT_BODY = JSON.stringify({
  model: "mock-model",
  messages: [{ role: "user", content: "Hello, performancer!" }],
  max_tokens: 10,
  stream: false,
});

// ── Small random sleep to avoid thundering herd ───────────────
function jitter(maxMs = 300) {
  sleep(Math.random() * maxMs / 1000);
}

// ══════════════════════════════════════════════════════════════
//  Scenario 1: Health
// ══════════════════════════════════════════════════════════════
export function scenarioHealth() {
  const r = http.get(`${PROXY}/health`, { tags: { name: "health" } });
  tHealth.add(r.timings.duration);
  errRate.add(r.status !== 200);
  check(r, { "health ok": (res) => res.status === 200 });
}

// ══════════════════════════════════════════════════════════════
//  Scenario 2: Auth Check
//  Each iteration uses a unique user so /user/list is always
//  fetched from the mock (no caching at this level).
// ══════════════════════════════════════════════════════════════
export function scenarioAuthCheck() {
  const iter = __ITER;
  const sub = `auth-${__VU}-${iter}`;
  const username = `perf-user-${(__VU + iter) % 500}`; // cycle through pre-built users

  const token = fetchToken(sub, username);
  if (!token) {
    errRate.add(1);
    return;
  }

  const r = http.get(`${PROXY}/auth/check`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: "auth_check" },
  });
  tAuthCheck.add(r.timings.duration);
  errRate.add(r.status !== 200);
  check(r, {
    "auth check ok": (res) => res.status === 200,
  });
}

// ══════════════════════════════════════════════════════════════
//  Scenario 3: Chat completions — COLD start
//  Every request uses a BRAND-NEW user → the proxy must:
//    1. Validate JWT (local)
//    2. Fetch /user/list from mock
//    3. Call /key/generate on mock
//    4. Forward /v1/chat/completions to mock
// ══════════════════════════════════════════════════════════════
export function scenarioChatCold() {
  const iter = __ITER;
  const sub = `cold-${__VU}-${iter}`;
  const username = `perf-user-${(__VU + iter) % 500}`;

  const token = fetchToken(sub, username);
  if (!token) {
    errRate.add(1);
    return;
  }
  iColdTokens.add(1);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const r = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
    headers,
    tags: { name: "chat_cold" },
  });
  tChatCold.add(r.timings.duration);
  errRate.add(r.status !== 200);
  check(r, {
    "chat cold ok": (res) => res.status === 200,
    "has choices": (res) => {
      try {
        return JSON.parse(res.body).choices && JSON.parse(res.body).choices.length > 0;
      } catch (_) { return false; }
    },
  });
}

// ══════════════════════════════════════════════════════════════
//  Scenario 4: Chat completions — WARM (cached session key)
//  Each VU uses a FIXED token across all iterations.
//  The proxy caches the session key by JWT sub → fast path.
//
//  Design: first request primes the cache (throwaway, not measured),
//  subsequent iterations measure the true warm-path performance.
// ══════════════════════════════════════════════════════════════
const _warmTokens = {}; // per-VU token cache
const _warmPrimed = {}; // per-VU prime flag

export function scenarioChatWarm() {
  const vu = `vu-${__VU}`;
  if (!_warmTokens[vu]) {
    const sub = `warm-${__VU}`;
    const username = `perf-user-${__VU % 500}`;
    _warmTokens[vu] = fetchToken(sub, username);
    if (!_warmTokens[vu]) {
      errRate.add(1);
      return;
    }
  }

  const headers = {
    Authorization: `Bearer ${_warmTokens[vu]}`,
    "Content-Type": "application/json",
  };

  // Prime the cache (first request creates the session key)
  if (!_warmPrimed[vu]) {
    const prime = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
      headers,
      tags: { name: "warm_prime" },
    });
    _warmPrimed[vu] = true;
    if (prime.status !== 200) {
      errRate.add(1);
      check(prime, { "warm prime ok": (r) => r.status === 200 });
      return;
    }
  }

  // Now measure the true warm-path (cached key)
  iWarmHits.add(1);
  const r = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
    headers,
    tags: { name: "chat_warm" },
  });
  tChatWarm.add(r.timings.duration);
  errRate.add(r.status !== 200);
  check(r, {
    "chat warm ok": (res) => res.status === 200,
  });
}

// ══════════════════════════════════════════════════════════════
//  Scenario 5: Stale key recovery
//
//  1. First request → creates session key (cold start)
//  2. Logout → blocks the session key
//  3. Second request → cached key rejected (401) → proxy auto-
//     recovers: clears cache, re-checks user, creates new key
// ══════════════════════════════════════════════════════════════
export function scenarioStaleKey() {
  const iter = __ITER;
  const sub = `stale-${__VU}-${iter}`;
  const username = `perf-user-${(__VU + iter) % 500}`;

  const token = fetchToken(sub, username);
  if (!token) {
    errRate.add(1);
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Step 1: Cold request → creates session key
  const r1 = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
    headers,
    tags: { name: "stale_pre" },
  });
  check(r1, { "stale pre ok": (res) => res.status === 200 });

  if (r1.status !== 200) {
    errRate.add(1);
    return;
  }

  // Step 2: Logout → blocks the session key in LiteLLM
  const logout = http.post(`${PROXY}/logout`, null, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: "stale_logout" },
  });
  check(logout, { "logout ok": (res) => res.status === 200 });

  // Small pause to let the proxy process
  sleep(0.5);

  // Step 3: Another request → proxy gets 401 from LiteLLM (key blocked)
  //          → auto-recovers: clears cache, creates new key, retries
  const r2 = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
    headers,
    tags: { name: "stale_recovery" },
  });
  tStaleKey.add(r2.timings.duration);
  errRate.add(r2.status !== 200);
  iStaleRecoveries.add(1);
  check(r2, {
    "stale recovery ok": (res) => res.status === 200,
  });
}

// ══════════════════════════════════════════════════════════════
//  Scenario 6: Mixed realistic load
//
//  Mimics real-world usage:
//    - 70 % requests use cached session keys (returning users)
//    - 20 % are new users going through cold start
//    - 10 % are auth checks
// ══════════════════════════════════════════════════════════════
const _mixedTokens = {};

export function scenarioMixed() {
  const vu = `vu-${__VU}`;
  let token = _mixedTokens[vu];

  // First time: generate a token and do a cold start
  if (!token) {
    const sub = `mixed-${__VU}`;
    const username = `perf-user-${__VU % 500}`;
    token = fetchToken(sub, username);
    if (!token) {
      errRate.add(1);
      return;
    }
    _mixedTokens[vu] = token;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const roll = Math.random();

  if (roll < 0.70) {
    // ── Warm chat ──────────────────────────────────────────
    const r = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
      headers,
      tags: { name: "mixed_warm" },
    });
    tChatWarm.add(r.timings.duration);
    iWarmHits.add(1);
    errRate.add(r.status !== 200);
    check(r, { "mixed warm ok": (res) => res.status === 200 });

  } else if (roll < 0.90) {
    // ── New user cold start ────────────────────────────────
    // Fresh token = different user = cold start
    const coldSub = `mixed-cold-${__VU}-${__ITER}`;
    const coldUser = `perf-user-${(__VU + __ITER * 7) % 500}`;
    const coldToken = fetchToken(coldSub, coldUser);
    if (!coldToken) {
      errRate.add(1);
      return;
    }
    iColdTokens.add(1);

    const coldHeaders = {
      Authorization: `Bearer ${coldToken}`,
      "Content-Type": "application/json",
    };
    const r = http.post(`${PROXY}/v1/chat/completions`, CHAT_BODY, {
      headers: coldHeaders,
      tags: { name: "mixed_cold" },
    });
    tChatCold.add(r.timings.duration);
    errRate.add(r.status !== 200);
    check(r, { "mixed cold ok": (res) => res.status === 200 });

  } else {
    // ── Auth check ─────────────────────────────────────────
    const r = http.get(`${PROXY}/auth/check`, {
      headers,
      tags: { name: "mixed_auth_check" },
    });
    tAuthCheck.add(r.timings.duration);
    errRate.add(r.status !== 200);
    check(r, { "mixed auth ok": (res) => res.status === 200 });
  }

  // Small jitter to avoid synchronized requests
  jitter(500);
}
