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
