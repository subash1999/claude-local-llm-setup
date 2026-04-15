# Revisit — Gemma 4 (set up: 2026-04-15, revisit: ~2026-05-27)

## Why we didn't pick Gemma 4 today

Gemma 4 launched **2026-04-02** (13 days before this setup). Google's published benchmarks are strong — in fact the **best in the fits-on-18 GB category** — but the open-source plumbing is immature:

### Open bugs as of 2026-04-15

1. **Ollama routes Gemma 4 tool calls to `reasoning` field instead of `tool_calls`** → Claude Code never sees the tool call
   - [ollama/ollama#15368](https://github.com/ollama/ollama/issues/15368)
2. **LM Studio Gemma 4 26B A4B stuck repeating the same tool call with Claude Code**
   - [lmstudio-ai/lmstudio-bug-tracker#1732](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1732)
3. **vLLM + Gemma 4 + Claude Code: tool calls fail in streaming mode**
   - [vllm-project/vllm#39043](https://github.com/vllm-project/vllm/issues/39043)
4. **MLX runtime does not yet support the Gemma 4 architecture** — forced to fall back to llama.cpp, ~13% slower
5. **llama.cpp `<unused24>` token flood bug** on 26B A4B
   - [ggml-org/llama.cpp#21321](https://github.com/ggml-org/llama.cpp/issues/21321)
6. **31B Dense Flash Attention hangs** on Apple Silicon for prompts >500 tokens
7. **Gibberish output past ~230 tokens with `-nkvo`** flag
   - [ggml-org/llama.cpp#21726](https://github.com/ggml-org/llama.cpp/issues/21726)
8. **LM Studio 31B Dense emits only `"---\n"` regardless of prompt** (Simon Willison, Apr 2)

Upstream PRs merged in llama.cpp (#21326, #21343, #21697) — not yet shipped in Ollama/LM Studio releases as of this writing.

## What to revisit — 2026-05-27 (~6 weeks after launch)

### Step 1 — Check the bug tracker status

Open each issue above. If most are closed or marked resolved, plumbing has likely converged.

### Step 2 — Check MLX support

```bash
# On the server Mac:
pip show mlx-lm | grep -i version     # need 0.26+ with Gemma 4 support
# Or check: https://github.com/ml-explore/mlx-examples for Gemma 4 in supported models list
```

### Step 3 — Test Gemma 4 26B A4B against current Qwen3-Coder

```bash
# On the server Mac:
lms get "https://huggingface.co/mlx-community/gemma-4-26b-a4b-it-4bit" -y    # ~15.6 GB
lms unload --all
lms load gemma-4-26b-a4b-it --context-length 16384 --keep-alive forever
```

### Step 4 — Run an A/B eval

From the client laptop, pick five real coding tasks from your recent work. Run each against both `claude-local` (Qwen3-Coder) and `claude-local-gemma` (Gemma 4). Grade on:

- ✅ Tool calls emit correctly (no infinite loops, no routing to `reasoning` field)
- ✅ File edits apply cleanly (no mangled diffs)
- ✅ Handles your actual codebase style
- ✅ Speed at least comparable to Qwen3-Coder on M3 Pro
- ✅ Doesn't OOM at 16K context

### Step 5 — Decide

**Switch to Gemma 4 26B A4B if:**
- All of steps 1–4 pass
- Quality on your real tasks is visibly better than Qwen3-Coder
- Tool calls are reliable across at least 20 trials

**Stay on Qwen3-Coder if:**
- Any single bug is still open and affects your workflow
- Quality delta is marginal (don't switch for vibes)

### Step 6 — Fallback: Gemma 4 E4B specifically for subagent work

Regardless of 26B status, Gemma 4 E4B (~5.6 GB MLX) is worth testing for:
- **Multimodal tasks** — only E4B has audio + image input
- **High-throughput simple delegations** — ~50–70 tok/s on M3 Pro
- **Very large context** — up to 128K usable on 18 GB

If you find yourself wanting a fast multimodal "scratch" model, E4B complements Qwen3-Coder.

## Also revisit

### GLM-4.6 / GLM-5 — if smaller variants ship
GLM-4.5-Air is 106B (doesn't fit). But if Z.ai releases a 30B MoE variant (`glm-5-air-mini` or similar) with SWE-bench Verified ≥ 70%, it could top Qwen3-Coder for Claude Code backend use.

### Qwen3.5 Coder — if released
Alibaba typically ships a coder variant after the base model. If `qwen3.5-coder-30b-a3b` ships with stronger code benchmarks, same footprint, it's a drop-in swap.

### Claude Code's own direct local support
Anthropic may eventually add first-class local model support. Check [code.claude.com/docs](https://code.claude.com/docs) changelog for "Local models" section.

## Calendar reminder

```bash
# Run this on the client laptop to set a reminder:
osascript -e 'tell application "Calendar" to tell calendar "Home" to make new event with properties {summary:"Revisit Gemma 4 + local LLM stack", start date:(current date) + (42 * days), end date:(current date) + (42 * days) + (30 * minutes), description:"See /Users/subash/Documents/CODING-SHARED/claude-local-llm-setup/05-revisit-gemma-4.md"}'
```

Or simpler — create an alarm in Reminders for **2026-05-27**.
