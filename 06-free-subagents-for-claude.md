# Free Subagents — Routing Claude's Delegated Tasks to the Local Mac

## The problem

Claude Code's native subagent system (`Agent` tool, custom agent types like `Explore`, `code-reviewer`, `feature-dev:code-explorer`) spawns each subagent with a model. On Max 20x **all subagents use your subscription quota** — there's no per-subagent routing to a custom endpoint, because Max 20x is OAuth (not API-key) so proxies like `claude-code-router` don't cleanly work.

This is painful because subagents often consume **more tokens than main sessions** — they get big context bundles, produce detailed reports, and get spawned repeatedly.

## The solution — MCP bridge + local tool commands

Instead of routing native subagents to local, we give Claude Code new **MCP tools** that it can call from the cloud session. Each tool is a thin shell around the home Mac's LM Studio. When Claude wants to "audit this file," "review this diff," or "group these commits," it calls these tools — which run on the local Mac, for free.

From Claude's perspective it's just calling tools. From yours, you're not burning subscription quota on bulk work.

## Architecture

```
┌────────── Other laptop ──────────┐        ┌──── Home Mac (.local or .21) ─────┐
│                                  │        │                                   │
│  Claude Code (cloud / Max 20x)   │        │  LM Studio server :1234           │
│  ┌─────────────────────────────┐ │        │  ┌─ HEAVY ─────────────────────┐  │
│  │ Main conversation           │ │        │  │ qwen2.5-coder-7b-instruct   │  │
│  │ (orchestrator — cloud)      │ │        │  │ 131K ctx · ~50 tok/s · 4 GB │  │
│  └──────┬──────────────────────┘ │        │  └─────────────────────────────┘  │
│         │ calls MCP tool         │        │                                   │
│         ▼                        │  HTTP  │  ~6 GB resident / 18 GB           │
│  ┌─────────────────────────────┐◄┼───────►│                                   │
│  │ local-mcp-bridge            │ │        │  All local replies come back      │
│  │ HEAVY tools (one model,     │ │        │  caveman-compressed (CAVEMAN_MODE)│
│  │  many purpose-built shapes):│ │        │  → Claude reads 40-65% fewer      │
│  │ • local_ask                 │ │        │    tokens on each MCP result      │
│  │ • local_audit               │ │        │                                   │
│  │ • local_review              │ │        │                                   │
│  │ • local_feature_audit       │ │        │                                   │
│  │ • local_diff_review         │ │        │                                   │
│  │ • local_group_commits       │ │        │                                   │
│  │ • local_find                │ │        │                                   │
│  │ • local_summarize           │ │        │                                   │
│  │ Meta:                       │ │        │                                   │
│  │ • local_capabilities        │ │        │                                   │
│  └─────────────────────────────┘ │        │                                   │
└──────────────────────────────────┘        └───────────────────────────────────┘
```

## Part 1 — Install the MCP bridge on the client laptop

The MCP bridge is a single-file Node.js script (`mcp-bridge/server.mjs`) that exposes nine tools (eight HEAVY-backed + one meta). Claude Code calls them; they forward to the home Mac.

> **Source of truth:** `mcp-bridge/server.mjs`. The snippets in this doc are illustrative — the installer (`scripts/client.sh`) always deploys the real file.

> **Easy mode:** run `bash scripts/client.sh http://<your-server>.local:1234` from a clone of this repo. It copies `mcp-bridge/server.mjs` + skills into place, runs `npm install`, and registers the MCP server with the right env vars. Skip to Part 3 to verify.

### The tools, briefly

| Tool | Input | What it does |
|---|---|---|
| `local_capabilities` | — | Returns the manifest of models + tools. Call once per session. |
| `local_ask` | prompt, system? | Free-form HEAVY prompt. Use when no purpose-built tool fits. |
| `local_audit` | file_path, checklist | Audit **one** file for bugs/vulns/style. |
| `local_review` | file_path, instructions | Review **one** file against custom criteria. |
| `local_feature_audit` | file_paths[], spec | Audit a **multi-file** feature as a single unit vs a spec. Reports gaps, cross-file inconsistencies, missing tests. |
| `local_diff_review` | repo, ref_a, ref_b, instructions | Review a **git diff** between two refs. Returns `VERDICT: APPROVE | REQUEST CHANGES` + findings. |
| `local_group_commits` | repo, range | Cluster commits in a range into PR-sized groups with Conventional-Commits titles. |
| `local_find` | root, description | Natural-language file finder (ripgrep prefilter + HEAVY ranking). |
| `local_summarize` | file_paths[], focus? | Summarize one or more files. |

### Register the MCP server with Claude Code

