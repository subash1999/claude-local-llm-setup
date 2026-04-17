# Model benchmark — scripts and results

Self-contained head-to-head benchmark for picking a local model that
survives your Claude Code offload workload. Designed to be re-run in
~30 minutes per model when the landscape shifts.

## What it tests

Six fixtures, chosen because they mirror the actual MCP tool surface
exposed by this repo. Each fixture has a hand-curated ground-truth
rubric; scoring is deterministic.

| # | Fixture | Task class | MCP tool analogue | Weight |
|---|---|---|---|---|
| F1 | audit `auth.js` (SQLi + missing auth) | structured-long | `local_audit` | ×3 |
| F2 | summarize `rate-limiter.js` | free-form | `local_summarize` | ×2 |
| F3 | one-word classify SQLi | classify | `local_ask` short | ×1 |
| F4 | group 29 commits into PR-sized topics | structured-long | `local_group_commits` | ×2 |
| F5 | audit 5-file feature vs spec | structured-long | `local_feature_audit` | ×3 |
| F6 | find auth-relevant files in a tree | structured-short | `local_find` | ×1 |

Max weighted score: **60**. Pass threshold: **40**. Winner threshold: **45**.

## Scoring

Each fixture fires a single chat completion against
`http://127.0.0.1:1234/v1/chat/completions` with the structured-output
penalty profile (`frequency_penalty=1.0`, `presence_penalty=0.5`,
`repetition_penalty=1.2`). We record:

- **wall time** — first token to completion, for latency ranking
- **prompt / completion tokens** — from the usage field
- **duplicate-bullet count** — detects loop pathology (the reason the
  previous default was retired)
- **rubric pass/fail** — regex-level checks on ground truth (does the
  audit catch the real SQLi? does the summary mention the sliding
  window? does classify return one word?)

Score per fixture = `(passed / total_checks) * 5`, then multiplied by
fixture weight. Raw JSON of every response lives in
`results-2026-04-17.json` — verify scoring is fair before trusting
rankings.

## How to run

```bash
# Single model (model must be loaded in LM Studio OR will JIT-load)
node scripts/bench/bench.mjs <model-id>

# Multiple models — unloads, loads, benches each in sequence
bash scripts/bench/bench_all.sh <model-id-1> <model-id-2> ...
```

Outputs land in `/tmp/bench2_results.json` and per-model
`/tmp/bench_<slug>.json`; the driver merges into `/tmp/bench_all.json`.

## 2026-04-17 results

| Rank | Model | Size (4-bit unless noted) | Score | Total time | Dup bullets | Verdict |
|---|---|---|---|---|---|---|
| **1** | **Qwen2.5-Coder-7B-Instruct** | **4.3 GB** | **60.0/60** | **51 s** | 2 | ⭐ **default** |
| 2 | Qwen3-Coder-30B-A3B (3-bit MoE) | 13.4 GB | 58.6/60 | 77 s | **75** | loops |
| 3 | Qwen2.5-Coder-14B-Instruct | 8.3 GB | 56.2/60 | 88 s | 0 | slower than 7B |
| 4 | DeepSeek-R1-Distill-Qwen-14B | 8.3 GB | 55.0/60 | 304 s | 0 | 6× slower, fails classify |
| 5 | GPT-OSS-20B | 12.1 GB | 51.2/60 | 65 s | 0 | strong free-form, weaker code |
| 6 | Qwen3-14B | 8.3 GB | 43.8/60 | 281 s | 0 | thinking mode kills latency |
| 7 | Phi-4 | 8.3 GB | 40.9/60 | 67 s | 0 | under-produces |
| 8 | Qwen3-8B | 4.6 GB | 36.9/60 | 235 s | 0 | **fails** pass threshold |
| 9 | Qwen3.5-9B | 6.0 GB | 11.6/60 | — | — | **crashed** on F5 |

