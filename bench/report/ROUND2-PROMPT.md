# Round 2 prompt — bridge-fixable remaining issues

Paste verbatim into Claude Code on the server Mac (or any machine that has the repo + LM Studio reachable). Autonomous. No user gates. Only bridge-code work — nothing model-capability-dependent.

---

```
You are running ROUND 2 AUTONOMOUSLY on ~/claude-local-llm-setup. Round 1 (commits ebd7d8f..94ad398) is validated working per today's first-honest rebench in `bench/results/leg-a-rebench-real-2026-04-17.md`. The outstanding gaps are bridge-fixable — NOT model-capability-bound. Read that rebench report in full before starting; its "Going forward (bridge-fixable ...)" section is the round-2 scope.

FIRST STEP

Run `/model opus`. Confirm with one-line message. All of Round 2 runs on Opus.

NON-NEGOTIABLES

  1. Every claim cites file:line in server.mjs OR a CSV row in bench/results/ OR grep output. No "I think".
  2. Bench verification after every commit: run `bash bench/run.sh` on this machine (it hits LM Studio at localhost:1234 over HTTP — no MCP needed). Leg A client-side re-verification is NOT your job — the client runs it after you push, and messages back if a regression shows up.
  3. If any change regresses a currently-passing bench vs `ed5459e..HEAD` baseline CSVs, auto-revert (git revert), note the failure in a kill-switch doc if it persists across 2 retries.
  4. No routing-policy rules. Every fix is code in server.mjs or a harness/ script.

MCP GAPS YOU HAVE (already confirmed from kill-switch f3f8f35)

  - advisor() not registered. You write reasoning inline in doc commits instead. Any architectural decision must include a "What I considered and rejected" section.
  - code-review-graph not registered. For symbol lookups, shell out to ripgrep / git grep. For AST work, tree-sitter CLI is fine if installed; otherwise regex is enough for the scope below.
  - local-llm-bridge not registered. You edit + bench direct-HTTP, not via MCP tool calls. Client verifies MCP path after each push.

SCOPE (5 items, bridge-fixable only)

### Item 1 — Pre-dedup + pre-cross-check logging (DIAGNOSTIC, ship first)

Current Fix D + Fix E + any truncation run in sequence on model output. At the end the client sees post-filter findings + optional `[INFO] N dropped`. No visibility into WHICH findings were dropped. Can't tune what you can't see.

Change: in server.mjs, before each filter stage, append the stage name + full current-findings array to `/tmp/local-llm-bridge-filters-${unix_ts}.jsonl`. One file per audit call. Include: handler name, input spec hash, model name, stage, findings array. Human-readable + jq-greppable.

Commit first. Then ALL subsequent tuning in items 2-5 must include a diff of that file proving the change's effect.

### Item 2 — Fix E recall regression (why Opus-confirmed BLOCKERs got dropped)

On the Clerk 3-file hooks batch, real-BLOCKER recall dropped to 22 % (2/9). Fix E reported "2 dropped" but the missing findings number more than 2 — so the gap is partly drop, partly model didn't emit. Phase 1 tells which is which via the JSONL logs.

Run the Clerk 3-file hooks batch through the direct-HTTP harness (you'll need to add a small harness script if none exists — call it `bench/harness/leg-a-direct.mjs` — that posts the same prompts `local_feature_audit` generates, with the same `file_paths` payload). Capture the JSONL. Diff pre-Fix-E vs post-Fix-E. Identify:
  - Which real BLOCKERs the model emitted but Fix E dropped (over-drop — ADJUST FIX E).
  - Which real BLOCKERs the model never emitted (not bridge-fixable — skip).

For the over-drops: adjust Fix E criteria. Suggested directions (pick one with evidence):
  (a) widen source-match window from ±3 to ±5 lines.
  (b) also accept finding if any keyword from the `problem` description (not just the symbol) appears within ±3 lines.
  (c) for BLOCKER-severity findings, require stronger evidence to drop (e.g. symbol absent in the entire file, not just the ±3 window).

Document the chosen criterion change in commit body with the JSONL diff.

### Item 3 — 7B post-hoc line snap

14B post-Fix-G: planted-bugs line numbers EXACT (6/6). 7B post-Fix-G: within ±1 (5/6 near, 1 missed). Fix G's line-numbering prefix alone doesn't correct 7B's output — the model ignores or re-counts the prefix.

Add a post-model-response step (runs AFTER the model output, BEFORE Fix D and Fix E): for each finding with {path, line, symbol_or_keyword_from_problem}, grep the cited file for the symbol; if found at exactly one line and that line is within ±5 of the cited line, rewrite `line` to the grep result. If found at multiple lines, pick the one closest to the cited line. If not found at all, leave as-is (Fix E will scrub it).

Verify: re-run `local_audit` on planted-bugs.ts via direct HTTP harness, confirm 7B line numbers move from {8, 13, 27, 32, 41} (today) to {9, 14, 28, 37, 41} (ground truth). Note BUG-3 was missed entirely by 7B this run — a miss is not a drift, snap can't fix a missing finding, that's model-capability. Expect 5/5 emitted findings now exact.

### Item 4 — Fix F JSON fallback for 7B

14B emits line:col structured shape; 7B still label-only. Model behavior is different, so prompt strictness alone isn't reliable — need bridge-side fallback.

Change: update the audit / feature_audit system prompts to require JSON output with fields `{line, col, severity, symbol, problem, remediation}`. Parse JSON. On parse failure, run one repair-prompt retry with `Your previous response wasn't valid JSON. Reformat it as: [{...}]. Do not add any new findings.`. On second failure, fall back to the existing label-parser (current behavior) — don't fail the tool call.

