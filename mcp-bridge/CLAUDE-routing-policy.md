## Local LLM routing (from claude-local-llm-setup)

MCP tools from `local-llm-bridge` → offload to home Mac (Qwen2.5-Coder-7B HEAVY). Cost $0. Built-in reasoning / subagents burn Max 20x quota.

### Rules

1. **Bootstrap.** First non-chitchat turn each session → `local_capabilities` once, cache. Bootstrap fail ≠ skip session silent — individual calls may still work. Fall back per rule 10 per-call.

2. **Local-first routing.** Task matches pattern → MUST call local tool first. No Read-then-reason, no cloud subagent, no `Explore`/`code-reviewer`/`feature-dev:*` for these. EXCEPT tool flagged 🔴 in user-trust-map → cloud per rule 7.

   | Task pattern | Tool |
   |---|---|
   | audit / security-check / find-vulns ONE file | `local_audit` |
   | review ONE file vs rules/criteria | `local_review` |
   | audit feature across MULTIPLE files vs spec | `local_feature_audit` |
   | review branch / PR / diff between two refs | `local_diff_review` |
   | cluster commits into PR-sized groups, release notes | `local_group_commits` |
   | "find files that do X" / "where is code for Y" (keyword) | `local_find` |
   | "conceptually about X" / semantic match on large repo | `local_semantic_search` (falls to `local_find` if no index) |
   | summarize / overview files | `local_summarize` |
   | bulk explain, boilerplate, simple refactor, yes/no classify | `local_ask` |

3. **Reserve cloud Claude for:** architecture / novel design / API shape; tricky multi-step bug diagnosis; production-critical codegen; tool-heavy agentic iteration across many files; user says "deep"/"careful"/"really think" or names you directly.

4. **Local-failure / doubt triggers** (feed rule 10 fallback). Declare failed if ANY:
   - Empty / truncated / incoherent / refuses / only restates prompt.
   - Cites files / funcs / lines / symbols / props / hashes not present on spot-check (one Read or Grep contradicts).
   - Findings self-contradict or contradict code verifiable in one Read.
   - User pushback ("wrong", "missed X", "try again").
   - Production-critical task (auth / payments / migrations / security) — second-opinion cloud MANDATORY regardless of surface quality.
   - Downstream action irreversible (push prod, DB migration, `push --force`, customer comms, data delete).
   - ≥2 near-identical outputs on different inputs same session (repetition signal).
   - Any concrete correctness doubt. Better one cloud retry than one wrong irreversible act.

   **Audit/review escalation ladder:** 4a. HEAVY (7B) fail → DEEP (14B) via `local_deep_audit` (14B ≈ 8.3 GB JIT, first ~8 s, subsequent fast, $0). Stop if DEEP sound. 4b. DEEP fail → cloud per rule 10. DEEP unavailable (not downloaded, 🔴) → skip 4a, go cloud.

   **Non-audit shapes** (find / search / summarize / classify / group): no DEEP tier. Ladder = local → ONE rephrased retry → cloud per rule 10.

   **`local_semantic_search` fallbacks:** `"No semantic index for <root>"` → drop to `local_find` + surface build cmd `node scripts/semantic-index.mjs <root>`, never block task on build. `[STALE INDEX: ...]` warning → trust results + note staleness (auto-rebuild armed post-commit on indexed repos).

5. **Built-in subagents** (`Explore`, `code-reviewer`, `Plan`, `feature-dev:*`, `general-purpose`) cost quota. Spawn only when capability exceeds local. Plain file search / read-and-summarize / single-file audit / diff review / commit grouping → always local.

6. **Don't narrate policy.** Local → call tool. Cloud → do work. Mention only per rule 10 mandatory note or user asks why.

7. **Trust map.** Local models degrade silent (quant drift / KV cache bugs / runtime regressions / memory pressure / context bleed / repetition loops). **user-trust-map block below** = per-install record. Survives `claude-local-llm-setup` regen — content between `user-trust-map START` / `user-trust-map END` sentinels preserved.

   - Consult trust-map before rule 2. 🔴 overrides → cloud directly.
   - Downgrade: rule 4 triggers on same tool twice on *different* inputs → flag 🔴 + symptom + date. One bad reply ≠ enough.
   - 🔴 symptoms: repetition loops filling `max_tokens`; context bleed between independent calls; invented line numbers past EOF; invented props/paths/hashes; server 4xx/5xx on specific tool.
   - Re-bench before 🔴 → 🟢 (≤ 5 min): `local_capabilities` up → `local_ask` 5-item classify ≤ 100 tok exact labels → `local_summarize` < 30 LOC file spot-check → `local_find` narrow desc no repeat → `local_audit` small file no fake line nums. Any repeat / fake specific / crash → stay 🔴.

