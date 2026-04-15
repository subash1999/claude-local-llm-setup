# Research Notes & Sources

## Hardware baseline — this Mac

- Apple M3 Pro, 12 cores, **18 GB unified memory**
- macOS 26.3.1
- LAN IP 192.168.1.21, hostname `subashs-macbook-pro.local`
- 278 GB free disk

## Decision matrix — why Qwen3-Coder-30B-A3B won

Candidates evaluated, scored on the user's actual requirements (Claude Max 20x offload + LAN server + 18 GB budget + code-heavy workload).

| Model | quant size | Usable ctx on 18 GB | M3 Pro est. speed | Coding quality | Claude Code plumbing (Apr 15 2026) | Multimodal | Verdict |
|---|---|---|---|---|---|---|---|
| **Qwen3-Coder-30B-A3B (MLX 3-bit)** | **12.4 GB** | 32K | **63 tok/s warm (measured)** | **best in fit-class** | ✅ mature | text | **PICKED** |
| Qwen3-Coder-30B-A3B (MLX 4-bit) | 16.0 GB | 4–8K | ~35–50 tok/s | marginally better | ✅ mature | text | Too large for 18 GB |
| GPT-OSS-20B | ~12 GB | 64–96K | ~20–30 | mid | ✅ mature | text | Fallback (doc 04) |
| Gemma 4 26B A4B | ~15.6 GB | **4–8K** | ~30–45 | strong benchmarks | ❌ 8+ open bugs | text+image | Revisit (doc 05) |
| Gemma 4 E4B | ~5.6 GB | 96–128K | ~50–70 | lower (4.5B eff.) | ⚠️ family bugs | text+image+audio | Revisit (doc 05) |
| Qwen3.5-27B Dense | ~16 GB | 8–16K | ~15–20 | good but general | ✅ | text | Not code-specialized |
| Qwen3.5-35B-A3B | ~19 GB | **over budget** | — | — | — | — | Doesn't fit |
| GLM-4.5-Air | 106B (60 GB) | — | — | — | — | — | Nowhere near 18 GB |
| GLM-4.6 | 355B | — | — | — | — | — | Nowhere near 18 GB |

## Measured benchmarks (public data, Apr 2026)

### Gemma 4 26B A4B — MLX on Apple Silicon
- **M5 Max 128 GB (4-bit MLX):** 113 tok/s decode @ 4K context, 30 tok/s @ 256K, peak mem 17.1 GB
- M2 Ultra: >300 tok/s claimed (unverified full config)
- M3 Pro: **no public benchmark** — bandwidth-math extrapolation: ~30–45 tok/s

### Qwen3-Coder-30B-A3B
- Designed as non-thinking code model
- MoE: 30.5 B total, **3.3 B active per token**
- SWE-bench Verified: 51.6% (via OpenHands scaffold)
- LiveCodeBench v5: ~68%
- Native context: 256K
- Unsloth's chat-template fix merged; tool calling stable across llama.cpp / Ollama / LM Studio
- Actual MLX quant sizes (measured from HF, 2026-04-15): 3-bit **12.4 GB**, 4-bit **16.0 GB**, 5-bit 20.1 GB, 6-bit 24.3 GB, 8-bit 32.4 GB, bf16 60.5 GB
- 3-bit pick rationale: 18 GB Mac needs ≤15 GB resident weights to leave room for KV cache + macOS; 4-bit's 16 GB leaves no headroom
- **Measured on this M3 Pro 18 GB** (2026-04-15, MLX 3-bit, 32K context, parallel=4): load time 33.8s, **warm decode 63 tok/s** (SDK-reported 67 tok/s pure decode), TTFT 0.14s, resident memory 12.46 GiB. Initial 18 tok/s measurement was misleading — dominated by first-token latency on short outputs.
- **Speculative decoding tested and rejected on this hardware** (2026-04-15): pairing main with Qwen3-1.7B 4-bit draft dropped throughput to 8 tok/s (0.13×) with TTFT ballooning to 15s. Root cause: unified memory bandwidth contention between two MLX models on 18 GB, plus the 3.3 B-active-param MoE is already so cheap per token that spec overhead dominates. MLX also requires `--parallel 1` for spec, losing multi-request serving. Conclusion: baseline config is optimal.
- **Parallel-probe findings** (`scripts/find_parallel.py`, 2026-04-15): dual-model co-residency on 18 GB is viable at `parallel=2, ctx=32K` for HEAVY and `parallel=2, ctx=4K` for TINY. Swap delta +481 MB (under the 500 MB threshold). Alternatives measured:
  - `parallel=4` both: +511 MB swap (FAIL, marginal)
  - `parallel=1` both: +1061 MB swap (FAIL — counterintuitive, likely macOS paging preferring to keep warm pages vs. aggressive eviction at higher concurrency)
  - Single-stream chat at `parallel=1`: HEAVY reply took 89s for 40 tokens (absurd vs. 20s at parallel=2). KV cache pre-allocation at higher parallelism seems to stabilize memory layout.
  - Weights alone: HEAVY 13.37 GB + TINY 984 MB = 14.35 GB. On 18 GB total with ~2 GB macOS kernel/wired, only ~2 GB room left for KV + app state. Explains the tight fit.
