# Model selection — 9-model bench, 2026-04-17

**TL;DR: Default model changed from Qwen3-Coder-30B-A3B → Qwen2.5-Coder-7B-Instruct.**
The smallest tested model beat everything larger on every fixture, while using
one-third the memory.

## Why we changed

Previous default (Qwen3-Coder-30B-A3B MLX 3-bit) loops on structured output
even with aggressive anti-loop penalties. 2026-04-17 bench reproduced this
(75 duplicate bullets across 6 fixtures vs 2 for the new default). See
commit history for the previous fallback rationale (GPT-OSS-20B, since
superseded).

## Final scorecard

9 models, 6 fixtures, weighted score out of 60. Pass threshold 40, winner
threshold 45. Fixture weights: F1 audit × 3, F2 summarize × 2, F3 classify ×
1, F4 group-commits × 2, F5 feature-audit × 3, F6 find × 1.

| Rank | Model | Size (4-bit unless noted) | Score | Total time | Dup bullets | Verdict |
|---|---|---|---|---|---|---|
| **1** | **Qwen2.5-Coder-7B-Instruct** | **4.3 GB** | **60.0/60** | **51 s** | 2 | ⭐ **new default** |
| 2 | Qwen3-Coder-30B-A3B (3-bit MoE) | 13.4 GB | 58.6/60 | 77 s | **75** | loops — unreliable |
| 3 | Qwen2.5-Coder-14B-Instruct | 8.3 GB | 56.2/60 | 88 s | 0 | solid, slower than the 7B |
| 4 | DeepSeek-R1-Distill-Qwen-14B | 8.3 GB | 55.0/60 | 304 s | 0 | strong reasoning, 6× slower, fails classify |
| 5 | GPT-OSS-20B (prev. fallback) | 12.1 GB | 51.2/60 | 65 s | 0 | good free-form, weaker than 7B on code |
| 6 | Qwen3-14B | 8.3 GB | 43.8/60 | 281 s | 0 | thinking mode wrecks latency + classify |
| 7 | Phi-4 | 8.3 GB | 40.9/60 | 67 s | 0 | under-produces on verbose fixtures |
| 8 | Qwen3-8B | 4.6 GB | 36.9/60 | 235 s | 0 | **fails** pass threshold |
| 9 | Qwen3.5-9B | 6.0 GB | 11.6/60 | — | — | **crashed** on F5 (MLX engine bug) |

Full fixture-level JSON: `/tmp/bench_all.json` on the server Mac. Bench
scripts: `/tmp/bench2.mjs` (fixtures + scoring) and `/tmp/bench_all.sh`
(sequential driver).

## Task-specific behavior observed

- **Thinking / reasoning-channel models are a trap for structured output.**
  Qwen3-8B, Qwen3-14B, Qwen3.5-9B and DeepSeek-R1-Distill all return 0/2 on
  the one-word classify fixture because they exhaust the token budget in the
  reasoning channel before emitting the answer. They also hit max_tokens
  mid-output on F4/F5.
- **Coder-tuned beats general.** Qwen2.5-Coder-7B (4.3 GB) beats Qwen2.5
  general-14B on every structured fixture in our set, despite being half the
  size.
- **Qwen3-Coder-30B-A3B 3-bit still loops**, even with `frequency_penalty 1.0
  / presence_penalty 0.5 / repetition_penalty 1.2`. Penalties help but do not
  eliminate the duplicate-bullet storm on summarize and find. Score remains
  high only because the duplicated content happens to cover the topic
  checks.

## Why a 7B wins on an 18 GB Mac

- 4.3 GB resident + ~2 GB KV cache at 131K context = ~6 GB used.
- ≥ 8 GB free → bigger context window, OR a parallel companion model (see
  "Further offload" below).
- Dense 7B at 4-bit runs ~40–60 tok/s on M3 Pro; first token latency <1 s
  — critical for the high-call-rate classify and find tools.

## How to apply

### On the server Mac

```bash
cd path/to/claude-local-llm-setup
git pull
bash scripts/recommended-load.sh   # unloads, loads Qwen2.5-Coder-7B at 131K
lms ps                             # verify
```

### On the client laptop

Nothing to change in your shell. The MCP bridge reads `LOCAL_LLM_MODEL` from
its environment; if you never set it, the new default in `server.mjs` is
`qwen2.5-coder-7b-instruct` and the next Claude Code session will pick it up
automatically.

If you *have* pinned `LOCAL_LLM_MODEL` in your MCP registration or shell
rc file, update it:

```bash
claude mcp remove local-llm-bridge
claude mcp add local-llm-bridge \
  --env LOCAL_LLM_URL=http://<server-hostname>.local:1234/v1/chat/completions \
  --env LOCAL_LLM_MODEL=qwen2.5-coder-7b-instruct \
  -- node /absolute/path/to/mcp-bridge/server.mjs
```

Then restart Claude Code.

## Further offload — what to do with the 8+ GB of free memory

The 7B default leaves significant headroom on an 18 GB Mac. Three options
in increasing ambition:

1. **Bigger context.** Already applied — `recommended-load.sh` now loads at
   `--context-length 131072` (128K). Can bundle whole-feature audits in one
   call.
2. **Parallel companion for non-code tasks.** Load a second model alongside
   for workload the 7B is not specialised for:
   - `Qwen2.5-VL-7B-Instruct` (~5 GB) — screenshot analysis, PDF OCR,
     diagram-to-code. Unlocks a new `local_analyze_image` tool.
   - `nomic-embed-text-v1.5` is already loaded — use it for a
     `local_semantic_search` tool across the repo.
3. **Escalation tier.** Keep `qwen2.5-coder-14b-instruct` warm in LM Studio
   JIT cache and add a `local_deep_audit` tool that routes to the 14B for
   cases where the 7B's output looks uncertain (rule-7 escalations).

See `08-parallel-companion.md` (to be written) for the implementation
details.

## Re-probe triggers

Re-run `node /tmp/bench2.mjs <model-id>` against the full 9-model shortlist
when:

- LM Studio ships a new MLX engine (may fix Qwen3.5 / Gemma 4 loading).
- A new coder-specialized model drops in the 4–14 GB class.
- You notice `rule-7` escalations firing more than 1-in-20.
- Hardware changes (new Mac, more unified memory).

Bench fixtures live in `/tmp/bench2.mjs`. Rubric lives at the top of this
doc. Ground truth is hand-curated per fixture — re-check before trusting
scores if the fixtures are edited.
