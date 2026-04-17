# Leg A re-bench — post BUG 1/2/3 server-side fixes

- **Date:** 2026-04-17 (client-side verification)
- **Server fixes under test:** Fix A (ctx pin), Fix B (400 retry), Fix C (≤3-file cap), Fix D (dedup/loop breaker), Fix E (source cross-check), Fix F (JSON output), Fix G (line prefix)
- **Fixtures:** same 6 Clerk auth files as 2026-04-17 baseline Leg A, split into 2× 3-file batches per Fix C
- **Method:** `mcp__local-llm-bridge__local_feature_audit` on batch 1 (hooks) and batch 2 (provider + screen + me), findings verified against source by direct `Read` + `Grep`

## Findings

### Batch 1 — `use-email-sign-up.ts`, `use-email-sign-in.ts`, `use-google-auth.ts`

5 BLOCKERs + 5 NITs. No +5 offset loop. No truncation.

| # | Sev | Path | Reported line | Actual line | Verdict |
|---|---|---|---|---|---|
| 1 | BLOCKER | use-email-sign-up.ts | 14 | **19** (`sendEmailCode`) | real bug, line drifted -5 |
| 2 | BLOCKER | use-email-sign-up.ts | 26 | **32** (`verifyEmailCode`) | real, drift -6 |
| 3 | BLOCKER | use-email-sign-in.ts | 14 | **19** (`signIn.emailCode.sendCode`) | real, drift -5 |
| 4 | BLOCKER | use-email-sign-in.ts | 26 | **32** (`signIn.emailCode.verifyCode`) | real, drift -6 |
| 5 | BLOCKER | use-google-auth.ts | 14 | **10/18** (`startSSOFlow`) | real, drift -4 to -8 depending on which site |
| 6-10 | NIT | various | various | various | NIT-class observations about `error instanceof Error` branches — reasonable noise |

### Batch 2 — `use-me.ts`, `ClerkAuthProvider.tsx`, `VerifyCodeScreen.tsx`

0 BLOCKERs + 5 NITs.

| # | Sev | Path | Reported line | Actual | Verdict |
|---|---|---|---|---|---|
| 1 | NIT | use-me.ts | 3 | (opinion only — "error message could be more descriptive") | low-value but not invented |
| 2 | NIT | VerifyCodeScreen.tsx | 132 | `resendDisabled` — defined L89, used L141/144/148 | **FABRICATED — claims "not used", actually used 3x** |
| 3 | NIT | VerifyCodeScreen.tsx | 132 | `resendLabel` — defined L90, used L143/151 | **FABRICATED** |
| 4 | NIT | VerifyCodeScreen.tsx | 132 | `resendCountdown` — defined L26, used L73/89/91/92 | **FABRICATED** |
| 5 | NIT | VerifyCodeScreen.tsx | 132 | `countdownTimer` — defined L27, used L35/42/43/46 | **FABRICATED** |

Line 132 actual content: `{isSubmitting ? (<ActivityIndicator color="#fff" />`. None of the 4 claimed symbols appear at or near line 132. All 4 are real, defined, and extensively used elsewhere in the file.

## Fix effectiveness

| Fix | Target pathology | Status | Evidence |
|---|---|---|---|
| A (ctx pin) | BUG 1 — ctx volatility | ✅ Worked | Server-side Leg B rebench: 0.05% spread across 3 sweeps, no mid-session reload drops |
| B (400 retry) | BUG 1 — graceful HTTP 400 handling | not exercised this run | would need a cross-ctx-cap payload to trigger |
| C (≤3-file cap) | BUG 2 — multi-file blast radius | ✅ Worked | 6-file batch split cleanly into 2×3 |
| D (dedup / loop breaker) | BUG 2 — +5 offset EOF loop | ✅ Worked for arithmetic-progression case | No `handleResend` × 28 fabrications in rebench |
| D (dedup / loop breaker) | BUG 2 — cluster-at-same-line cluster | ❌ **Did NOT catch** | 4 FPs at VerifyCodeScreen.tsx:132, different symbols, same problem-class "not used", same wrong line |
| E (source cross-check) | BUG 2 — invented-symbol findings inside clean block | ✅ **Partially worked** | Original Leg A FPs at `use-me.ts:4` and `VerifyCodeScreen.tsx:24` are **gone** from rebench |
| E (source cross-check) | BUG 2 — fabricated claim about real symbol | ❌ **Did NOT catch** | 4 FPs at :132 — symbols exist in file but claim-about-behavior is false. Fix E verifies symbol-presence, not symbol-behavior. |
| F (JSON output + remediation) | BUG 2 — quality gap | not assessed this run | output still labels-only prose; bridge may not have switched feature_audit template yet, or model ignored JSON instruction |
| G (line-prefix numbering) | BUG 3 — line drift | ❌ **Did NOT work** | 7B Leg E post-fix: {5,10,18,23,30,42} vs ground truth {9,14,20,28,37,41} → 0/6 exact, ~-4 systematic drift. Pre-fix was {5,10,17,23,30,41} — **effectively identical**. 14B: {6,13,20,27,34,39} post-fix vs {6,13,20,27,34,39} pre-fix — **literally identical**. Either not deployed in the tool path, or model ignores the line prefix. Feature_audit line numbers also still drift ~4-6 lines. |

