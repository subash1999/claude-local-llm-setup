# Local LLM Server for Claude Code Offload

**Date set up:** 2026-04-15
**Goal:** Offload routine coding work from Claude Max 20x ($200/mo, burning through in 4–5 days) to a free local model on the MacBook Pro, accessed over LAN from the other laptop.

## The decision

**Model:** `Qwen3-Coder-30B-A3B` (MLX 4-bit)
**Runtime:** LM Studio (exposes native Anthropic `/v1/messages` endpoint — no proxy)
**Server:** this MacBook Pro M3 Pro 18 GB
**Client:** other laptop running Claude Code

Claude Code on the client laptop has **three usage modes**:

1. **Cloud mode** (default `claude`) — real Claude via Max 20x subscription. Orchestration + hard reasoning.
2. **Full-local mode** (`claude-local` alias) — Qwen3-Coder-30B-A3B on home server. Offline / experimental / fully-free mode.
3. **Hybrid / free-subagents mode** (recommended daily driver) — cloud Claude as orchestrator; audits, reviews, file-finds, and summaries routed to the home Mac via an **MCP bridge** (doc 06). This is the mode that actually stretches Max 20x meaningfully, since subagent/delegation work eats most of the quota.

## Why this pick (short version)

- Purpose-built coding model → actually replaces Claude-level work, not just supplements it
- MoE with 3.3 B active params → ~35–50 tok/s decode on M3 Pro despite 30 B total
- 15 GB weights at Q4 → fits 18 GB with ~16–32K usable context
- Mature Claude Code integration, no tool-calling bugs (unlike Gemma 4's April 2026 launch issues)
- Apache 2.0

## Why *not* the alternatives

- **Gemma 4 26B A4B** — best benchmark scores but plumbing broken across Ollama/LM Studio/vLLM as of Apr 15, 2026. See `05-revisit-gemma-4.md`.
- **Gemma 4 E4B** — too small (4.5 B effective) to take real coding load off Claude
- **GPT-OSS-20B** — great reasoning, weaker coding. Documented as fallback in `04-fallback-gpt-oss-20b.md`.
- **Qwen3.5-35B-A3B** — exceeds 18 GB budget once KV cache counted

## Why not `claude-code-router` with subscription

Claude Max 20x is **OAuth-based**, not API-key-based. Tools like `claude-code-router` that do hybrid cloud+local routing in a single session need an API key for the cloud side. Since you're on subscription, that pattern **doesn't cleanly work**. Instead we use:

- **Two-mode env-var toggle** (doc 02) for whole-session switching
- **MCP bridge + custom skills** (doc 06) for automatic routing of specific task types (audit/review/find/summarize) to the home Mac while keeping the main session on cloud Claude

## Files in this folder

| File | What's in it |
|---|---|
| `README.md` | You are here |
| `01-server-setup-this-mac.md` | Install LM Studio + Qwen3-Coder on the MacBook |
| `02-client-setup-other-laptop.md` | Install Claude Code + `claude-local` alias on the other laptop |
| `03-usage-patterns.md` | When to use local vs cloud Claude, cheat sheet |
| `04-fallback-gpt-oss-20b.md` | If Qwen3-Coder thrashes on 18 GB, swap to this |
| `05-revisit-gemma-4.md` | Check Gemma 4 again in 6 weeks — what to test |
| **`06-free-subagents-for-claude.md`** | **MCP bridge that routes audits/reviews/file-finds to the home Mac — biggest subscription saver** |
| `07-research-and-sources.md` | Full comparison tables, benchmark data, citations |

## Quick start

1. On this Mac: follow `01-server-setup-this-mac.md` (install LM Studio + model)
2. On the other laptop: follow `02-client-setup-other-laptop.md` (Claude Code + `claude-local` alias)
3. **For the biggest savings, also do `06-free-subagents-for-claude.md`** (MCP bridge for free subagent work)
4. Daily usage cheat sheet: `03-usage-patterns.md`

## LAN addresses (fill in after setup)

- **Server Mac IP:** `192.168.1.21` (confirm with `ipconfig getifaddr en0`)
- **Server Mac hostname:** `subashs-macbook-pro.local`
- **LM Studio port:** `1234`
- **Test endpoint:** `http://192.168.1.21:1234/v1/models`