```bash
claude mcp add local-llm-bridge \
  --command node \
  --args "$HOME/.claude/mcp-servers/local-llm-bridge/server.mjs" \
  --scope user \
  --env LOCAL_LLM_URL=http://<your-server>.local:1234/v1/chat/completions \
  --env LOCAL_LLM_MODEL=qwen2.5-coder-7b-instruct \
  --env CAVEMAN_MODE=on
```

> `CAVEMAN_MODE=on` is the default. Set to `off` in the env if you want verbose replies for a specific session — useful when debugging what the local model is actually saying. Caveman applies to **every** HEAVY tool (audit, review, feature_audit, diff_review, group_commits, find, summarize, ask), so flipping it off is your one knob for readable-over-compact.

Verify:
```bash
claude mcp list | grep local-llm
```

## Part 2 — Custom Claude Code skills that use the bridge

Skills are auto-invokable when their triggers match. `scripts/client.sh` copies these to `~/.claude/skills/`. The shipped skills map 1:1 to HEAVY-backed tools:

| Skill | Triggers on | Calls |
|---|---|---|
| `local-audit` | "audit", "security check", "find vulns" on a single file | `local_audit` |
| `local-review` | "review this code against these rules" on a single file | `local_review` |
| `local-feature-audit` | "audit this feature" spanning multiple files | `local_feature_audit` |
| `local-diff-review` | "review this branch", "review this PR", "self-review before push" | `local_diff_review` |
| `local-group-commits` | "split this branch into PRs", "group commits", "draft release notes" | `local_group_commits` |
| `local-find` | "find files that do X", "where is the code for Y" | `local_find` |
| `local-summarize` | "summarize these files", "give me an overview of X" | `local_summarize` |

See `mcp-bridge/skills/*.md` for the exact frontmatter. To customize behavior, edit those files and re-run `bash scripts/client.sh ...` (it re-copies everything).

## Part 3 — Verify

1. Start a fresh `claude` session on the client laptop
2. Ask: "Audit `/path/to/some/file.js` for security issues"
3. Claude should auto-invoke the `local-audit` skill → `local_audit` MCP tool → home Mac does the work → returns to Claude
4. Your cloud token consumption should be **only the orchestration messages**, not the audit itself

Check by running `/context` in Claude Code — the audit text comes back as a tool result, not as Claude-generated content. That's the win.

## Part 4 — When to use what

| Task type | Without this setup | With this setup |
|---|---|---|
| "Find the auth code" | `Explore` agent → cloud → **burns quota** | `local-find` → HEAVY → **free** |
| "Audit this file for vulns" | Claude reads + analyzes → **burns quota** | `local-audit` → HEAVY → **free** |
| "Audit this whole feature" (handler + service + tests) | `code-reviewer` agent on each file → **burns a lot** | `local-feature-audit` → HEAVY → **free** |
| "Review my branch / this PR" | Claude reads every changed file → **burns a lot** | `local-diff-review` → HEAVY → **free** |
| "Split this branch into reviewable PRs" | Claude reasons over `git log` → **burns quota** | `local-group-commits` → HEAVY → **free** |
| "Review this one file against our rules" | `code-reviewer` agent → cloud → **burns quota** | `local-review` → HEAVY → **free** |
| "Summarize these 10 files" | Reads all into context → **huge quota hit** | `local-summarize` → HEAVY → **free** |
| Architectural decisions | Claude main (cloud) | Claude main (cloud) — keep this on real Claude |
| Tricky bug diagnosis | Claude main (cloud) | Claude main (cloud) |
| Tool-heavy agentic work | Claude main (cloud) | Claude main (cloud) |

### Routing cheat-sheet for Claude

Tell Claude at session start: "Call `local_capabilities` once, then follow its `routing_hints`." The manifest tells Claude which tool fits which task.

General rule:
- **Single-file review / audit** → `local_review` / `local_audit`
- **Multi-file feature audit** → `local_feature_audit`
- **Diff review / PR review** → `local_diff_review`
- **Commit grouping / release notes** → `local_group_commits`
- **File search by meaning** → `local_find`
- **Multi-file summary** → `local_summarize`
- **Anything else analytical but not covered above** → `local_ask`
- **Novel design, tricky debugging, prod-critical code** → keep on cloud Claude

## Part 5 — Caveman mode (output compression)

**Every local tool response comes back caveman-compressed** when `CAVEMAN_MODE=on` (default). This is ~40–65% fewer tokens for Claude to read, measured on typical audit/review/summary outputs.

### The rules applied