- **Probe methodology**: `probe()` unloads all models → measures baseline swap_used → loads both with candidate params → fires warmup chat at each (thinking ON, realistic 120-200 token budgets) → measures swap_used again. PASS requires swap delta ≤ 500 MB AND both chats returned non-empty output. Free-MB floors were dropped from the criteria — macOS reassigns free pages constantly, so the number is noise. Swap delta is the truthful signal.

### GPT-OSS-20B
- 20B dense, Apache 2.0
- TauBench tool-use: **matches o4-mini**
- GPQA (high reasoning mode): 68.8%
- LM Studio's featured example for Claude Code blog

### Gemma 4 E4B
- 4.5 B effective / 8 B with embeddings, 128K context, multimodal (text + image + audio)
- MacBook M4 Pro 24 GB: 49 tok/s MLX, 57 tok/s Ollama (measured)
- MacBook Air M3/M4 MLX: 90–120 tok/s claimed (optimal conditions)
- Mac Mini M4 24 GB: 24 tok/s (Rviragh Medium test)

## Gemma 4 launch issues (as of 2026-04-15)

See `05-revisit-gemma-4.md` for full list. Headlines:
1. Tool calls misrouted to `reasoning` field in Ollama
2. LM Studio tool-call looping bug with 26B A4B
3. vLLM streaming tool calls broken
4. MLX runtime doesn't support architecture
5. llama.cpp `<unused24>` token flood
6. 31B Dense emits only `"---\n"` in LM Studio (Simon Willison, Apr 2)
7. Flash Attention hangs on 31B with prompts >500 tokens on Apple Silicon

