## Local LLM routing (from claude-local-llm-setup)

MCP tools from `local-llm-bridge` → offload work to home Mac (Qwen3-Coder-30B-A3B HEAVY). Cost: $0. Built-in reasoning / subagents burn Max 20x quota.

### Rules — follow unless override

1. **Bootstrap.** First non-chitchat turn each session → call `local_capabilities` once. Cache for session.
   - Error / timeout → local down. Skip entire policy silent. No retry. No mention unless asked.
   - OK → apply rest.

2. **Local-first routing.** Task matches pattern below → MUST call local tool first. No Read-then-reason, no cloud subagent, no `Explore` / `code-reviewer` / `feature-dev:*` for these. EXCEPT: tool flagged 🔴 in user-trust-map → skip local, straight cloud (rule 7).

   | Task pattern | Tool |
   |---|---|
   | audit / security-check / find-vulns on ONE file | `local_audit` |
   | review ONE file vs rules/criteria | `local_review` |
   | audit feature spanning MULTIPLE files vs spec | `local_feature_audit` |
   | review branch / PR / diff between two refs | `local_diff_review` |
   | cluster commits into PR-sized groups, draft release notes | `local_group_commits` |
   | "find files that do X" / "where is code for Y" | `local_find` |
   | summarize / overview-describe files | `local_summarize` |
   | bulk explain, draft boilerplate, simple refactor, yes/no classify | `local_ask` |

3. **Reserve cloud Claude for:**
   - architecture / novel design / API shape
   - tricky multi-step bug diagnosis
   - production-critical codegen
   - tool-heavy agentic work, tight iteration across many file edits
   - user says "deep", "careful", "really think", or names you directly

4. **Escalate — abandon local result, redo on cloud.** Sanity-check local reply. Escalate if ANY hold:
   - Empty, truncated mid-sentence, incoherent.
   - Refuses, only restates prompt.
   - Cites files / funcs / lines / symbols that don't exist on spot-check.
   - Findings contradict each other or code verifiable in one Read.
   - User pushback ("wrong", "missed X", "try again") → redo on cloud.

   Escalating: do it yourself once, one-line why ("local referenced nonexistent function — redoing on cloud"). No loop back to local same task.

5. **Built-in Claude Code subagents** (`Explore`, `code-reviewer`, `Plan`, `feature-dev:*`, `general-purpose`) cost quota. Spawn only when capability exceeds local tool. Plain file search / read-and-summarize / single-file audit / diff review / commit grouping → always local.

6. **Don't narrate policy.** Just route. Picked local → call tool. Picked cloud → do work. Mention only on rule 4 escalation or user asks why.

7. **Trust map maintenance.** Local models degrade silent — quant drift, KV cache bugs, runtime regressions (LM Studio / Ollama / vLLM), memory pressure, context bleed, repetition loops past short outputs. **user-trust-map block below** = per-install record of reliable `local_*` tools. Survives `claude-local-llm-setup` regen — edits between `user-trust-map START` / `user-trust-map END` sentinels preserved across reinstalls.

   - **Consult trust-map before rule 2.** 🔴 tool overrides its rule 2 row → go cloud, skip local call.
   - **Downgrade rule.** Rule 4 escalates same tool twice in quick succession on *different* inputs → flag 🔴 + one-line symptom + date. One bad reply ≠ enough. Two independent failures = enough.
   - **🔴 symptoms (not isolated bad reply):** repetition loops filling `max_tokens`; context bleed between independent calls (output N references prompt N−1 content); invented line numbers past EOF; invented props / paths / commit hashes; server 4xx/5xx on specific tool.
   - **Re-bench before 🔴 → 🟢.** Quick-check (≤5 min):
     1. `local_capabilities` → up, model listed.
     2. `local_ask` 5-item short classify, ≤100 out-token cap → exact labels.
     3. `local_summarize` one <30 LOC file → spot-check every claim.
     4. `local_find` narrow description → no infinite repeat.
     5. `local_audit` small file → no invented line numbers past EOF.

     Any repeat loop / hallucinated specific / crash → stay 🔴.

<!-- user-trust-map START (preserved across regen) -->
_User-maintained. Edits here survive reinstall. Fill after rule 7 quick-check. Default: 🟢 until evidence demotes._

| Tool | Trust | Symptom / date |
|---|---|---|
<!-- user-trust-map END -->
