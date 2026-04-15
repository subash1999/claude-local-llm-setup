# Fallback — GPT-OSS-20B

## When to switch to this

Swap Qwen3-Coder-30B-A3B → GPT-OSS-20B if:

- `memory_pressure` shows **Critical** under real load even with 32K context and cleanup done
- The Mac becomes unusably slow when the model is loaded (swap thrashing)
- You consistently see `"context window exceeded"` errors
- You want more breathing room for 64–96K context bundles

**Trade-off you're accepting:** GPT-OSS-20B is stronger on reasoning but noticeably weaker at pure code generation than Qwen3-Coder. If 70% of your local delegations are code, this hurts. If they're "read these files and tell me about the architecture," GPT-OSS-20B is actually a better fit.

## Specs comparison

| | Qwen3-Coder-30B-A3B | GPT-OSS-20B |
|---|---|---|
| MLX weights (picked quant) | **3-bit: 12.4 GB** | 4-bit: ~12 GB |
| Active params | 3.3 B (MoE) | 20 B (dense) |
| Expected M3 Pro decode | ~35–50 tok/s | ~20–30 tok/s |
| Usable context on 18 GB | 32K | 64–96K |
| Native context window | 256K | 128K |
| Coding benchmarks | **strongest in fit-class** | mid |
| Tool calling | ✅ reliable | ✅ reliable (matches o4-mini on TauBench) |
| Reasoning | good | **stronger** |
| Used in LM Studio's Claude Code blog example | no | yes |

## How to swap

### On the server Mac

```bash
# 1. Unload Qwen
lms unload qwen3-coder-30b-a3b-instruct

# 2. Pull GPT-OSS-20B if not already (~12 GB)
lms get openai/gpt-oss-20b -y

# 3. Load with bigger context budget
lms load openai/gpt-oss-20b --context-length 65536 --keep-alive forever

# 4. Verify
lms ps
curl http://192.168.1.21:1234/v1/models
```

### On the client laptop

Update the function in `~/.zshrc`:

```bash
# Find this line in claude-local():
#   ANTHROPIC_MODEL="qwen3-coder-30b-a3b-instruct"
# Change to:
#   ANTHROPIC_MODEL="gpt-oss-20b"
```

Then `source ~/.zshrc`.

## Running both (disk only, not RAM)

You can keep **both models on disk** (~27 GB total, trivial on 278 GB free) and swap based on today's work:

```bash
# Coding day — use Qwen:
lms unload openai/gpt-oss-20b 2>/dev/null
lms load qwen3-coder-30b-a3b-instruct --context-length 32768

# Research / analysis day — use GPT-OSS:
lms unload qwen3-coder-30b-a3b-instruct 2>/dev/null
lms load openai/gpt-oss-20b --context-length 65536
```

**You cannot load both into memory simultaneously on 18 GB.** 15 + 12 = 27 GB, will immediately swap.

Optional convenience aliases on the server Mac:

```bash
# Add to server Mac's ~/.zshrc:
alias ai-coding='lms unload --all 2>/dev/null; lms load qwen3-coder-30b-a3b-instruct --context-length 32768 --keep-alive forever'
alias ai-research='lms unload --all 2>/dev/null; lms load openai/gpt-oss-20b --context-length 65536 --keep-alive forever'
alias ai-status='lms ps && memory_pressure | head -5'
```

## How to decide day-of

| Today's work | Load this |
|---|---|
| Implementation, code generation, tests, CRUD, refactors | Qwen3-Coder |
| Reading, summarizing, architecture review, docs, Q&A over files | GPT-OSS-20B |
| Unsure | Qwen3-Coder (it's the primary pick) |
