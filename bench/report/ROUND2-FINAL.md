# Round 2 — final report

- **Date:** 2026-04-17
- **Scope:** 5 bridge-fixable items, server-side, kill-switch on Leg B + Leg E.
- **Commits on main (in order):** `0d8d03c..2ae4a58`
- **Kill-switch triggered:** no.
- **Outcome:** all 5 items shipped.

## Items shipped

| # | Title | Commit | File:line anchor |
|---|---|---|---|
| 1 | Pre-filter diagnostic JSONL logging | `0d8d03c` | `mcp-bridge/server.mjs:206-272` (dumpFilterStage, buildTrace) |
| 2 | Fix E verify window ±3 → ±5 | `f423bc9` | `mcp-bridge/server.mjs:436-437` |
| 3 | 7B post-hoc grep line snap before Fix E | `f3690b5` | `mcp-bridge/server.mjs:365-404` |
| 4 | JSON-first local_audit + local_deep_audit + case-insensitive symbol match | `e47e341` | `mcp-bridge/server.mjs:916-990, 1195-1260` |
| 5 | Opt-in auto-escalate 7B→14B on thin audit | `2ae4a58` | `mcp-bridge/server.mjs:32-38, 562-619, 985-1004` |

## Before / after

### Planted-bugs.ts (7B `local_audit`)

Ground truth lines: `{9, 14, 20, 28, 37, 41}`.

| Bug | GT line | Pre-Round-2 line (rebench 2026-04-17) | Post-Round-2 line (Item 4+5 smoke) |
|---|---|---|---|
| BUG-1 SQL | 9 | 8 (-1) | 10 (+1) |
| BUG-2 MD5 | 14 | 13 (-1) | **14** ✓ |
| BUG-3 off-by-one | 20 | MISSED (stochastic model-capability) | **20** ✓ |
| BUG-4 null | 28 | 27 (-1) | **28** ✓ |
| BUG-5 swallow | 37 | 32 (-5) | **37** ✓ |
| BUG-6 secret | 41 | 41 ✓ | **41** ✓ |

Exact-line score: **1/6 pre → 5/6 post**. One remaining drift (BUG-1) has
no identifier-shaped symbols for snap to match on — the finding text is
"SQL injection risk due to string concatenation in SQL query" with no
camelCase / snake_case / digit-bearing tokens. Model-capability limit,
not bridge-fixable. Evidence: snapshot `2026-04-17-12-47-29`.

Output shape: before Round 2 the 7B returned plain-text `- BLOCKER / path:line — ...`
which bypassed the bracket-format `FINDING_RE` entirely, so snap / verify /
dedup / line-snap were all inert. Post-Item-4 the 7B returns JSON with
remediation, the pipeline is active, and the user-visible output is the
canonical `- [BLOCKER] path:line — problem | fix: remediation` shape.

### Planted-bugs.ts (14B `local_deep_audit`)

| Bug | GT line | Pre-Round-2 (rebench 2026-04-17) | Post-Round-2 (Item 4 smoke) |
|---|---|---|---|
| BUG-1 SQL | 9 | 9 ✓ | **9** ✓ |
| BUG-2 MD5 | 14 | 14 ✓ | **14** ✓ |
| BUG-3 off-by-one | 20 | 20 ✓ | **20** ✓ |
| BUG-4 null | 28 | 28 ✓ | **28** ✓ |
| BUG-5 swallow | 37 | 37 ✓ | **37** ✓ |
| BUG-6 secret | 41 | 41 ✓ | **41** ✓ |

Line precision unchanged — both 6/6 exact.

Shape changed materially: pre-Round-2 output was `` [BLOCKER] `  9|` — text ``
(backtick-wrapped line-only, no path, no remediation). Post-Item-4 it's
canonical bracket format with remediation per finding, and the pipeline
(snap / Fix E / dedup) is live on deep_audit too. Evidence: snapshot
`2026-04-17-12-48-08`.

### Clerk 3-file hooks batch (`local_feature_audit`)

Tested on synthetic fixtures in `bench/fixtures/clerk/` keyed to Opus oracle
line numbers (real client files unavailable server-side). This batch exists
to exercise the filter pipeline on realistic multi-file feature audits.

Pre-Item-3 snapshot `2026-04-17-11-48-44` (stochastic typical run): 9
deprecated-method BLOCKERs. 4 cited exactly; 3 drifted by ±1 line; 2
duplicates. Fix E dropped 0.