See `../../04-fallback-gpt-oss-20b.md` for analysis and rationale.

## F7 — deep-audit vs heavy regression (separate file)

The 6 fixtures above pick a general HEAVY model. **F7** is a dedicated
regression that exercises `local_deep_audit` (14B) with the HEAVY (7B)
as a side-by-side negative control. It lives in a separate script so
the /60 canon stays pristine.

**Fixture:** 40-LOC `payments/charge.js` with two planted issues:
- **BLOCKER** — SQL injection (string-concatenated idempotency-key SELECT)
- **MAJOR**   — card token logged in plaintext (PCI/PII violation, not
                a classic injection pattern — the complementary failure
                mode that motivates keeping the 14B around)

**Rubric (6 binary checks, 5 pts each, score /5):**
1. `catches_sqli` — mentions SQL + (injection|concat|interpolation)
2. `sqli_is_blocker` — SQLi finding labeled BLOCKER (`[BLOCKER]` or `**BLOCKER**`)
3. `catches_pii_log` — mentions log* + (card|token|pci|pii|sensitive|plaintext|redact|mask)
4. `pii_major_or_blocker` — PII finding labeled BLOCKER or MAJOR
5. `no_invented_lines` — every `:N` citation has N ≤ 40 (fixture size)
6. `no_repetition_loop` — duplicate-bullet count ≤ 1

**Run:**

```bash
# Both models, sequential load/unload:
bash scripts/bench/bench-deep-audit_all.sh

# One model only (must be loaded):
node scripts/bench/bench-deep-audit.mjs qwen2.5-coder-14b-instruct
```

Output lands in `scripts/bench/results-deep-audit-<YYYY-MM-DD>.json`.

### 2026-04-17 results

| Model | SQLi | sev | PII | sev | no-invent | no-loop | Score | Notes |
|---|---|---|---|---|---|---|---|---|
| **Qwen2.5-Coder-14B (DEEP)** | ✓ | ✓ BLOCKER | ✓ | ✗ NIT | ✓ | ✓ | **4.2/5** | Severity under-calibrated on PII |
| Qwen2.5-Coder-7B (HEAVY)     | ✓ | ✓ BLOCKER | ✓ | ✓ BLOCKER | **✗ (41, 44 past EOF)** | ✓ | **4.2/5** | Every finding labeled BLOCKER; **invents line numbers past EOF** |

**Read:** Both models tie on this fixture but with different failure
modes. The 7B hits the "invented line numbers past EOF" symptom that
rule 7 explicitly flags as `🔴`-worthy — and over-labels every finding
as BLOCKER (low severity discrimination). The 14B is disciplined on
line citations but under-labels PII as NIT. Neither is sufficient
alone; cloud is the correct fallback when severity calibration matters
(rule 4b). The `complementary-failure-mode` claim holds in the axes
you probe for — not in raw pass-count.

## Re-probe triggers

Re-run when:
- LM Studio ships a new MLX engine (may fix Qwen3.5 / Gemma 4 loading)
- A new coder-specialised model drops in the 4–14 GB class
- You notice MCP rule-7 escalations firing more than 1-in-20 calls
- Hardware changes (new Mac, more unified memory)

Before trusting a re-run, spot-check the fixture ground truth against
any code patterns that have changed in your actual workload.

## Limitations (read before trusting)

- Six fixtures is a sample. A model that passes here may still fall over
  on real inputs with unusual file shapes. Treat the bench as a filter,
  not a validator.
- Scoring uses regex checks on the response text. A model that rewords
  a correct finding in a way the regex misses will be scored low even
  though it was right. Inspect `results-*.json` before discarding a
  model.
- The bench talks to LM Studio's OpenAI-compatible endpoint directly,
  not through the MCP bridge. It does NOT test caveman mode or the
  per-tool system prompts in `mcp-bridge/server.mjs` — those add a
  second layer of output compression that may shift rankings slightly.
