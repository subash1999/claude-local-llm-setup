# Round 2 — scope confirmed

**Date:** 2026-04-17 · **Model:** Opus 4.7 · **Autonomous** per `bench/report/ROUND2-PROMPT.md`
**Baseline:** `main` at `296300f` (CSV reference: `ed5459e..HEAD -- bench/results/`).

Phase-1 pre-impl audit. Confirms the 5 bridge-fixable items with file:line in `mcp-bridge/server.mjs` and rebench evidence citations. No code touched in this phase.

---

## Filter pipeline map (mcp-bridge/server.mjs)

| Stage | Fn | Lines | Notes |
|---|---|---|---|
| strip `<think>` | `stripThink` | 177-183 | Qwen3 reasoning stripper. Called inside `_askLocalOnce` at 134. |
| dup-bullet collapse | `postProcess` | 188-207 | Consecutive-duplicate bullet suppressor. Called alongside `stripThink`. |
| JSON parse (feature_audit Fix F) | `parseFindingsJson` | 368-404 | Tolerant of fences, leading/trailing prose. Returns null on fail. |
| markdown render from JSON | `renderFindingsMarkdown` | 408-414 | So downstream filters see a uniform shape. |
| source cross-check / snap (Fix E) | `verifyAndSnapFindings` | 304-357 | ±3 window, symbol-only match. |
| dedup + AP-loop breaker (Fix D) | `dedupAndBreakLoop` | 416-498 | Exact-key dedup + step-constant suppression. |

Combined entry point: `postProcessFindings(raw, fileMap)` at **359-361**. Called from: `local_audit:794`, `local_review:807`, `local_feature_audit:923,927`, `local_diff_review:956`, `local_deep_audit:1036`.

---

## Item 1 — Pre-filter logging (DIAGNOSTIC, ship first)

**Change surface:**
- New helper `dumpFilterStage(trace, stage, payload)` near top of server.mjs, gated on `process.env.LOCAL_LLM_DEBUG_DIR`.
- New optional `trace` param on `postProcessFindings(raw, fileMap = {}, trace = null)` at 359-361. Each tool-handler call site builds `{ tool, model, input_hash, ts }` and threads it in.

**Log points (one JSONL line per stage):**
- `_askLocalOnce:133-134` — `raw-model` (pre `stripThink`), `post-think` (post `stripThink` + `postProcess`).
- `local_feature_audit:910,919` — `post-json` (after `parseFindingsJson`).
- Inside `postProcessFindings` (new body) — `pre-e`, `post-e`, `post-d`.

**Expected delta on CSVs:** none. `LOCAL_LLM_DEBUG_DIR` unset in `bench/run.sh` → guard is a no-op. CSV rows should match baseline within normal variance (p95_ms ± 5%, recall identical, precision identical).

**Acceptance:** Legs B/C/D/E non-regression after commit. Manual smoke: set `LOCAL_LLM_DEBUG_DIR=/tmp/llm-debug`, invoke any finding-emitting tool, confirm `/tmp/llm-debug/local-llm-bridge-filters-<unix_ts>.jsonl` exists and is jq-parseable.

---

## Item 2 — Fix E recall tune

**Change surface:** `verifyAndSnapFindings:304-356`. Concrete edit points:
- **Window edges** at 320-321: `f.line - 4` / `f.line + 3` (i.e. `±3`).
- **In-window match** at 322-324: `symbols.some((s) => l.includes(s))` — `symbols` is only `extractFindingSymbols` output (278-296), which rejects plain-English tokens.
- **Drop decision** at 340-345: no severity gating; any "no exactly-one whole-file hit" finding is dropped.

**Candidate tunings (pick after Phase 3 JSONL):**
- (a) Widen window `±3 → ±5` at 320-321.
- (b) Add problem-text keyword match at 322-324: accept if any alphanumeric word ≥ 4 chars from `f.text` (sans stop-words) appears in the window.
- (c) BLOCKER gate at 340-345: require 0 whole-file symbol hits **AND** 0 window keyword hits before dropping a BLOCKER. Lower severities drop on one signal.

**Evidence source:** rebench `bench/results/leg-a-rebench-real-2026-04-17.md:45-59` — 22 % real-BLOCKER recall (2/9) on Clerk 3-file hooks batch; "Fix E may be dropping real findings as part of the 2 it reported." Phase 3 JSONL will confirm over-drops vs never-emitted.

**Expected delta on CSVs:** none on server-side legs (`leg-e-accuracy.mjs` is direct-HTTP, bypasses filters). Client-side Leg A recall on Clerk hooks batch: target > 40 %. Precise target set after Phase 3 JSONL tells us the over-drop count.

**Acceptance:** Legs B/C/D/E non-regression. Client verifies Leg A recall improvement after push.

---

## Item 3 — 7B post-hoc line snap (deterministic)

