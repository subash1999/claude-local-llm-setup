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

### B2. nomic-embed-text-v1.5 — **SHIPPED (2026-04-17)**

The Nomic embedding model is already resident (84 MB). The
`local_semantic_search` tool embeds a repo's files into a JSONL vector index
and answers "which chunk is conceptually about X" where `local_find`'s
ripgrep prefilter fails on natural-language queries.

Usage:
```bash
# One-time per repo (rebuild after large changes):
node scripts/semantic-index.mjs /path/to/your/repo
# Then Claude calls local_semantic_search({ root, query, top_k }) via MCP.
```

Index location: `~/.claude/semantic-index/<sha1(abs-root)>.jsonl`.
Storage: ~4 MB per 1000 chunks (768-dim f32 + text). Zero HEAVY model tokens
on query — pure embedding cosine.

Regression test: `node scripts/bench/semantic-search.test.mjs` (5 canonical
queries over this repo; exits non-zero on regression).

### B3. whisper-large-v3 (mlx-whisper) — audio transcription

Adds a `local_transcribe` tool. Useful if you:
- record debugging sessions and want text searchable later
- get voice notes from teammates
- want to talk-to-code ("add a validator for empty strings") via a push-to-talk hotkey

Memory: ~3 GB at 4-bit. Total with 7B coder: ~9 GB — still comfortable.

Install and wire up later when you actually hit a workflow that needs it.

## Option C — an escalation tier for hard audits

Rule 7 in `CLAUDE-routing-policy.md` is: *"if the local reply is empty,
truncated, refuses, or references things that don't exist, escalate to
cloud Claude."* Currently that's a binary — local fails → burn cloud
quota.

A middle tier:
1. Keep `qwen2.5-coder-14b-instruct` warm in LM Studio's JIT cache.
2. Add a `local_deep_audit` tool that routes to the 14B.
3. Modify the skill/router: on rule-7 hit, try the 14B *before* escalating
   to cloud.

The 14B scored 56.2/60 in the bench (no loops, 0 dups). For cases where
the 7B misses a finding, the 14B often catches it — without ever
burning cloud quota.

Memory: both coder models loaded = 4.3 + 8.3 = 12.6 GB + 2 GB KV ≈ 15 GB.
Tight but viable. Test with `python3 scripts/find_parallel.py` before
committing.

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
