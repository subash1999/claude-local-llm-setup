# Trust-map patch — 2026-04-17 capability-map bench

Apply to `claude-local-llm-setup/mcp-bridge/CLAUDE-routing-policy.md` between the `user-trust-map START` / `user-trust-map END` sentinels.

## Key new findings

1. **Context window is volatile.** LM Studio reloaded 7B mid-bench; ctx dropped from ~40 960 actual tokens accepted to ~4 096 actual tokens accepted between leg runs. Rule-4 doubt-trigger list must grow a new entry: **HTTP 400 `greater than context length` is not a model failure — it's a server-side config/reload artifact. Retry at shorter input before escalating.**
2. **Loop pathology is bridge-layer, not model-layer.** Direct LM Studio calls on `repetition-bait.ts` (30 near-identical functions) + `huge` fixture returned clean `no findings` on both 7B and 14B. The `local_feature_audit` NIT-loop / BLOCKER-loop from 2026-04-17 therefore lives in the bridge's feature_audit prompt template + output-parse path, not in the model weights. **Bridge-side fix is viable.**
3. **Accuracy on planted-bug fixture: 7B and 14B both P=R=1.0** on 6-bug single-file audit. Line-number drift 1-7 for 7B; 1-3 for 14B. Substance correct; positions approximate.
4. **Adversarial robustness (empty/binary/repetition/huge):** both models correctly say `no findings` without loop on direct-call path.

## Proposed patch

```markdown
| Tool | Trust | Symptom / date |
|---|---|---|
| `local_ask` (short enum/classify, ≤100 out tokens) | 🟢 | unchanged from 2026-04-17 |
| `local_ask` (long-form reasoning, >200 out tokens) | 🟢 | unchanged |
| `local_audit` | 🟢 | re-verified 2026-04-17 Leg E: 6/6 planted-bug recall P=R=1.0 on 7B + 14B via direct-call path |
| `local_summarize` | 🟢 | unchanged |
| `local_find` | 🟢 | unchanged |
| `local_review` | 🟢 | unchanged |
| `local_diff_review` | 🟢 | unchanged |
| `local_group_commits` | 🟢 | unchanged |
| `local_feature_audit` | 🟡 partial | **2026-04-17 Leg A confirmed loop bug at 6 files migrated from NIT section to BLOCKER section (real findings #1-10 correct, #11+ fabricated at +5 line-offset). Advice: read first 10 findings, stop at first duplicate-symbol line. Bridge-side fix candidate: truncate output when same `symbol@line` repeats with mechanical offset.** Base model on direct-call path does NOT loop (verified Leg C adversarial + Leg E accuracy) — pathology is bridge prompt template, not model. |
| `local_semantic_search` | 🟢 | unchanged |
| `local_deep_audit` (14B escalation) | 🟢 | re-verified 2026-04-17 Leg E: 6/6 P=R=1.0 planted-bug recall, tighter line-number accuracy than 7B (drift 1-3 vs 7B 1-7). |

### New rule — server state volatility

**11. Context window volatility.** LM Studio may auto-unload/reload a model between calls with a different `context_length` config. A prior-session success at N input tokens is not a guarantee for the next call. Treat `HTTP 400 — tokens greater than context length` as a retry-at-shorter-input signal, NOT as rule-4 doubt trigger. If shrinking to ~4 k tokens still fails, fall back per rule 10. Consult `local_capabilities` (cached per session) for advertised context — but empirical ceiling per call is authoritative.

### Measured ceilings (2026-04-17)

| Model | Ceiling observed (bench) | Steady-state clean range | Notes |
|---|---|---|---|
| qwen2.5-coder-7b-instruct | ~38 000 actual tokens (Leg B initial) → ~4 096 actual tokens (post-reload) | 3/3 anchor recall 2 k – 38 k during stable window | LM Studio may reload with smaller ctx between sessions |
| qwen2.5-coder-14b-instruct | not sweep-tested; JIT-loaded; passes 4 k adversarial + planted-bug single file | — | MUST serialize (concurrency 1/1); ~8 s JIT first call |
```