**Change surface:** new function `snapFindingLinesByGrep(raw, fileMap)` inserted in `postProcessFindings` body at 359-361. Pipeline becomes `snap → verify → dedup`.

**Algorithm:** for each line in raw output parseable by `parseFindingLine:260-270`, extract symbols via `extractFindingSymbols:278-296`, grep `fileMap[f.path]` for each symbol. If exactly-one hit within `±5` of `f.line`, rewrite line. If multiple hits, pick closest to `f.line`. If zero hits, leave as-is — `verifyAndSnapFindings` handles.

**Evidence source:** `bench/results/leg-a-rebench-real-2026-04-17.md:29-39` — 7B planted-bugs today `{8, 13, 27, 32, 41}` vs ground truth `{9, 14, 28, 37, 41}`; 14B already exact.

**Expected delta on CSVs:** none on direct-HTTP legs. MCP-path (client-side Leg A): 7B finding lines move from `±1` drift to exact on symbol-matchable findings.

**Acceptance:** server-side B/C/D/E non-regression. 14B output unchanged (already exact). Client Leg A rebench confirms 7B drift closes.

---

## Item 4 — Fix F JSON fallback (extend to `local_audit` + `local_deep_audit`)

**Change surface:**
- `local_audit:784-796` currently takes markdown only.
- `local_deep_audit:1026-1038` currently takes markdown only.
- `local_feature_audit:907-928` already has JSON + repair retry + markdown fallback — this pattern is the template.

**Edit:**
- Prompts at 788-791 and 1030-1033 → require JSON shape `[{file, line, col, severity, symbol, problem, remediation}]`.
- Parse via `parseFindingsJson:368-404` (already exists). On null, one repair-prompt retry mirroring 912-919. On null again, fall back to current markdown-parse path (keep existing behavior as last-resort — do not fail the tool call).

**Evidence source:** `bench/results/leg-a-rebench-real-2026-04-17.md:24` — "14B `local_deep_audit` output shifted to `line:col` structured shape. 7B output still label-only."

**Expected delta on CSVs:** none on direct-HTTP legs. MCP-path: 7B `local_audit` / `local_deep_audit` shape moves from labels to structured. No recall loss expected (current markdown parse remains the 3rd-tier fallback).

**Acceptance:** B/C/D/E non-regression. Client-side manual smoke: `local_audit` on planted-bugs emits JSON-shaped findings with `remediation` field on both 7B and 14B.

---

## Item 5 — Auto-escalate on low-yield (opt-in)

**Change surface:** `local_audit:784-796`. New env var `LOCAL_AUDIT_AUTO_ESCALATE` (default `off`), read near module top.

**Logic:** after `postProcessFindings` at 794, count findings (parse with `parseFindingLine`). If flag-on AND findings < 2 AND file LOC > 30, call `askLocal` again with `DEEP_MODEL` using `local_deep_audit`-shaped prompt. Parse both, union findings keyed by `(path, line, sig)`. Tag surviving 14B-only findings with `(source: 14B)` in the rendered output.

**Cost:** adds 14B wall time on top of 7B when flag fires. Per `bench/results/leg-d-percentiles.csv:2,6`: 14B short_audit p95 2891 ms; 7B short_audit p95 4575 ms. Combined worst-case ≈ 7.5 s p95 on short file. Zero cost when flag off.

**Evidence source:** `bench/results/leg-a-rebench-real-2026-04-17.md:84-85` — auto-escalation listed as optional bridge-fix.

**Expected delta on CSVs:**
- Flag off (default) and unset in `bench/run.sh`: byte-identical CSVs.
- Flag on: not exercised by current harness — measured manually if at all.

**Acceptance:** with env unset, all B/C/D/E rows match baseline within normal variance. Doc appended to `03-usage-patterns.md` describing the cost-trade.

---

## Non-scope (model-capability, do NOT chase)

- 7B missing BUG-3 off-by-one on planted-bugs. No snap can rescue a missing finding.
- Clerk-v2 deprecated-method coverage gap beyond what Item-2 Fix E tune unlocks.
- Nuanced judgment findings (error-message fragility, UX fallbacks, hook re-render semantics).
- LM Studio config (pinned per Fix A).

## Revert / kill-switch triggers

- Any `bench/results/*.csv` row moves > 10 % in the wrong direction vs `ed5459e..HEAD` baseline → `git revert` the offending commit, reconsider.
- 2 revert-retries on the same item → stop, write `bench/report/ROUND2-KILLSWITCH-v2.md` with failure evidence + next-move question.
- Wall-time > 4 h → kill-switch.

---

## Next

Ship Item 1 alone. Logging only, no behavior change when `LOCAL_LLM_DEBUG_DIR` unset. Bench B/C/D/E. Commit with body citing baseline CSVs as non-regression evidence. Push.
