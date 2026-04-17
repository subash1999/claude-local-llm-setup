# Offloading more of your `/insights` workload

**Context:** the default model is now a 4.3 GB Qwen2.5-Coder-7B, using ~6 GB
resident at 131K context. That leaves **~8 GB of headroom** on an 18 GB Mac
and raises a natural question: what else can we push off cloud Claude onto
the home server?

This doc is a menu, not a prescription. Pick what matches your actual pain.

## Check your `/insights` first

Before adding anything, run `/insights` in Claude Code and look at the
tool-call breakdown. The highest-frequency tools that *match a pattern in
the table below* are the ones worth offloading. Anything else, leave on
cloud Claude.

| Cloud tool you're burning quota on | Replace with | Notes |
|---|---|---|
| `Read` + summarise yourself | `local_summarize` | 1-file or multi-file |
| `Grep` + inspect | `local_find` | "where is the code for X" |
| `Read` + audit yourself | `local_audit` / `local_feature_audit` | 1-file or multi-file vs spec |
| `Agent(code-reviewer)` | `local_review` / `local_diff_review` | much cheaper |
| `Agent(Explore)` for straightforward searches | `local_find` + `local_summarize` | chain them |
| `Bash(git log)` + cluster yourself | `local_group_commits` | PR-sized groups |
| Short yes/no classifications | `local_ask` with terse prompt | see classify fixture F3 |

The MCP bridge already ships all of these (`mcp-bridge/server.mjs`).
Re-check that your `CLAUDE-routing-policy.md` is active — rule 2 is what
makes Claude actually choose local tools over built-in subagents.

## Option A — bigger context (free, already applied)

`recommended-load.sh` now loads at `--context-length 131072`. At 7B/4-bit
this costs ~2 GB of KV cache, well within headroom. Benefit:
whole-feature audits (`local_feature_audit` over 10+ files) fit in one
call, instead of needing Claude to chunk the request.

Nothing else to do — it's already live.

## Option B — a companion model for tasks the 7B can't do

The 7B is a text-only coder model. It can't look at a screenshot, parse a
PDF, or transcribe audio. If any of those happen in your workflow, load a
specialised second model alongside and add a tool for it.

### B1. Qwen2.5-VL-7B — vision for screenshots, diagrams, UI bugs, PDFs

Adds a `local_analyze_image` tool. Examples of what it unlocks:
- "here's a screenshot of the error dialog, explain what's broken"
- "here's a Figma export — draft the Tailwind for this card"
- "extract the API schema from this PDF"

Install:
```bash
lms get "https://huggingface.co/mlx-community/Qwen2.5-VL-7B-Instruct-4bit" -y
```

Memory: ~5 GB weights. 7B (4.3 GB) + VL-7B (5 GB) + 2 GB KV = ~11 GB —
fits with headroom. LM Studio will swap between them on-demand if you
don't pin both (set "Keep models loaded" off for the VL model to let it
JIT-load).

A starter tool implementation goes in `mcp-bridge/server.mjs`; the VL
endpoint accepts base64 images via the same OpenAI chat completions API.

### B2. nomic-embed-text-v1.5 — already loaded

You already have the Nomic embedding model resident (84 MB). Add a
`local_semantic_search` tool that embeds your repo files once into a
local SQLite vector store and answers
"which file is conceptually about X" faster than `local_find`.

This is the single highest-leverage addition for large repos —
`local_find`'s ripgrep prefilter breaks down on natural-language queries
that don't contain the obvious keywords.

Starter implementation lives at `scripts/bench/future/semantic-search/`
(not yet shipped). Estimate 2–3 hours of work.

### B3. whisper-large-v3 (mlx-whisper) — audio transcription

Adds a `local_transcribe` tool. Useful if you:
- record debugging sessions and want text searchable later
- get voice notes from teammates
- want to talk-to-code ("add a validator for empty strings") via a push-to-talk hotkey

Memory: ~3 GB at 4-bit. Total with 7B coder: ~9 GB — still comfortable.