8. **Concurrency caps.** `local_capabilities.concurrency` maps tool → `{ safe, ceiling, note }`. When parallelizing (swarm / fan-out / Task spawn), MUST respect `safe`. Bursts to `ceiling` tolerated. Above → latency cliff.

   Defaults (2026-04-17 probe, M3 Pro 18 GB, PARALLEL=4): `local_ask` short (≤120 tok) 8/16 · `local_audit`/`review`/`find`/`summarize` 4/4 · `local_feature_audit`/`diff_review`/`group_commits` 2/3 · `local_semantic_search` unlimited · **`local_deep_audit` (14B) MUST serialize 1/1** (peak RAM 7B+14B ≈ 15 GB near wired cap, two 14B = swap = cliff).

   Fan-out width bounded by slowest tool. One audit/worktree × 4 worktrees = safe. Beyond → queue.

9. **Subagent routing propagation.** Task subagents inherit user-scope MCP (`mcp__local-llm-bridge__*` callable from `general-purpose` / `Explore` / `feature-dev:*` / plugin agents) BUT NOT this policy — their system prompt is their own. Without hints, subagents default to Grep/Read/own-reasoning and burn cloud on work the parent expected to go local.

   Orchestrator MUST prepend this snippet to every Task prompt (skip only for rule-3 cloud-only sole job):

   ```
   ROUTING: You have `mcp__local-llm-bridge__local_*` tools. Before Grep/Read/Bash/own-reasoning for these shapes, call matching local tool first:
   - single-file audit → local_audit
   - single-file review vs rules → local_review
   - diff / PR / branch review → local_diff_review
   - multi-file feature audit → local_feature_audit (≤3 files per call)
   - cluster commits into PRs → local_group_commits
   - keyword file find → local_find
   - semantic/conceptual match → local_semantic_search; "No semantic index for <root>" → fall back to local_find + tell parent build cmd `node scripts/semantic-index.mjs <root>`; do NOT block task on building
   - summary of 1-2 small files → local_summarize
   - short enum/classify/yes-no ≤120 tok → local_ask
   Rule-4 ladder (audit): HEAVY fail → local_deep_audit (14B) ONCE → if also fails → own reasoning (Grep/Read/Bash), tell parent "local+deep both rule-4 on <task>". Non-audit: local → ONE rephrased retry → own reasoning. NEVER loop same local tool same task. Respect local_capabilities.concurrency.safe. ANY inaccessibility (ECONNREFUSED / timeout / 4xx/5xx / tool missing) or concrete doubt → cloud/own-reasoning per rule 10 with mandated one-line note.
   ```

   Doubt applies to subagent output too: concrete doubt on Task agent reply → cloud redo.

10. **Universal cloud-fallback invariant.** Any local_* call, any ladder point, escalate IMMEDIATELY on EITHER:

    **(a) Inaccessible** — `ECONNREFUSED` / `ETIMEDOUT` / DNS fail / HTTP 4xx/5xx / MCP tool missing / stdio dead / model-not-loaded / JIT swap. Any network or MCP-layer failure = "cloud for this call", not "skip session silent".

    **(b) Doubt** — any rule 4 trigger. Well-formed surface ≠ proof of correctness.

    **One-line user-visible note REQUIRED**: inaccessibility `"local offload down on <tool>: <error> — cloud fallback"` · doubt `"doubt <one-phrase reason> on <tool> — cloud retry"`.

    Never retry same local tool same task after fallback. Two fails on different inputs same session → flag 🔴 per rule 7.

<!-- user-trust-map START (preserved across regen) -->
_User-maintained. Edits here survive reinstall. Fill after rule 7 quick-check. Default: 🟢 until evidence demotes._

| Tool | Trust | Symptom / date |
|---|---|---|
<!-- user-trust-map END -->