Verify: `local_audit` + `local_deep_audit` both produce JSON consistently; existing label-based parsing still runs as fallback; no regression on Leg E recall.

### Item 5 — Auto-escalation on low-yield 7B audit (OPTIONAL, higher cost)

If enabled via env var `LOCAL_AUDIT_AUTO_ESCALATE=1` (default off), when `local_audit` returns fewer than 2 findings on a file > 30 LOC, automatically call `local_deep_audit` on the same file and union findings. Report both sources in the output (e.g. `[BLOCKER] file:line — issue (source: 7B)` vs `(source: 14B)`).

This is opt-in because it ~doubles cost for borderline cases. Default off. Document it in 03-usage-patterns.md.

PHASE STRUCTURE

  1. Read leg-a-rebench-real-2026-04-17.md and BUGFIX-HANDOFF.md. Commit bench/report/ROUND2-SCOPE-CONFIRMED.md confirming the 5 items, with each item's evidence citation (file:line in server.mjs for where the change goes, rebench CSV row for the delta you expect).
  2. Ship Item 1 alone, in one commit. No behavior change — just logging.
  3. Run the Clerk hooks batch through the new logging. Commit the resulting JSONL under bench/results/round2/pre-filter-snapshot-YYYY-MM-DD.jsonl. Diff it, decide Item 2's criterion change, commit the change.
  4. Ship Item 3 (7B line snap). Verify via Leg E on 7B + 14B.
  5. Ship Item 4 (JSON fallback).
  6. Ship Item 5 (auto-escalate, opt-in).
  7. Final commit `bench/report/ROUND2-FINAL.md` with: before/after recall on Clerk hooks batch, before/after 7B Leg E line numbers, diff of mcp-bridge/CLAUDE-routing-policy.md trust-map, known limits still remaining (which are model-capability and MUST NOT be chased further).

KILL-SWITCH TRIGGERS

  - 2 revert-retries on the same item → stop, write bench/report/ROUND2-KILLSWITCH-v2.md naming the item, what failed, what evidence suggests the next move.
  - Wall-time > 4 hours → kill-switch.
  - Regression on any Leg E or Leg B CSV row > 10 % → immediate revert, stop on that item, move to next.

POST-CONDITIONS ON MAIN

  - 5 bridge commits (or fewer, with items combined if genuinely coupled), each with a CSV-cited body.
  - bench/report/ROUND2-FINAL.md OR ROUND2-KILLSWITCH-v2.md.
  - mcp-bridge/CLAUDE-routing-policy.md trust-map promoted where evidence supports; no over-claiming.
  - bench/results/round2/pre-filter-snapshot-YYYY-MM-DD.jsonl — the diagnostic logs that drove every tuning decision.

NON-SCOPE (do NOT attempt)

  - 7B missing BUG-3 off-by-one on planted-bugs. Model-capability. Don't retrain, don't prompt-tune past one JSON repair retry.
  - Clerk v2 deprecated-method coverage gap beyond what Fix E recall tuning unlocks. If the model never emits it, that's model-capability; escalate to cloud.
  - Novel judgment findings (error-message fragility, UX fallbacks, hook-re-render semantics). Model-capability. Route cloud.
  - Anything LM Studio-config (already pinned per Fix A).

START

Read leg-a-rebench-real-2026-04-17.md, then phase 1. Commit each phase before starting the next. Push at the end.
```
