# Local LLM Server for Claude Code Offload

**Date set up:** 2026-04-15 · **Last model change:** 2026-04-17 (9-model bench)

## Why this exists

I'm on **Claude Max 20x ($200/mo flat)** but my `/insights` output shows
~$127/day of API-equivalent usage, which burns the subscription quota in
**4–5 days** of any rolling cycle. Looking at the tool-call mix, roughly
**25–40% of the work is offloadable**: file audits, code review, single-
file summaries, commit grouping, "find the file that does X", simple
yes/no classifications. None of that needs a frontier model — it just
needs *reliable* structured output at >30 tok/s.

So: buy nothing, install one dependency (LM Studio), run a small coder
model on the MacBook Pro M3 Pro 18 GB that's already sitting on my desk,
and wire it into Claude Code via MCP so the orchestration stays on cloud
Claude and only the offloadable tools go local.

Constraints:
- **18 GB unified memory**, `iogpu.wired_limit_mb=14336` → ~14 GB usable for
  GPU-resident weights + KV cache.
- **Claude Max is OAuth, not API-key** — so `claude-code-router` and other
  cloud+local hybrid proxies that need an `ANTHROPIC_API_KEY` don't work.
  Integration has to happen at the MCP-tool layer, not the model-proxy
  layer.
- **Subscription quota, not cash** is the scarce resource — I don't pay
  per token, I pay per 5-hour session window. Offload stretches that
  window; it doesn't save real dollars.

## The decision (as of 2026-04-17)

**Model:** `Qwen2.5-Coder-7B-Instruct` (MLX 4-bit, 4.3 GB resident).
Chosen after a **9-model, 6-fixture bench** (see
`04-fallback-gpt-oss-20b.md` for the scorecard and
`scripts/bench/` for the reproducible code). The 7B scored a **perfect
60/60 in 51 s**, beating Qwen3-Coder-30B-A3B, Qwen2.5-Coder-14B, GPT-OSS-20B,
Phi-4, DeepSeek-R1-Distill-14B, Qwen3-14B/8B, and Qwen3.5-9B on every
fixture.

**Runtime:** LM Studio (exposes native OpenAI `/v1/chat/completions` endpoint,
no proxy layer). **Context:** 131 072 tokens — fits whole features in one
call. **Server:** this MacBook Pro M3 Pro 18 GB. **Client:** other laptop
running Claude Code.

Claude Code on the client has **three usage modes**:

1. **Cloud mode** (default `claude`) — real Claude via Max 20x. Orchestration
   + hard reasoning + novel code.
2. **Full-local mode** (`claude-local` alias) — Qwen2.5-Coder-7B on home
   server. Offline / experimental / fully-free mode.
3. **Hybrid / free-subagents mode** (recommended daily driver) — cloud
   Claude as orchestrator; audits, reviews, file-finds, summaries, commit
   grouping, classify-short queries all routed to the home Mac via an
   **MCP bridge** (doc 06). Every local reply comes back
   **caveman-compressed** (40–65% fewer tokens for Claude to read). This
   is the mode that actually stretches Max 20x meaningfully.

## Why a 7B wins on an 18 GB Mac

- 4.3 GB resident + ~2 GB KV at 131K context = **~6 GB used**, leaving
  ~8 GB for a parallel companion model, bigger context, or headroom.
- Dense 7B at 4-bit runs **~40–60 tok/s** on M3 Pro; first token
  latency <1 s. Low latency matters for the high-call-rate classify and
  find tools.
- Coder-tuned beats general-tuned on this workload — the 7B actually
  beat the 14B general model on structured fixtures.

## Why *not* the alternatives (updated post-bench)

- **Qwen3-Coder-30B-A3B (previous default)** — 3-bit MoE loops on
  structured output (75 duplicate bullets across the bench), even with
  aggressive anti-loop penalties. Unreliable.
- **GPT-OSS-20B (previous fallback)** — 51.2/60, good free-form prose,
  but weaker than the 7B on pure code. Retired.
