## Local LLM routing (from claude-local-llm-setup)

MCP tools from `local-llm-bridge` → offload work to home Mac (Qwen2.5-Coder-7B HEAVY). Cost: $0. Built-in reasoning / subagents burn Max 20x quota.

### Rules

1. **Bootstrap.** First non-chitchat turn each session → call `local_capabilities` once, cache for session. Bootstrap fail does NOT mean "skip policy silent" — individual tool calls may still work. Fall back per rule 10 per-call.

2. **Local-first routing.** Task matches pattern → MUST call local tool first. No Read-then-reason, no cloud subagent, no `Explore` / `code-reviewer` / `feature-dev:*` for these. EXCEPT tool flagged 🔴 in user-trust-map → skip local per rule 7.

   | Task pattern | Tool |
   |---|---|
   | audit / security-check / find-vulns on ONE file | `local_audit` |
   | review ONE file vs rules/criteria | `local_review` |
   | audit feature spanning MULTIPLE files vs spec | `local_feature_audit` |
   | review branch / PR / diff between two refs | `local_diff_review` |
   | cluster commits into PR-sized groups, draft release notes | `local_group_commits` |
   | "find files that do X" / "where is code for Y" (keyword) | `local_find` |
   | "conceptually about X" / semantic match on large repo | `local_semantic_search` (falls to `local_find` if no index) |
   | summarize / overview-describe files | `local_summarize` |
   | bulk explain, draft boilerplate, simple refactor, yes/no classify | `local_ask` |

3. **Reserve cloud Claude for:** architecture / novel design / API shape; tricky multi-step bug diagnosis; production-critical codegen; tool-heavy agentic work with tight multi-file iteration; user says "deep", "careful", "really think", or names you directly.

4. **Local-failure / doubt triggers** (feed rule 10 fallback). Declare local output failed if ANY:
   - Empty, truncated mid-sentence, incoherent.
   - Refuses, only restates prompt.
   - Cites files / funcs / lines / symbols not present on spot-check.
   - Findings contradict each other or contradict code verifiable in one Read.
   - User pushback ("wrong", "missed X", "try again").
   - Spot-check (one Read / one Grep) contradicts a specific claim.
   - Task is production-critical (auth / payments / migrations / security-touching) — second-opinion cloud MANDATORY regardless of local quality.
   - Downstream action irreversible (push prod / DB migration / `push --force` / customer comms / data deletion).
   - ≥2 near-identical outputs on different inputs same session (repetition signal).
   - Any concrete doubt about correctness. Better one cloud retry than a wrong irreversible act.

   **Escalation ladder (audit/review shapes):**
   - **4a. HEAVY (7B) fail → DEEP (14B)** via `local_deep_audit`. 14B ≈ 8.3 GB JIT, first call ~8 s, subsequent fast. Still $0 quota. Stop if DEEP sound.
   - **4b. DEEP fail → cloud** per rule 10. No loop back to local same task.
   - If DEEP unavailable (14B not downloaded, 🔴 on `local_deep_audit`), skip 4a → cloud.

   **Non-audit shapes** (find / search / summarize / classify / group_commits): no DEEP tier. Ladder = local → ONE retry with rephrased prompt → cloud per rule 10.

   **`local_semantic_search` fallbacks:**
   - `"No semantic index for <root>"` → drop to `local_find` for this call; tell user build cmd `node scripts/semantic-index.mjs <root>`; never block task on building.
   - Result includes `[STALE INDEX: ...]` → trust results, note staleness. Auto-rebuild armed post-commit on indexed repos via `.git/hooks/post-commit`.

5. **Built-in subagents** (`Explore`, `code-reviewer`, `Plan`, `feature-dev:*`, `general-purpose`) cost quota. Spawn only when capability exceeds local tool. Plain file search / read-and-summarize / single-file audit / diff review / commit grouping → always local.

6. **Don't narrate policy.** Pick local → call tool. Pick cloud → do work. Mention only per rule 10 (mandatory note) or user asks why.

7. **Trust map maintenance.** Local models degrade silent — quant drift, KV cache bugs, runtime regressions (LM Studio / Ollama / vLLM), memory pressure, context bleed, repetition loops. **user-trust-map block below** = per-install record. Survives `claude-local-llm-setup` regen — content between `user-trust-map START` / `user-trust-map END` sentinels preserved across reinstalls.

   - Consult trust-map before rule 2. 🔴 overrides its row → cloud directly, skip local call.
   - Downgrade: rule 4 triggers on same tool twice on *different* inputs → flag 🔴 + one-line symptom + date. One bad reply ≠ enough.
   - 🔴 symptoms: repetition loops filling `max_tokens`; context bleed between independent calls (output N references prompt N−1 content); invented line numbers past EOF; invented props / paths / commit hashes; server 4xx/5xx on specific tool.
   - Re-bench before 🔴 → 🟢 (≤ 5 min):
     1. `local_capabilities` up, model listed.
     2. `local_ask` 5-item classify, ≤ 100 out-token cap, exact labels.
     3. `local_summarize` one < 30 LOC file, spot-check every claim.
     4. `local_find` narrow description, no infinite repeat.
     5. `local_audit` small file, no invented line numbers past EOF.

     Any repeat / hallucinated specific / crash → stay 🔴.

