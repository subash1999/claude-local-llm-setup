## Local LLM routing (from claude-local-llm-setup)

MCP tools from `local-llm-bridge` → offload work to home Mac (Qwen2.5-Coder-7B HEAVY). Cost: $0. Built-in reasoning / subagents burn Max 20x quota.

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
   | "find files that do X" / "where is code for Y" (keyword-friendly) | `local_find` |
   | "conceptually about X" / semantic match on large repo | `local_semantic_search` (falls to `local_find` if no index) |
   | summarize / overview-describe files | `local_summarize` |
   | bulk explain, draft boilerplate, simple refactor, yes/no classify | `local_ask` |

3. **Reserve cloud Claude for:**
   - architecture / novel design / API shape
   - tricky multi-step bug diagnosis
   - production-critical codegen
   - tool-heavy agentic work, tight iteration across many file edits
   - user says "deep", "careful", "really think", or names you directly

4. **Escalate — abandon local result, try DEEP (14B), then cloud.** Sanity-check local reply. Escalate if ANY hold:
   - Empty, truncated mid-sentence, incoherent.
   - Refuses, only restates prompt.
   - Cites files / funcs / lines / symbols that don't exist on spot-check.
   - Findings contradict each other or code verifiable in one Read.
   - User pushback ("wrong", "missed X", "try again") → redo on DEEP or cloud.

   **Orchestrator-doubt escalation (fires ALONGSIDE the literal triggers above):**
   - One Read / one Grep contradicts a specific claim in local reply → escalate.
   - Task is production-critical (auth, payments, migrations, security-touching) → second-opinion cloud is MANDATORY regardless of local quality.
   - Downstream action is irreversible (push to prod, DB migration, `push --force`, customer comms, deleting data) → cloud confirms before act.
   - Two near-identical outputs on different inputs in same session → repetition-loop signal, escalate + flag trust-map.
   - Any time orchestrator has concrete doubt about local correctness: escalate. Doubt is a valid trigger — better one cloud retry than a wrong push.

   Escalation ladder:
   - **4a. HEAVY (7B) → DEEP (14B)** for audit/review shapes: call `local_deep_audit` (or re-run original tool with deep tier if bridge exposes one). 14B is ~8.3 GB JIT, first call ~8s, subsequent fast. Still $0 quota. Stop here if DEEP answer is sound.
   - **4b. DEEP → cloud** if DEEP also rule-4 fails. Do the cloud work yourself once, one-line why ("local + deep both missed the SQLi in getUser — redoing on cloud"). No loop back to local same task.

   **Non-audit shapes** (find / search / summarize / classify / group_commits): no DEEP middle tier. Ladder is: local → ONE retry with rephrased prompt → cloud. Same never-loop discipline.

   **No-index fallback for `local_semantic_search`:** if tool returns `"No semantic index for <root>"` → drop to `local_find` for this call; tell the user the one-line build command (`node scripts/semantic-index.mjs <root>`); never block the current task on building. If result includes `[STALE INDEX: ...]` warning → trust results, note staleness in summary; auto-rebuild is armed post-commit on indexed repos via `.git/hooks/post-commit`.

   If DEEP is not available (14B not downloaded or trust-map 🔴 on `local_deep_audit`), skip 4a, go straight to cloud.

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

8. **Concurrency caps — don't overload the server.** `local_capabilities` returns a `concurrency` map for every tool with `{ safe, ceiling, note }`. When parallelizing (per-issue swarm, audit-queue fan-out, Task-agent spawn), MUST respect `safe`. Temporary bursts up to `ceiling` are tolerated; above `ceiling` latency collapses.

   Rules of thumb (defaults from 2026-04-17 probe on M3 Pro 18GB, PARALLEL=4):
   - `local_ask` short classify (max_tokens ≤ 120): safe 8, ceiling 16.
   - `local_audit` / `local_review` / `local_find` / `local_summarize` (single-file): safe 4, ceiling 4.
   - `local_feature_audit` / `local_diff_review` / `local_group_commits` (multi-file): safe 2, ceiling 3.
   - `local_semantic_search`: unlimited (no model inference).
   - **`local_deep_audit` (14B): MUST serialize — safe 1, ceiling 1.** Peak resident RAM with 7B + 14B ≈ 15GB, near the wired limit. Two concurrent 14B calls = swap = latency cliff.

   When `/insights` suggests a parallel pattern (e.g. "parallel agent swarm per issue"), the fan-out width is bounded by the slowest tool in the pipeline, not the fastest. One audit per worktree × 4 worktrees is safe; beyond that, queue.