Upstream fixes (llama.cpp PRs #21326, #21343, #21697) merged but not yet shipped in Ollama/LM Studio.

## Claude Code + local model — the three routing patterns

### Pattern 1 — `claude` cloud mode (default)
Max 20x subscription OAuth, talks to api.anthropic.com. Expensive if overused.

### Pattern 2 — `claude-local` whole-session local mode (doc 02)
Set `ANTHROPIC_BASE_URL` env var to LM Studio's Anthropic-compatible endpoint. Entire session runs on local. Zero cloud quota. Lower quality.

### Pattern 3 — MCP bridge with custom skills (doc 06)
Main session stays on cloud Claude (orchestration). Subagent-ish tasks (audit, review, find, summarize) routed to home Mac via MCP tools invoked from custom skills. **Best of both.**

## Why Claude-Code-Router (musistudio) is NOT used here

- Expects API key for cloud provider
- Max 20x is OAuth subscription — no API key
- Mixing OAuth Claude + proxy-auth model in one session breaks the auth flow
- MCP bridge is the correct pattern for subscription users

## Apple Silicon MLX notes (Apr 2026)

- Ollama 0.19+ ships MLX backend for Apple Silicon. Decode ~93% faster than previous Metal path.
- Ollama 0.20 in development will add Gemma 4 architecture to MLX backend.
- For 30B-A3B-sized MoE models, MLX community quants (4-bit) match llama.cpp quality at smaller size.
- LM Studio bundles its own MLX runtime — no separate install.

## The Max 20x math

- $200/mo ÷ 30 days = ~$6.67/day amortized
- User currently exhausts quota in 4–5 days → actual burn rate ~$40–50/day of equivalent usage
- If local offload handles 60% of total load → stretch to 10–12 days, i.e. the full monthly cycle
- Electricity cost of Mac server running 24/7: $2–3/month (negligible)

## Primary sources consulted (Apr 2026)

### Models & benchmarks
- [Gemma 4 — Google DeepMind](https://deepmind.google/models/gemma/gemma-4/)
- [Gemma 4: Byte for byte, the most capable open models — Google Blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
- [Welcome Gemma 4 — Hugging Face blog](https://huggingface.co/blog/gemma4)
- [Ollama Library — gemma4](https://ollama.com/library/gemma4)
- [Ollama Library — gemma4:e4b](https://ollama.com/library/gemma4:e4b)
- [mlx-community/gemma-4-26b-a4b-it-4bit — Hugging Face](https://huggingface.co/mlx-community/gemma-4-26b-a4b-it-4bit)
- [mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit — Hugging Face](https://huggingface.co/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit)
- [Qwen3-Coder — Unsloth docs](https://unsloth.ai/docs/models/qwen3-coder-how-to-run-locally)
- [Gemma 4 — Unsloth docs](https://unsloth.ai/docs/models/gemma-4)
- [Incept5/gemma4-benchmark (MLX Apple Silicon measurements)](https://github.com/Incept5/gemma4-benchmark)

### Community reviews (Apr 2–15, 2026)
- [Simon Willison — Gemma 4](https://simonwillison.net/2026/Apr/2/gemma-4/)
- [Interconnects (Nathan Lambert) — Gemma 4 and what makes an open model succeed](https://www.interconnects.ai/p/gemma-4-and-what-makes-an-open-model)
- [Latent.Space — Gemma 4: The best small Multimodal Open Models](https://www.latent.space/p/ainews-gemma-4-the-best-small-multimodal)
- [Gemma 4 Benchmarks: The Numbers That Actually Matter — Moksh S](https://medium.com/@moksh.9/heres-a-tighter-benchmark-focused-blog-post-501c5ea829f4)
- [Gemma 4 on Apple Silicon — SudoAll](https://sudoall.com/gemma-4-31b-apple-silicon-local-guide/)
- [Gemma 4 in LM Studio: What Actually Held Up — Lakshmi narayana U (Medium)](https://python.plainenglish.io/gemma-4-in-lm-studio-what-actually-held-up-in-a-real-local-benchmark-10cf33afde02)
- [I Tested Every Gemma 4 Model Locally — akartit (DEV.to)](https://dev.to/akartit/i-tested-every-gemma-4-model-locally-on-my-macbook-what-actually-works-3g2o)
- [Gemma 4 Performance Showdown: Linux vs Mac — Lothar Schulz](https://www.lotharschulz.info/2026/04/04/gemma-4-performance-showdown-linux-vs-mac-benchmarks/)
- [Running Gemma 4 locally with LM Studio CLI and Claude Code — Hacker News](https://news.ycombinator.com/item?id=47651540)
- [Can Google's Gemma4:e4b (10 GB) benchmark itself? — Rviragh](https://medium.com/@rviragh/can-googles-gemma4-e4b-10-gb-benchmark-itself-06b79218a071)

### Claude Code + local models
- [LM Studio — Use your LM Studio Models in Claude Code](https://lmstudio.ai/blog/claudecode)
- [Unsloth — How to Run Local LLMs with Claude Code](https://unsloth.ai/docs/basics/claude-code)
- [Claude Code LLM Gateway Docs](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code Router — musistudio on GitHub](https://github.com/musistudio/claude-code-router)
- [LiteLLM Claude Code Quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- [Connecting Claude Code to Local LLMs — Michael Hannecke](https://medium.com/@michael.hannecke/connecting-claude-code-to-local-llms-two-practical-approaches-faa07f474b0f)
- [MCP Servers — Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/mcp)

### Bug trackers
- [ollama/ollama#15368 — Gemma 4 Apple Silicon issues](https://github.com/ollama/ollama/issues/15368)
- [lmstudio-ai/lmstudio-bug-tracker#1732 — Gemma 4 Claude Code tool loop](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1732)
- [vllm-project/vllm#39043 — vLLM Gemma 4 Claude Code tool calling](https://github.com/vllm-project/vllm/issues/39043)
- [ggml-org/llama.cpp#21321 — Gemma 4 `<unused24>` tokens](https://github.com/ggml-org/llama.cpp/issues/21321)
- [ggml-org/llama.cpp#21726 — Gemma 4 gibberish with -nkvo](https://github.com/ggml-org/llama.cpp/issues/21726)

### Coding benchmarks
- [SWE-bench Leaderboards](https://www.swebench.com/)
- [SWE-rebench Leaderboard](https://swe-rebench.com/)
- [Best AI Coding Models 2026 — SWE-Bench Leaderboard](https://localaimaster.com/models/best-ai-coding-models)
- [Best Local Coding Models Ranked — InsiderLLM](https://insiderllm.com/guides/best-local-coding-models-2026/)
- [Local LLM vs Claude for Coding — Kunal Ganglani](https://www.kunalganglani.com/blog/local-llm-vs-claude-coding-benchmark)
- [Claude Code vs Aider 2026 — GoodVibeCode](https://www.goodvibecode.com/compare/claude-code-vs-aider)

### Apple Silicon inference
- [Ollama 0.19 MLX backend announcement](https://ollama.com/blog/mlx)
- [Ollama 0.19 MLX benchmarks — Ewan Mak (Medium, Apr 2026)](https://medium.com/@tentenco/ollama-0-19-ships-mlx-backend-for-apple-silicon-local-ai-inference-gets-a-real-speed-bump-878b4928f680)
- [Ollama MLX vs Metal — andrew.ooo](https://andrew.ooo/answers/ollama-mlx-vs-ollama-metal-apple-silicon-2026/)