## Regressions vs baseline Leg A

Original Leg A surfaced 2 real BLOCKERs now missing from rebench:
- `use-google-auth.ts:23 → wrong session-ID access (createdSessionId)` — real, Opus-confirmed cascading BLOCKER. Not in rebench.
- `use-google-auth.ts:25 → wrong activateAndRegister arg (createdSessionId)` — real, Opus-confirmed. Not in rebench.

Possibly lost to Fix D's dedup (same symbol `createdSessionId`, may have clustered with the line-18 destructure and been collapsed), or stochastic model variance. Either way: **real BLOCKER recall dropped from 8 → 5** between original Leg A and rebench on the same fixture.

## Net scorecard

| Metric | Original Leg A | Rebench | Delta |
|---|---|---|---|
| Real BLOCKERs found | 8 | 5 | **-3 (regression)** |
| Invented BLOCKERs in "clean" block | 2 | 0 | +2 (improvement) |
| Fabricated loop-tail NITs/BLOCKERs | 28 | 0 | +28 (big improvement) |
| New fabricated NIT cluster | — | 4 @ :132 | **-4 (new pathology)** |
| Output truncated mid-token | yes | no | improvement |
| Line drift magnitude | ~-5 to -11 | ~-4 to -6 | slight improvement |

## Trust-map verdict

- `local_feature_audit` — **STAYS 🟡, cannot promote**. Pathology shape changed (+5 EOF loop → same-line different-symbol cluster), real-BLOCKER recall regressed. Fix D/E are partial solutions, not complete.
- `local_audit` — **STAYS 🟢 on recall (6/6)**. Line-drift caveat remains **unchanged**: Fix G did not measurably improve 7B or 14B line accuracy on Leg E.
- `local_deep_audit` (14B) — **STAYS 🟢**. Slightly better line accuracy than 7B (2/6 near-exact vs 0/6) but still drifted.

## Open items for the server Mac

1. **Fix G verification.** Either Fix G isn't wired into `local_audit` / `local_feature_audit` actual request path, or the model ignores the numbering prefix. Please confirm the prefix is present in the prompt the model sees. If yes, consider: (a) stronger system-prompt instruction to cite the prefix number verbatim, (b) regex validate model output's cited line against source content at that line and reject/snap on mismatch.
2. **Fix D same-line cluster.** Extend dedup to: for any `{problem-class, line}`, cap at 1 finding per class-per-line — no matter how many distinct symbols are cited. Under that rule, only one of the 4 VerifyCodeScreen :132 FPs survives and the remaining one gets scrubbed by Fix E's snap-or-drop logic (since `resendDisabled` etc are actually at other lines).
3. **Fix E claim-verification.** Extend cross-check: for problem-class "not used" / "unused" / "dead code", grep the file for the symbol. If symbol appears at ≥1 call site, drop the finding (it's not unused). This single rule eliminates all 4 :132 FPs from this rebench.
4. **Regression of real BLOCKERs.** The 2 createdSessionId BLOCKERs at use-google-auth.ts:23 and :25 are missing. Either dedup cluster ran too aggressively, or model stochastically skipped. Please instrument to log pre-dedup findings so we can tell which.

## Recommendation for now

Client-side advice stays as it was in the previous trust-map:

- Spot-check every pre-loop finding against source (Fix E helps but isn't enough).
- Cap ≤3 files (now server-enforced via Fix C — good).
- For production-critical auth/payment review: cloud, not local.
- For single-file audit: local fine on recall, re-locate symbols by grep before applying any autofix (Fix G didn't resolve drift).