Install and wire up later when you actually hit a workflow that needs it.

## Option C — escalation tier for hard audits — **SHIPPED (2026-04-17)**

Rule 4 in `CLAUDE-routing-policy.md` now has a middle tier between HEAVY
(7B) and cloud: if `local_audit` / `local_review` / `local_feature_audit`
tripped rule 4, Claude calls `local_deep_audit` (14B) before burning
cloud quota.

Wired:
1. `LOCAL_LLM_DEEP_MODEL=qwen2.5-coder-14b-instruct` env (default in bridge).
2. New tool `local_deep_audit({ file_path, checklist })` in `mcp-bridge/server.mjs`.
3. `local_capabilities` advertises the deep model + per-tool concurrency caps.
4. Routing policy rule 4 updated to a 2-step ladder: HEAVY → DEEP → cloud.

The 14B scored 56.2/60 in the bench (no loops, 0 dups). Measured first
call (JIT load + inference): ~17s on a tiny file; subsequent calls within
LM Studio's 1 h TTL are sub-5s.

Memory: 7B (4.3 GB, 131K ctx) + 14B (8.3 GB, 4K ctx JIT) = 12.6 GB
resident. Headroom ~1.5 GB for KV before the 14 GB wired cap. **Must
serialize** `local_deep_audit` — `local_capabilities.concurrency` advertises
`safe: 1, ceiling: 1`.

Raise 14B ctx only if you need multi-file deep audits; expect to
unload/reload the 14B with `--context-length 32768` or higher, which
costs extra KV RAM. For now default 4K is sized for single-file
`local_deep_audit` use.

## Option D — new MCP tools for new task shapes

The existing 8 tools cover audit/review/find/summarize/ask/group-commits.
Patterns that still fall on cloud Claude but could be local:

| Proposed tool | Triggers on | Rough prompt shape |
|---|---|---|
| `local_explain` | "explain this code / what does X do" | file + question → terse prose |
| `local_gen_tests` | "write tests for this file" | file → N unit tests |
| `local_commit_message` | staged diff → Conventional-Commits subject + body | git diff → one commit message |
| `local_changelog` | commit range → user-facing changelog entries | git log → markdown |
| `local_rename` | rename a symbol across N files | paths + old→new → diff |
| `local_draft_json_schema` | "generate a JSON schema for this shape" | sample → schema |

Each is ~30 lines in `mcp-bridge/server.mjs`. The 7B hits all of these
comfortably — verify on a real example before shipping.

## Suggested rollout order

1. **Check `/insights` first.** If the top tool burns are already covered
   by `local_audit` / `local_review` / `local_find` / `local_summarize`,
   the biggest win is just making sure Claude actually *uses* them.
   Re-read `CLAUDE-routing-policy.md` with Claude in a fresh session and
   confirm it auto-routes.

2. **Option C — 14B escalation tier.** Cheapest to add (already
   downloaded, just a new tool and a router tweak). Directly addresses
   rule-7 escalations that silently fall back to cloud.

3. **Option B2 — semantic search.** Highest leverage on large repos, no
   new model load (Nomic is already resident).

4. **Option D — commit-message / changelog tools.** Very high-frequency
   Claude invocations for many developers; trivial for the 7B.

5. **Option B1 — Qwen2.5-VL-7B.** Only if you actually paste screenshots
   or PDFs into Claude often.

6. **Option B3 — Whisper.** Only if voice is in your workflow.

Don't install everything preemptively. Memory is a real constraint, and
each new tool is surface area for the bridge to maintain.

## What NOT to offload to local

Keep on cloud Claude:

- Novel code generation where correctness matters (production code, new
  features, security-critical logic).
- Multi-step bug diagnosis with tight iteration across many file edits.
- Architectural decisions, API design, cross-cutting refactors.
- Anything where you'd say "think carefully about this" in the prompt.
- Tasks where you want the reply to match your writing style exactly.

The 7B is a high-volume, low-variance tool. Cloud Claude is your
low-volume, high-quality tool. The setup works because they stay in their
lanes.