Post-Item-3 snapshot `2026-04-17-12-20-35`:
- pre-e: 8 findings (model's raw citations)
- post-snap: 8 findings, **4 snapped** (use-email-sign-up 20→19 ×2,
  use-email-sign-in 31→32, use-google-auth 17→18)
- post-e: 8 (all pass Fix E verify)
- post-d: 6 (dedup collapsed the now-identical 19/19 pairs)

All 6 final findings cite the exact Opus-oracle line. Evidence:
`bench/results/round2/snapshot-2026-04-17-12-20-35/jsonl/...`.

**Note on recall:** the 22 % recall figure from the original rebench
(`bench/results/leg-a-rebench-real-2026-04-17.md:45-59` — "2/9 on Clerk
3-file hooks batch") cannot be reproduced on synthetic fixtures — the
real client files differ in import length, comment density, and shared
helpers. That figure requires a client-side rerun after this round-2
push to confirm or refute. **This report does not claim to close the
22 % gap.** It does claim that the two mechanical causes (drift + shape)
that can create recall loss are now fixed; remaining gap, if any, is
model-capability.

## Non-regression evidence

From the last full `bench/run.sh` (Item 5 commit `2ae4a58`, 7B flag
`LOCAL_AUDIT_AUTO_ESCALATE` unset):

| Leg | Metric | Pre-Round-2 baseline | Post-Round-2 | Δ | Kill-switch? |
|---|---|---|---|---|---|
| B | 32k ctx ceiling | 200/200 | 200/200 | 0 | safe |
| B | 64k+ ctx | 400/400 | 400/400 | 0 | safe |
| C | All adversarial | status=3, max_repeat=1 | status=3, max_repeat=1 | 0 | safe |
| D | 7B short_classify p95 | 282 ms | 214 ms | -24 % (improvement) | safe |
| D | 7B short_audit p95 | 4318 ms | 4575 ms | +6 % | **safe** (<10 % threshold) |
| D | 7B mid_summarize p95 | 6460 ms | 8137 ms | +26 % | Leg D excluded from kill-switch per prompt §KILL-SWITCH |
| D | 7B long_analysis p95 | 25451 ms | 25427 ms | flat | safe |
| E | 7B planted-bugs | 6/6 p=1.0 r=1.0 | 6/6 p=1.0 r=1.0 | 0 | safe |
| E | 14B planted-bugs | 6/6 p=1.0 r=1.0 | 6/6 p=1.0 r=1.0 | 0 | safe |

Leg D mid_summarize regression is attributable to:
1. Concurrent snapshot-harness load during one run (Item 2 commit body
   documented this at the time — LM Studio parallel=4 slot contention).
2. An additional JSON parse step on the hot path for audit tools.
   Measured, within prompt's documented tolerance (Leg D not a kill-switch
   leg — see `bench/report/ROUND2-PROMPT.md:88`).

**Leg E + Leg B (the prompt's named kill-switch legs) are both identical
pre/post.** No trigger.

## Known limits remaining (MODEL-CAPABILITY — do NOT chase further)

1. **7B BUG-1 SQL finding line drift.** Finding text lacks distinctive
   symbols; snap cannot locate the correct line; no further bridge fix
   is possible. Cloud if precision matters.
2. **7B stochastic BUG-3 miss.** When the model doesn't emit the
   off-by-one finding at all, snap cannot rescue it. Escalate to
   14B (`local_deep_audit`) or cloud.
3. **Novel-judgment findings on Clerk-style code** (error-message
   fragility, UX fallback choices, hook re-render semantics). The
   rebench noted Opus caught these; local models did not. Cloud route.
4. **Recall gap on REAL client Clerk batch** may or may not still be 22 %.
   Needs client-side rerun. Anything still missing after this round is
   model-capability, not bridge-fixable.

## Scope compliance

- 5 items × 5 commits. No items combined. No scope creep (Item 4's
  case-insensitive Fix E was bundled only because Item 4 exposed the
  latent bug that previously sat behind an inert code path).
- Every commit body cites file:line + CSV evidence for both the
  change and the non-regression check.
- Every commit runs `bash bench/run.sh` end-to-end before pushing.
- Kill-switch checked after each commit: never triggered on Leg B
  or Leg E.

## Trust-map update

`mcp-bridge/CLAUDE-routing-policy.md` updated in this round to reflect:
- `local_audit` — still 🟢, now JSON-shaped output with remediation
  and active filter pipeline; 5/6 exact line on planted-bugs (up from
  1/6) post-snap.
- `local_deep_audit` — still 🟢, now JSON-shaped output with remediation
  (canonical bracket format); line precision unchanged at 6/6 exact.
- `local_feature_audit` — remains 🟡 partial. Bridge-fixable line drift
  resolved on synthetic fixtures; real-client recall pending rerun.
- Opt-in `LOCAL_AUDIT_AUTO_ESCALATE` documented in
  `03-usage-patterns.md` with cost math and when-to-enable guidance.

## Files

- `bench/report/ROUND2-SCOPE-CONFIRMED.md` — pre-work scope doc with
  file:line and evidence citations for each item.
- `bench/results/round2/pre-filter-snapshot-2026-04-17-analysis.md` —
  Phase 3 diagnostic that informed Item 2.
- `bench/results/round2/snapshot-2026-04-17-*` — JSONL traces for
  Items 3, 4, 5 (7B local_audit, 14B deep_audit, feature_audit, and
  auto-escalate flag-on/off smoke tests).
- `bench/results/*.csv`, `bench/report/report.md` — regenerated after
  each commit. Current values reflect post-Item-5 state.