- **Qwen3 thinking models (8B / 14B) + DeepSeek-R1-Distill-14B** — fail
  classify fixtures because they exhaust the token budget in the
  reasoning channel before emitting the answer.
- **Phi-4** — under-produces on verbose fixtures; passes threshold but
  misses most commit groups in F4.
- **Qwen3.5-9B** — crashed on F5 (MLX engine bug in LM Studio as of
  2026-04-17).
- **Gemma 4 26B-A4B / E4B** — plumbing still broken in LM Studio's
  bundled MLX backend (bug #1791), upstream fix in `mlx-vlm ≥0.4.3`
  not yet picked up. See `05-revisit-gemma-4.md`.

## Files in this folder

| File | What's in it |
|---|---|
| `README.md` | You are here |
| `01-server-setup-this-mac.md` | Install LM Studio + model on the MacBook |
| `02-client-setup-other-laptop.md` | Install Claude Code + `claude-local` alias on the other laptop |
| `03-usage-patterns.md` | When to use local vs cloud Claude, cheat sheet |
| `04-fallback-gpt-oss-20b.md` | **Full 9-model bench scorecard, model-selection rationale** |
| `05-revisit-gemma-4.md` | Check Gemma 4 again when LM Studio MLX ships the fix |
| **`06-free-subagents-for-claude.md`** | **MCP bridge that routes audits/reviews/file-finds to the home Mac — biggest subscription saver** |
| `07-research-and-sources.md` | Original (v1) comparison tables, superseded by doc 04 |
| **`08-offload-more.md`** | **What to run in the 8 GB of free memory — companion models, escalation tier, new MCP tools** |
| `scripts/bench/` | **Reproducible bench: `bench.mjs`, `bench_all.sh`, `results-2026-04-17.json`, `semantic-search.test.mjs`** |
| `scripts/semantic-index.mjs` | **Embed a repo once via nomic → JSONL index that `local_semantic_search` queries** |

## Quick start (one command per machine)

```bash
# Clone on BOTH machines:
git clone https://github.com/subash1999/claude-local-llm-setup.git ~/claude-local-llm-setup
cd ~/claude-local-llm-setup

# ── On the SERVER Mac (the one running LM Studio) ──
python3 scripts/find_parallel.py   # probe optimal parallel/ctx for your RAM (~15 min)
bash   scripts/server.sh           # installs LM Studio, downloads models, sets up LaunchAgent
# At the end it prints your server URL — something like:
#   http://Your-MacBook.local:1234

# ── On the CLIENT laptop (the one running Claude Code) ──
bash scripts/client.sh http://Your-MacBook.local:1234
# Installs Claude Code, shell aliases, MCP bridge, and skills.
```

## LAN addresses

- **Server hostname (primary):** auto-detected — `echo "$(scutil --get LocalHostName).local"` on the server. Bonjour/mDNS means this stays stable even if the router changes your IP.
- **Raw IP (fallback):** `ipconfig getifaddr en0` on the server. Use this if mDNS is blocked (VPN, guest networks).
- **LM Studio port:** `1234`

## Re-benching

The model landscape changes fast. Re-run the bench when:
- LM Studio ships a new MLX engine (may fix Qwen3.5 / Gemma 4 loading).
- A new coder-specialised model drops in the 4–14 GB class.
- You notice rule-7 escalations firing more than 1-in-20.
- Hardware changes.

```bash
cd ~/claude-local-llm-setup
node scripts/bench/bench.mjs <model-id>     # single model
bash scripts/bench/bench_all.sh <ids...>    # sequential driver (load/unload/bench)
```

See `scripts/bench/README.md` for fixture details and scoring.

## Manual route (if you want to understand each piece)

1. On the server Mac: walk through `01-server-setup-this-mac.md`.
2. On the client laptop: walk through `02-client-setup-other-laptop.md`.
3. **For the biggest savings, also do `06-free-subagents-for-claude.md`**.
4. Daily usage cheat sheet: `03-usage-patterns.md`.

The one-shot scripts above are just automation over these docs.
