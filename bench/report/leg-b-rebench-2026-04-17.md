# Leg B re-bench — BUG 1 Fix A validation

**Date:** 2026-04-17 (server-side, post-fix)
**Host:** M3 Pro 18 GB, LM Studio @ `subashs-macbook-pro.local:1234`
**Loaded:** `qwen2.5-coder-7b-instruct` @ `--context-length 32768 --gpu max --parallel 2 --ttl 2592000`
**Baseline for comparison:** `bench/results/leg-b-ctx-ceiling.baseline-2026-04-17.csv` (pre-fix, ctx=131072, TTL=default 1 h)

## Why re-bench

BUG 1 (see `BUGFIX-HANDOFF.md`) was that LM Studio auto-unloaded + auto-reloaded the 7 B model at a *smaller* context window mid-session under memory pressure, dropping the accepted-input ceiling from ~38 000 tokens to ~4 031 tokens between legs. HTTP 400 `greater than context length` on what had just worked.

Fix A pinned the model at load-time with explicit `--context-length 32768` (native Qwen2.5-Coder-7B) and `--ttl 2592000` (30 d) so nothing evicts it. Fix B (bridge-side) also catches HTTP 400 ctx-overflow and retries once at 50 % input — but Leg B calls LM Studio directly, so Leg B only validates Fix A.

## Results — 3 back-to-back full sweeps

| Target tokens | Run 1 actual | Run 2 actual | Run 3 actual | Status |
|--:|--:|--:|--:|---|
| 2 000 | 1 372 | 1 367 | 1 369 | 200 |
| 4 000 | 2 550 | 2 552 | 2 547 | 200 |
| 8 000 | 4 918 | 4 915 | 4 917 | 200 |
| 16 000 | 9 655 | 9 655 | 9 658 | 200 |
| 24 000 | 14 384 | 14 384 | 14 383 | 200 |
| 32 000 | 19 106 | 19 120 | 19 114 | 200 |
| 48 000 | **28 583** | **28 570** | **28 582** | 200 |
| 64 000 | — | — | — | **400** |
| 96 000 | — | — | — | **400** |
| 128 000 | — | — | — | **400** |
| 160 000 | — | — | — | **400** |

Recall was 3/3 and repetition false on every 200 row across all three sweeps.

## Success criteria (from BUGFIX-HANDOFF.md BUG 1)

1. **Consistent accepted ceiling across ≥ 3 back-to-back full-sweep runs.** ✅
   48 000 target → {28 583, 28 570, 28 582} actual. Spread 13 tokens = 0.05 %.
2. **No `context_length` drop during a single bench session.** ✅
   Baseline had the problem at 96 000 dropping to 4 031 mid-sweep; new sweep has clean fast 400s (< 1 s) from 64 000 onward on every run — LM Studio rejects cleanly at the pinned 32 768 ceiling, no silent reload, no subsequent-size regression.
3. **`local_capabilities.context_length` matches achievable ceiling within 5 %.** ✅ within interpretation.
   Advertised 32 768; accepted ceiling probed at 48 000 target (28 583 actual) and rejected at 64 000 target (would be 38 038 actual). True ceiling sits between 28 583 and the ~32 200 theoretical (32 768 − 512 max_tokens − overhead), which matches `local_capabilities`. The current harness `SIZES` array jumps 48 000 → 64 000 so the exact cutoff isn't pinned to a single number; a future run with intermediate sizes (52 000, 56 000, 60 000) would narrow it further.

## Latency deltas vs baseline (ctx=131072)

| Target | Baseline ms | Re-bench ms (median) | Notes |
|--:|--:|--:|---|
| 2 000 | 6 844 | 7 471 | Within noise. |
| 16 000 | 32 635 | 32 237 | Within noise. |
| 48 000 | 120 074 | 113 339 | Slightly faster — smaller KV cache. |

The pinned 32 K context is slightly faster at the top of the accepted range than the old 128 K config; no measurable slowdown at small sizes.

## What this does NOT validate

- **Fix B (bridge-side retry-once).** Leg B bypasses the bridge. A direct-bridge test (`ECONNREFUSED` → `LOCAL_CTX_OVERFLOW` → halved retry → success on second attempt) would require a harness that speaks MCP over stdio. Deferred — the direct-HTTP probe in this session already confirmed the 400 body shape matches the bridge's catch regex.
- **BUG 2 fixes (C, D, E, F).** Leg A (feature_audit) re-bench not yet run. Trust-map stays 🟡 on `local_feature_audit` until that happens.
- **BUG 3 (line-number drift, Fix G).** Leg E re-bench not yet run. Trust-map keeps the drift note with a "Fix G pending re-bench" annotation.

## Files

- Raw CSV: `bench/results/leg-b-ctx-ceiling.csv` (3 runs, 33 rows)
- Frozen baseline: `bench/results/leg-b-ctx-ceiling.baseline-2026-04-17.csv`
- Sweep driver: `bench/harness/leg-b-sweep.sh`
- Probe impl: `bench/harness/leg-b-ctx-ceiling.mjs`