```
Respond caveman style. Terse, telegraphic, no filler.
- drop articles (the/a/an), filler (just/really/basically/actually/simply),
  pleasantries, hedging
- fragments OK. short synonyms. no greetings, no sign-offs, no meta
- technical substance EXACT. code, paths, URLs, numbers, identifiers,
  error messages UNCHANGED
- pattern: [thing] [action] [reason]. [next step].
```

This is inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (viral Apr 2026 Claude Code skill). We bake the prompt directly into the MCP bridge instead of shipping it as a separate skill, because:
- Skills only affect the **outer** Claude session's output
- We want the **local model's** output compressed (that's what Claude has to read and pay input tokens on)

### Why it stacks with the MCP bridge

| Layer | What caveman saves |
|---|---|
| Local model → MCP → Claude | HEAVY reply is ~50% shorter → Claude's **input** tokens drop |
| (Optional) JuliusBrussee skill on client laptop | Claude's **own** replies shorter too — user reads less, and follow-up turns carry less history |

### Per-call override

`local_ask` accepts `caveman: false` as an argument to force verbose output for one call — useful when asking for a prose essay, a long-form draft, or a teaching-style explanation. The other tools keep caveman on because their outputs are structured reports where compression is a pure win.

### Optional — install the JuliusBrussee skill on the client laptop

This is the client-laptop equivalent: it compresses Claude's *own* output (not the local model's). Independent of the MCP bridge. Install with one command:

```bash
# On the client laptop:
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman@caveman
```

Then inside a session you can toggle intensity: `/caveman lite`, `/caveman full` (default), `/caveman ultra`. If Claude's replies turn too cryptic for code review, drop to `lite` or `/caveman off`.

### Turning caveman off globally

For one session, override the env var when launching Claude Code:

```bash
CAVEMAN_MODE=off claude
```

Or permanently: edit the `claude mcp add` command's `--env CAVEMAN_MODE=on` to `off` and re-run.

## Expected savings

Stacked best-case, typical Claude Code day:
- Subagent-style calls (find/audit/review/summarize + the new feature_audit/diff_review/group_commits) routed to local → **cuts ~35–40% of cloud tokens** (MCP bridge alone — higher than before because feature/diff/commit-group workflows were among the most expensive cloud uses)
- Caveman compression on those local replies → **further ~40% off what does come back** → another **~10–12%** of total daily tokens
- Optional JuliusBrussee skill on Claude's own output → another ~10–15%

Rough combined: **40–55% of a typical day's cloud quota offloaded**. Burning through Max 20x in 5 days → should stretch to 9–11 days.

Numbers vary by workload — lots of "audit / review / commit-group" work saves more than lots of "design this new system" work.

## Troubleshooting

### Skill doesn't auto-invoke
- Run `claude` with `--verbose` to see skill matching
- Edit the skill's `description` to match your phrasing better
- Manually: "Use the local-audit skill to audit `file.js`"

### MCP server shows as disconnected
```bash
claude mcp list
# If local-llm-bridge is red, check:
cd ~/.claude/mcp-servers/local-llm-bridge && node server.mjs   # look for errors
```

### Home Mac unreachable from MCP tool
- Same network? `curl -s -m 3 $HOME_LLM_URL/v1/models` from client (fallback: raw IP from `ipconfig getifaddr en0` on the server)
- IP changed? Update `LOCAL_LLM_URL` env var in the `claude mcp add` command (re-run with updated `--env`)

### Responses are truncated
- Raise `maxTokens` in `server.mjs` (default 4096)
- Raise the loaded context on server Mac: `lms load ... --context-length 65536`

### Feature audit / diff review ran out of context
The bridge caps total input at 500 KB before sending to HEAVY (see `MAX_CONTEXT_BYTES` in `server.mjs`). If you hit that on a large feature or diff:
- Narrow the `file_paths` list (only files actually relevant to the spec)
- For diffs, pass a narrower range (e.g. `HEAD~5..HEAD` instead of `main..HEAD`)
- Or split into multiple calls and consolidate the findings yourself

## Summary

- **Main Claude session (cloud)** = orchestration, planning, hard reasoning = Max 20x quota
- **All audit / review / feature-audit / diff-review / commit-grouping / find / summarize work** = HEAVY (Qwen2.5-Coder-7B-Instruct) via MCP bridge = **free, no quota**
- **Caveman mode** compresses every local reply ~40–65% before Claude reads it = **free input-token cut**
- **Custom skills** make the routing automatic — you don't have to remember to invoke local tools
- **Optional client-side** [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) skill compresses Claude's own replies too

This is the piece that actually stretches your subscription. The `claude-local` alias from `02-client-setup-other-laptop.md` is still useful for fully-offline mode; this MCP bridge is the surgical-savings mode.