8. **Concurrency caps.** `local_capabilities.concurrency` maps every tool → `{ safe, ceiling, note }`. When parallelizing (per-issue swarm, audit fan-out, Task-agent spawn), MUST respect `safe`. Bursts up to `ceiling` tolerated. Above `ceiling` → latency cliff.

   Defaults (2026-04-17 probe, M3 Pro 18 GB, PARALLEL=4):
   - `local_ask` short (max_tokens ≤ 120): safe 8 / ceiling 16.
   - `local_audit` / `local_review` / `local_find` / `local_summarize` (single-file): safe 4 / ceiling 4.
   - `local_feature_audit` / `local_diff_review` / `local_group_commits` (multi-file): safe 2 / ceiling 3.
   - `local_semantic_search`: unlimited (no model inference).
   - **`local_deep_audit` (14B): MUST serialize — safe 1 / ceiling 1.** Peak RAM 7B + 14B ≈ 15 GB, near wired cap. Two concurrent 14B = swap = latency cliff.

   Fan-out width bounded by slowest tool in the pipeline, not fastest. One audit per worktree × 4 worktrees = safe; beyond that, queue.

9. **Subagent routing propagation.** Task subagents inherit user-scope MCP (`mcp__local-llm-bridge__*` callable from `general-purpose` / `Explore` / `feature-dev:*` / plugin agents) BUT NOT this policy — their system prompt is their own. Without hints, subagents default to Grep / Read / own-reasoning and burn cloud quota on work the parent expected to go local. Biggest leak in subagent-dense patterns.

   Orchestrator MUST prepend this snippet to every Task agent prompt (skip only when sole job is a rule-3 cloud-only shape: architecture / novel design / multi-step debug / tool-heavy iteration / production-critical codegen):

   ```
   ROUTING: You have `mcp__local-llm-bridge__local_*` tools. Before Grep/Read/Bash/own-reasoning for these shapes, call matching local tool first:
   - single-file audit → local_audit
   - single-file review vs rules → local_review
   - diff / PR / branch review → local_diff_review
   - multi-file feature audit → local_feature_audit (≤3 files per call)
   - cluster commits into PRs → local_group_commits
   - keyword file find → local_find
   - semantic / conceptual match → local_semantic_search; "No semantic index for <root>" → fall back to local_find + tell parent build cmd `node scripts/semantic-index.mjs <root>`; do NOT block task on building
   - summary of 1-2 small files → local_summarize
   - short enum/classify/yes-no ≤120 tok → local_ask
   Rule-4 ladder (audit): HEAVY fail → local_deep_audit (14B) ONCE → if also fails → own reasoning (Grep/Read/Bash), tell parent "local+deep both rule-4 on <task>". Non-audit: local → ONE rephrased retry → own reasoning. NEVER loop same local tool same task. Respect local_capabilities.concurrency.safe when parallelizing. ANY inaccessibility (ECONNREFUSED / timeout / 4xx/5xx / tool missing) or concrete doubt → cloud / own-reasoning per rule 10 with the mandated one-line note.
   ```

   Orchestrator-doubt also applies to subagent output: concrete doubt on a Task agent's reply → cloud redo. Don't silently accept subagent output any more than you'd silently accept a local reply.

10. **Universal cloud-fallback invariant.** Any local_* call, any ladder point, escalate IMMEDIATELY on EITHER:

    **(a) Inaccessible** — `ECONNREFUSED` / `ETIMEDOUT` / DNS fail / HTTP 4xx/5xx from bridge / MCP tool missing / stdio bridge dead / model-not-loaded / server JIT-swapping. Any network or MCP-layer failure = "cloud for this call", not "skip session silently".

    **(b) Doubt** — any rule 4 trigger (see list above). Well-formed surface is not proof of correctness.

    **One-line user-visible note REQUIRED on every fallback**:
    - Inaccessibility: `"local offload down on <tool>: <error> — cloud fallback"`
    - Doubt: `"doubt <one-phrase reason> on <tool> — cloud retry"`

    Never retry same local tool on same task after fallback. Two fails on different inputs same session → flag 🔴 per rule 7.

<!-- user-trust-map START (preserved across regen) -->
_User-maintained. Edits here survive reinstall. Fill after rule 7 quick-check. Default: 🟢 until evidence demotes._

| Tool | Trust | Symptom / date |
|---|---|---|
<!-- user-trust-map END -->
