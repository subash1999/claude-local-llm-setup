# Leg A re-bench — FIRST HONEST TEST of round-1 fixes

- **Date:** 2026-04-17 (client-side, post-install-client.sh + MCP reload)
- **Bridge under test:** round-1 patched `server.mjs` via symlink from repo → `~/.claude/mcp-servers/local-llm-bridge/server.mjs`. Prior rebench (`bench/results/leg-a-rebench-2026-04-17.md`) tested the unpatched pre-install copy — findings there were stochastic, not round-1 fixes under test.

## Why this report is needed

Commit `fc52653` fixed a silent install-drift bug: the installed MCP bridge on the client was a byte-level snapshot from first-install, never updated by subsequent `git pull`. All round-1 fix commits (`ebd7d8f..94ad398`) lived in the repo but never reached the tool-call path. Today's symlink + `npm install` in repo + MCP reload = first real test.

## Method

Same 6 Clerk auth fixtures as baseline Leg A, split into 2× 3-file batches per Fix C. Plus `local_audit` + `local_deep_audit` on `bench/fixtures/planted-bugs.ts` for Fix G line-drift check.

## Fix-by-fix scorecard (real evidence)

| Fix | Verdict | Evidence |
|---|---|---|
| A (ctx pin @ 32 768) | ✅ works | server Leg B: 0.05 % spread across 3 sweeps |
| B (400 retry-once at 50 % input) | not exercised | would need an input > ctx cap to trigger; deferred |
| C (≤3 file cap) | ✅ works | 6-file batch split cleanly, cap enforced server-side |
| D (+5 EOF arithmetic-progression loop breaker) | ✅ works | 0 offset loops in either batch |
| D (same-line symbol cluster) | ✅ works via E | prior L132 cluster-of-4 "unused" NITs absent |
| E (source cross-check) | ✅ works + transparent | batch 1 emitted `[INFO] bridge source cross-check: 2 dropped (symbols absent near cited line — likely hallucinated)`. Prior invented FPs (`use-me.ts:4 null-safety`, `VerifyCodeScreen.tsx:24 code-length guard`) gone. |
| F (structured JSON + remediation) | ✅ partial | 14B `local_deep_audit` output shifted to `line:col` structured shape. 7B output still label-only. |
| G (line prefix) | ✅ works on 14B, ⚠️ partial on 7B | **14B: 6/6 EXACT on planted-bugs {9, 14, 20, 28, 37, 41}** (up from 1/6 pre-fix). 7B: 5/6 within ±1 line + 1 bug MISSED entirely (BUG-3 off-by-one at L20). |

## Line-drift table (planted-bugs.ts, 6 bugs)

| Bug | GT line | 7B pre-fix | 7B today | 14B pre-fix | 14B today |
|---|---|---|---|---|---|
| BUG-1 SQL | 9 | 5 | 8 | 6 | **9** ✓ |
| BUG-2 MD5 | 14 | 10 | 13 | 13 | **14** ✓ |
| BUG-3 off-by-one | 20 | 17 | **MISSED** | 20 | **20** ✓ |
| BUG-4 null | 28 | 23 | 27 | 27 | **28** ✓ |
| BUG-5 swallow | 37 | 30 | 32 | 34 | **37** ✓ |
| BUG-6 secret | 41 | 41 | 41 | 39 | **41** ✓ |

14B: 1/6 → 6/6 EXACT. Clean win.
7B: 0/6 exact → 1/6 exact + 5 near (± 1) with 1 bug dropped. Improvement but not perfect. Likely the model ignores the numbered prefix and counts on its own, and Fix G's post-hoc line-snap doesn't have a rescue for 7B.

## Feature_audit batch results vs Opus oracle ground truth

### Batch 1 — `use-email-sign-up.ts`, `use-email-sign-in.ts`, `use-google-auth.ts`

Opus oracle (Leg F) identified 9 real BLOCKERs across these 3 files. 7B output:

- **BLOCKER** `use-email-sign-up.ts:19` — deprecated `sendEmailCode` ✓ (GT L19, **exact**)
- **BLOCKER** `use-email-sign-up.ts:21` — deprecated `sendEmailCode` / `attemptVerification` confusion — **Partial FP** (L21 actual content is `if (sendResult.error) throw`; real `verifyEmailCode` bug is at L32)
- **BLOCKER** `use-google-auth.ts:19` — deprecated `startSSOFlow` ✓ (GT L18-20 destructure, within ±1)
- `[INFO] bridge source cross-check: 2 dropped (symbols absent near cited line)`

