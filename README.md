# Local LLM Server for Claude Code Offload

**Date set up:** 2026-04-15
**Goal:** Offload routine coding work from Claude Max 20x ($200/mo, burning through in 4–5 days) to a free local model on the MacBook Pro, accessed over LAN from the other laptop.

## The decision

**Model:** `Qwen3-Coder-30B-A3B` (MLX **3-bit**, 12.4 GB — the 4-bit variant is 16 GB and won't fit 18 GB Mac) — does all the work
**Runtime:** LM Studio (exposes native Anthropic `/v1/messages` endpoint — no proxy)
**Server:** this MacBook Pro M3 Pro 18 GB (~13.4 GB resident)
**Client:** other laptop running Claude Code

Claude Code on the client laptop has **three usage modes**:

1. **Cloud mode** (default `claude`) — real Claude via Max 20x subscription. Orchestration + hard reasoning.
2. **Full-local mode** (`claude-local` alias) — Qwen3-Coder-30B-A3B on home server. Offline / experimental / fully-free mode.
3. **Hybrid / free-subagents mode** (recommended daily driver) — cloud Claude as orchestrator; audits, reviews, file-finds, summaries, and yes/no classifications routed to the home Mac via an **MCP bridge** (doc 06). Every local reply comes back **caveman-compressed** (40–65% fewer tokens for Claude to read). This is the mode that actually stretches Max 20x meaningfully.

## Why this pick (short version)

- Purpose-built coding model → actually replaces Claude-level work, not just supplements it
- MoE with 3.3 B active params → ~35–50 tok/s decode on M3 Pro despite 30 B total
- **12.4 GB weights at MLX 3-bit** → fits 18 GB with 32K usable context + headroom
- 3-bit quality loss is minimal on MoE (only 3.3B active per token, not a dense 30B)
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

## Quick start (one command per machine)

```bash
# Clone on BOTH machines:
git clone https://github.com/subash1999/claude-local-llm-setup.git ~/claude-local-llm-setup
cd ~/claude-local-llm-setup

# ── On the SERVER Mac (the one running LM Studio) ──
bash scripts/find_parallel.py      # probe optimal parallel/ctx for your RAM (~15 min)
bash scripts/server.sh             # installs LM Studio, downloads models, sets up LaunchAgent
# At the end it prints your server URL — something like:
#   http://Your-MacBook.local:1234

# ── On the CLIENT laptop (the one running Claude Code) ──
bash scripts/client.sh http://Your-MacBook.local:1234
# Installs Claude Code, shell aliases, MCP bridge, and skills.
```

## LAN addresses

- **Server Mac hostname (primary):** auto-detected — run `echo "$(scutil --get LocalHostName).local"` on the server to read it. Bonjour/mDNS means this stays stable even if the router changes your IP.
- **Raw IP (fallback):** `ipconfig getifaddr en0` on the server Mac. Use this if mDNS is blocked (VPN, guest networks).
- **LM Studio port:** `1234`

## Manual route (if you want to understand each piece)

1. On the server Mac: walk through `01-server-setup-this-mac.md` (install LM Studio + model, load flags, LaunchAgent)
2. On the client laptop: walk through `02-client-setup-other-laptop.md` (Claude Code + `claude-local` alias)
3. **For the biggest savings, also do `06-free-subagents-for-claude.md`** (MCP bridge for free subagent work)
4. Daily usage cheat sheet: `03-usage-patterns.md`

The one-shot scripts above are just automation over these docs.