9. **Subagent routing propagation.** Task subagents inherit user-scope MCP tools (verified: `mcp__local-llm-bridge__*` callable from `general-purpose` / `Explore` / `feature-dev:*` / plugin agents) BUT they do NOT inherit this policy — their system prompt is their own. Without explicit routing hints, subagents default to Grep / Read / own-reasoning and burn cloud quota on work the parent expected to go local. This is the biggest leak in subagent-dense patterns (per-issue swarm, audit-queue fan-out, graph-informed refactors).

   **Orchestrator MUST prepend this snippet to every Task agent prompt** (unless the subagent's sole job is rule-3 cloud-only: architecture / novel design / tool-heavy multi-step debug / production-critical codegen):

   ```
   ROUTING: You have `mcp__local-llm-bridge__local_*` tools. Before Grep/Read/Bash/own-reasoning for these shapes, call the matching local tool first:
   - single-file audit → local_audit
   - single-file review vs rules → local_review
   - diff / PR / branch review → local_diff_review
   - multi-file feature audit vs spec → local_feature_audit (≤3 files per call)
   - cluster commits into PRs → local_group_commits
   - keyword file find → local_find
   - semantic / conceptual match on large repo → local_semantic_search; if it returns "No semantic index for <root>", fall back to local_find for this call and tell parent the build command `node scripts/semantic-index.mjs <root>` — do NOT block the task on building
   - summary of 1-2 small files → local_summarize
   - short enum / classify / yes-no (≤120 out tokens) → local_ask
   Rule-4 ladder (audit shapes): HEAVY weak/rule-4 → local_deep_audit (14B) ONCE → if DEEP also rule-4 → own reasoning (Grep/Read/Bash), tell parent "local + deep both rule-4 on <task>". Non-audit shapes: local → ONE retry with rephrased prompt → own reasoning. NEVER loop same local tool in same task. Respect local_capabilities.concurrency.safe when parallelizing.
   ```

   Same orchestrator-doubt rule applies to subagent output: if a Task agent returns results and the orchestrator has concrete doubt (contradicts spot-check, task is production-critical, downstream irreversible), re-do on cloud — don't silently accept a subagent's reply any more than you'd silently accept a local reply.

10. **Universal cloud-fallback invariant (supersedes rule 1 silent-skip).** For ANY task shape, at ANY point in any ladder, escalate to cloud IMMEDIATELY on EITHER condition:

    **(a) Local inaccessible.** `ECONNREFUSED` / `ETIMEDOUT` / DNS fail / HTTP 4xx/5xx from bridge / MCP tool missing / stdio bridge dead / model-not-loaded error / server JIT-swapping another model. Any network or MCP-layer failure means "cloud for this call" — not "skip the whole session silently".

    **(b) Doubt about the reply.** Rule-4 literal triggers (empty / incoherent / hallucinated refs / contradictions / user pushback) AND the orchestrator-doubt triggers in rule 4 (spot-check contradiction / prod-critical task / irreversible downstream / repetition-loop signal / any concrete correctness doubt). Well-formed surface is not proof of correctness.

    **One-line user-visible note is REQUIRED on every fallback**, no exceptions:
    - Inaccessibility: `"local offload down on <tool>: <error> — cloud fallback"`
    - Doubt: `"doubt <one-phrase reason> on <tool> — cloud retry"`

    **Never retry the same local tool on the same task after a fallback** — the never-loop rule from rule 4 applies here too. If the session sees the same tool fail twice on different inputs → also flag 🔴 in trust-map per rule 7 downgrade rule.

    **This rule overrides rule 1's "silent-skip entire policy" language.** Bootstrap failure of `local_capabilities` does NOT mean "pretend tools don't exist all session". Individual tool calls may still work — attempt the matching local tool on task-shape match and fall back per this rule if it errors. One-line note per fallback. Silent skip is NOT acceptable behavior.

<!-- user-trust-map START (preserved across regen) -->
_User-maintained. Edits here survive reinstall. Fill after rule 7 quick-check. Default: 🟢 until evidence demotes._

| Tool | Trust | Symptom / date |
|---|---|---|
<!-- user-trust-map END -->
