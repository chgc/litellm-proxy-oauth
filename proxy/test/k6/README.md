# k6 Performance Test Scripts

## Files

| File | Purpose |
|------|---------|
| `run-all.js` | Full test suite — all 6 scenarios, thresholds, custom metrics |

## Running

```bash
# Full suite
k6 run run-all.js

# Smoke test — quick validation
k6 run --vus 5 --duration 30s run-all.js

# Only specific scenarios (set env to filter, or edit options.scenarios)
```

## Output Example

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  scenarios: (6 in total)
  execution: (100% completed)

     ✓ health ok
     ✓ auth check ok
     ✓ chat cold ok
     ✓ chat warm ok
     ✓ stale pre ok
     ✓ logout ok
     ✓ stale recovery ok
     ✓ mixed warm ok

     checks.........................: 99.8%  ✓ 12450    ✗ 25
     data_received..................: 2.1 MB 780 kB/s
     data_sent......................: 1.8 MB 667 kB/s
     http_req_blocked...............: avg=0.2ms
     http_req_connecting............: avg=0.1ms
     http_req_duration..............: avg=45.3ms
     http_req_sending...............: avg=0.1ms
     http_req_tls_handshaking.......: avg=0ms

     auth_check_ms..................: avg=12.3   min=8.1   med=11.5   max=89.2   p(90)=15.1   p(95)=18.7
     chat_cold_ms...................: avg=42.7   min=15.2  med=38.9   max=245.3  p(90)=58.2   p(95)=72.4
     chat_warm_ms...................: avg=9.4    min=5.1   med=8.7    max=68.1   p(90)=12.3   p(95)=15.2
     cold_tokens_used..............: 430
     errors........................: 0.2%  ✓ 25       ✗ 12450
     health_ms.....................: avg=2.1    min=0.5   med=1.8    max=22.4   p(90)=3.2    p(95)=4.1
     stale_key_ms..................: avg=18.7   min=12.4  med=16.8   max=95.2   p(90)=22.4   p(95)=28.9
     warm_cache_hits...............: 2100
     stale_key_recoveries..........: 15
```

## Interpreting Results

- **chat_cold_ms vs chat_warm_ms** — the ratio tells you the overhead of key creation vs the fast path
- **auth_check_ms** — if unexpectedly high, check `/user/list` response size and latency
- **stale_key_ms** — includes the 401 round-trip + recovery; usually ~2× chat_cold
- **errors** — check which endpoints fail; 401s in stale_key scenario are expected but should recover
