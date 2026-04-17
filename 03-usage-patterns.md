# Usage Patterns — When to use `claude` vs `claude-local`

**Goal:** extend your Claude Max 20x ($200/mo) runway from 4–5 days to a full week by offloading work that doesn't need premium Opus quality to the home server.

## Rule of thumb

| Task | Use | Why |
|---|---|---|
| Multi-file refactor, architectural decisions, subtle bugs | `claude` (cloud) | Opus 4.6 is notably better at cross-file reasoning |
| "Think hard" / extended-thinking work | `claude` (cloud) | Extended thinking isn't available on local models |
| Agentic workflows with many tool calls | `claude` (cloud) | Claude's tool-use is battle-tested; Qwen is good but not identical |
| Writing PRDs, specs, READMEs, commit messages | `claude-local` | Qwen3-Coder handles these fine; save your cloud quota |
| Generating boilerplate code / CRUD scaffolding | `claude-local` | Routine code; no Opus needed |
| Bug fixing where you know the answer pattern | `claude-local` | You're steering; local is fast enough |
| Explaining existing code, "what does this do" | `claude-local` | Retrieval + summarization; local is fine |
| "Write a test for this function" | `claude-local` | Template work |
| Code review of your own diff before commit | `claude-local` | Opinionated feedback; local quality good enough |
| Debugging when you're tired and want a second pair of eyes | `claude` (cloud) | Use premium when you actually need it |
| Experimental / throwaway prototyping | `claude-local` | No reason to spend cloud tokens |
| Anything sensitive / private / under NDA | `claude-local` | Never leaves your LAN |
| Offline (no internet, plane, train) | `claude-local` | Cloud Claude can't work; local always can |
| Long-context reads (single big file dump in, ask questions) | `claude-local` | Your Max quota recovers; use it for generation, not reading |

## The "exhaustion" heuristic

- **Start every day on `claude-local`.** Do your morning routine coding there.
- **Switch to `claude` when you hit a problem that local visibly struggles with** — usually architectural or subtle.
- **Always fall back to local for the second half of any task** (e.g., Claude drafts the architecture, local fills in the implementations).

Target: ~60–70% of your sessions on local, 30–40% on cloud. That should stretch the subscription meaningfully.

## Practical two-terminal workflow

Open two terminal tabs/panes:

```
┌──────────────────────┬──────────────────────┐
│ Tab 1: claude        │ Tab 2: claude-local  │
│ (Max 20x — premium)  │ (home Mac — free)    │
└──────────────────────┴──────────────────────┘
```

- Tab 1 for planning, decisions, hard debugging
- Tab 2 for execution, boilerplate, "just do it" tasks
- Paste context between them as needed

## What *not* to do

- **Don't chain cloud → local → cloud** inside a single conversation. Each run starts fresh; there's no shared conversation state.
- **Don't use `claude-local` for things that need 128K+ context.** You have ~32K usable. For giant codebases, stay on cloud.
- **Don't run both modes concurrently against the same file.** Pick one or you'll get merge conflicts on your edits.

## Cost math (back-of-envelope)

Max 20x at $200/mo = ~$6.50/day. You're hitting limits in ~5 days, meaning you burn ~$40/day of equivalent usage.

If local handles 60% of that load (~$24/day equivalent), you stretch the subscription to ~7.5 days — which is the full monthly window.

Electricity cost of running the Mac server 24/7: maybe $2–3/month. The math works.

## When to give up on local and go back to cloud mid-task

If you find yourself:
- Rephrasing the same prompt three times because Qwen "isn't getting it"
- Manually cleaning up Qwen's code before committing
- Needing to paste huge files that don't fit in 32K context

…stop, switch to `claude` (cloud). The point is to save quota, not waste time. Local's job is the 60% that's easy, not the 10% that's hard.

## Optional: auto-escalate to 14B when 7B is thin

`local_audit` has a borderline-case escalation hook. With
`LOCAL_AUDIT_AUTO_ESCALATE=1` set on the bridge env, if the 7B pass
returns fewer than 2 findings on a file larger than 30 lines of code,
the bridge transparently re-runs the same audit under the 14B deep
model and unions the two result sets. Findings are tagged `(source: 7B)`
or `(source: 14B)` so you can see who caught what.

Default: **off**. Reason: it roughly doubles wall time on the cases where
it fires (14B short_audit p95 ~2.9 s, 7B short_audit p95 ~4.6 s — combined
worst-case ~7.5 s p95 on a short file, per `bench/results/leg-d-percentiles.csv`).
Zero cost when flag is off — the code path is not entered.

Enable it when:
- You need belt-and-suspenders audits on files that 7B tends to under-report
  (very small files, dense config, DSL-heavy code).
- You're running an offline / batch audit where wall time doesn't matter.

Leave it off when:
- Interactive use. The 14B second call doubles the "waiting for the local
  model" experience for no gain on files the 7B already covered.
- You already call `local_deep_audit` explicitly as part of your workflow.

Enable by registering the MCP server with the env:
```
claude mcp add local-llm-bridge ... \
  --env LOCAL_AUDIT_AUTO_ESCALATE=1 \
  --env LOCAL_LLM_URL=http://your-server.local:1234/v1/chat/completions
```
Accepted values: `1`, `on`, `true`, `yes` (case-insensitive). Anything
else — including unset — leaves it off.