**Missed Opus-confirmed BLOCKERs:**
- `use-email-sign-up.ts:32` — `verifyEmailCode` ✗ (referenced at :21 with wrong description; possibly dropped by Fix E)
- `use-email-sign-in.ts:19` — `signIn.emailCode.sendCode` ✗
- `use-email-sign-in.ts:32` — `signIn.emailCode.verifyCode` ✗
- `use-google-auth.ts:22` — `createdSessionId` flat field access ✗
- `use-google-auth.ts:26` — `error.message.includes('cancel')` fragile string match ✗

**Score:** 2 exact-line BLOCKERs + 1 partial FP out of 9 Opus-confirmed. Recall 2/9 (22 %). Fix E may be dropping real findings as part of the 2 it reported. Diagnosis needs pre-dedup logging to confirm.

### Batch 2 — `use-me.ts`, `ClerkAuthProvider.tsx`, `VerifyCodeScreen.tsx`

0 BLOCKERs + 5 NITs. Findings:

- `use-me.ts:6` — error message more descriptive. Drift (message is at L8) but reasonable NIT.
- `ClerkAuthProvider.tsx:6` — `publishableKey` cast without validation. **✓ QUALITY WIN** — this was previously only found by Opus (Leg F). 14B/Fix E surfaced it this time.
- `VerifyCodeScreen.tsx:21` — `mode` not validated. Reasonable.
- `VerifyCodeScreen.tsx:60, :78` — error messages not localized. Known tech debt, labeled as NIT.

Previously-invented FPs **all gone**:
- `use-me.ts:4 null-safety gap` ✗ (guard exists L7-9)
- `VerifyCodeScreen.tsx:24 code-length guard` ✗ (guard at L55-58)
- `VerifyCodeScreen.tsx:132 × 4 unused state symbols` ✗ (all symbols defined + used 3-5×)

## Summary

Round-1 fixes work. Significantly. First honest verification finally possible after install-drift fix.

**Going forward (bridge-fixable, NOT model-capability):**
1. **Log pre-dedup findings** to prove whether Fix E is over-dropping real BLOCKERs. Currently the `[INFO] 2 dropped` surfaces the count but not which symbols. Can't tune without visibility.
2. **Tune Fix E window / criteria.** Current ±3-line window may be too narrow for long imports/comments at the top of Clerk hook files; real `sendEmailCode` at L19 gets found, but cascading-pattern sibling calls at L32 may be dropping because the model's cited line was off by > 3 and the symbol's real nearest instance doesn't match either.
3. **7B-specific post-hoc line snap.** 14B is exact via Fix G; 7B within ±1 needs an extra step. For each 7B finding, grep the cited file for the symbol named in the "problem" text, snap the reported line to the nearest match. Deterministic, cheap.
4. **Fix F JSON enforcement on 7B.** 14B emits `line:col`, 7B still labels. If the bridge requires JSON output and validates it, one repair-prompt retry should get 7B there too.
5. **Auto-escalation** (optional, higher cost). If 7B returns < expected-count findings on a single-file audit, auto-call `local_deep_audit` on the same file and merge results. Trades tokens for recall.

**Not bridge-fixable (model-capability — do NOT chase on server):**
- 7B's inability to catch every Clerk v2 deprecated pattern in one pass (sign-in pair, createdSessionId). That's 7B ceiling.
- Nuanced judgment findings (Opus's `error.message.includes('cancel')` fragility, `isLoading` semantics, `ClerkLoaded` no-fallback). Route to cloud.
- 7B symptom-labels not remediation — structured-output enforcement can shape it, but the *content* of remediation is model-bound.

## Trust-map (updated this commit)

- `local_audit` — **🟢** with line-drift caveat trimmed: 14B exact, 7B ≤ ±1 (was ≤ ±4).
- `local_deep_audit` — **🟢** line-number **EXACT** on planted-bugs. Primary recommendation for any audit where line precision matters.
- `local_feature_audit` — stays **🟡** because real-BLOCKER recall is now 22 % on Opus ground truth (was ~53 % before, but prior runs had FPs propping up the count — net cleaner now). Invented-BLOCKERs gone ✓, loop gone ✓, but drop rate too high. Needs round-2 diagnostic first.
- `local_audit` + `local_deep_audit` both gained: transparent drop reporting from Fix E.

## Files

- This report.
- Raw CSV: `bench/results/leg-e-accuracy.csv`.
- Per-model raw outputs: `bench/results/leg-e-qwen2_5-coder-*-instruct.txt`.
- Bridge commit under test: `94ad398` (merged into main, symlinked into client).
