# Leg A: local_feature_audit @ 6 files

- **Date:** 2026-04-17
- **Model:** qwen2.5-coder-7b-instruct (HEAVY)
- **Server:** http://subashs-macbook-pro.local:1234
- **Wall time:** 96.2 s
- **Files:** 6 auth feature files (311 LOC total)
- **Spec:** Clerk v3 Future API — flag deprecated v2 shapes

## Files under audit

| Path | LOC |
|---|---|
| apps/native/src/features/auth/hooks/use-email-sign-up.ts | 43 |
| apps/native/src/features/auth/hooks/use-email-sign-in.ts | 43 |
| apps/native/src/features/auth/hooks/use-google-auth.ts | 36 |
| apps/native/src/features/auth/hooks/use-me.ts | 11 |
| apps/native/src/features/auth/components/ClerkAuthProvider.tsx | 12 |
| apps/native/src/features/auth/screens/VerifyCodeScreen.tsx | 166 |

## Verdict

**🟡 stays 🟡 — do NOT promote.** Loop pathology identified in the 3-file bench (2026-04-17 trust-map entry) has not been fixed by the server-side context raise to 131072. It migrated from the NIT section to the BLOCKER section.

## Findings breakdown

- **Real BLOCKERs (10):** Findings #1–10 are correct and match the spec.
  - use-email-sign-up.ts:14 → deprecated `sendEmailCode`
  - use-email-sign-up.ts:21 → deprecated `verifyEmailCode`
  - use-email-sign-in.ts:14 → deprecated `signIn.emailCode.sendCode`
  - use-email-sign-in.ts:21 → deprecated `signIn.emailCode.verifyCode`
  - use-google-auth.ts:14 → wrong OAuth entry shape
  - use-google-auth.ts:23, :25 → wrong session-ID access
  - use-me.ts:4 → null-safety gap
  - VerifyCodeScreen.tsx:14 → mode type too loose
  - VerifyCodeScreen.tsx:24 → no `code.length < 6` guard
- **Hallucinated repeats (~28):** BLOCKER #11 onward is `handleResend does not handle the case where isSubmitting` at fabricated line numbers 31, 36, 41, 46 … 156 (pattern: +5 offset per line, runs past file EOF of 166 lines).
- **Truncation:** output ends mid-token at `handleRes…`.

## Symptom classification (rule-4)

- ❌ Repetition loop filling `max_tokens`
- ❌ Invented line numbers past EOF
- ❌ Single finding regurgitated with cosmetic position change
- ✅ Real findings present in first block (trust BLOCKERs #1–10)

## Recommendation

1. Trust-map stays `🟡 partial` for `local_feature_audit`.
2. Bridge-side fix priority: cap input ≤3 files, dedup findings, cross-check cited line against source before emitting. See `bench/report/BUGFIX-HANDOFF.md` BUG 2.
3. Cap at ≤3 files per call continues to be load-bearing advice.
4. For feature audits ≥4 files that need clean output, escalate to `local_deep_audit` per file or split into ≤3-file batches.

## Addendum (2026-04-17, post Leg F Opus oracle cross-check)

The "10 real BLOCKERs" claim above is **too lenient**. Opus oracle (Leg F, `bench/report/leg-f-opus-oracle.md` Task B) verified each against source:

- **Actually real:** 8 (the Clerk v2 deprecated-API BLOCKERs and the OAuth return-shape issues).
- **Invented inside the "clean" block:**
  - `use-me.ts:4 → null-safety gap` — the guard exists at lines 7-9.
  - `VerifyCodeScreen.tsx:24 → no code.length < 6 guard` — the guard exists at lines 55-58.

This means the failure mode is worse than "real findings then garbage tail" — local **confidently fabricates plausible-looking BLOCKERs inside what looks like clean output**, at specific file:line locations with coherent symptoms. The loop tail is the obvious tell; the pre-loop invented findings are the dangerous tell.

**Trust-map advice updated: spot-check EACH finding against source. Do not blindly trust the pre-loop block.**

Opus additionally found 6 real issues both local models missed (`publishableKey as string`, `error.message.includes('cancel')` fragile match, `isLoading` semantics, possibly-dead `result.error` checks, both hooks always called, `ClerkLoaded` no fallback). For production-critical auth/payment features, **use cloud, not local_feature_audit**.
