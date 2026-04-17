# Local LLM capability map

- **Date:** 2026-04-17
- **Host:** M3 Pro 18 GB, subashs-macbook-pro.local:1234 (LM Studio)
- **Models:** qwen2.5-coder-7b-instruct (HEAVY), qwen2.5-coder-14b-instruct (DEEP, JIT)
- **Framework:** bench harness at `bench/harness/`, results at `bench/results/`

---

## Leg A — local_feature_audit @ 6 files

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


---

## Leg B — Context ceiling (anchor retrieval)

### qwen2.5-coder-7b-instruct

| target_tokens | actual_prompt_tokens | wall_ms | recalled | has_repeat | anchor_repeat | http_status |
| --- | --- | --- | --- | --- | --- | --- |
| 2000 | 1366 | 6844 | 3 | false | false | 200 |
| 4000 | 2551 | 11712 | 3 | false | false | 200 |
| 4000 | 2554 | 9780 | 3 | false | false | 200 |
| 8000 | 4917 | 17211 | 3 | false | false | 200 |
| 16000 | 9652 | 32635 | 3 | false | false | 200 |
| 24000 | 14387 | 49633 | 3 | false | false | 200 |
| 32000 | 19116 | 68952 | 3 | false | false | 200 |
| 48000 | 28578 | 120074 | 3 | false | false | 200 |
| 64000 | 38038 | 167747 | 3 | false | false | 200 |
| 96000 | -1 | 199692 | 0 | false | false | 400 |
| 128000 | -1 | 6925 | 0 | false | false | 400 |
| 160000 | -1 | 878 | 0 | false | false | 400 |

**Summary:**
- Max accepted input (HTTP 200 + 3/3 recall, no repeat): **38038 actual prompt tokens**.
- First HTTP 400 at target=96000 (server rejected: input exceeded configured context window).
- No recall or repetition degradation observed within accepted range.



---

## Leg C — Adversarial inputs

| model | case | wall_ms | finding_count | max_line_repeat | claims_no_findings | maybe_truncated |
| --- | --- | --- | --- | --- | --- | --- |
| qwen2.5-coder-14b-instruct | empty | 1186 | 0 | 1 | true | true |
| qwen2.5-coder-14b-instruct | repetition-bait | 3002 | 0 | 1 | true | true |
| qwen2.5-coder-14b-instruct | binary | 818 | 0 | 1 | true | true |
| qwen2.5-coder-14b-instruct | huge | 11747 | 0 | 1 | true | true |
| qwen2.5-coder-7b-instruct | empty | 6092 | 0 | 1 | true | true |
| qwen2.5-coder-7b-instruct | repetition-bait | 1656 | 0 | 1 | true | true |
| qwen2.5-coder-7b-instruct | binary | 423 | 0 | 1 | true | true |
| qwen2.5-coder-7b-instruct | huge | 5622 | 0 | 1 | true | true |

---

## Leg D — Latency distribution

| model | shape | n | p50_ms | p95_ms | p99_ms | p50_tps |
| --- | --- | --- | --- | --- | --- | --- |
| qwen2.5-coder-14b-instruct | short_classify | 10 | 323 | 651 | 651 | 6.41 |
| qwen2.5-coder-14b-instruct | short_audit | 10 | 2675 | 2891 | 2891 | 14.57 |
| qwen2.5-coder-14b-instruct | mid_summarize | 10 | 7047 | 12925 | 12925 | 14.76 |
| qwen2.5-coder-14b-instruct | long_analysis | 10 | 50043 | 51990 | 51990 | 15.97 |
| qwen2.5-coder-7b-instruct | short_classify | 10 | 211 | 678 | 678 | 9.52 |
| qwen2.5-coder-7b-instruct | short_audit | 10 | 3629 | 4575 | 4575 | 27.56 |
| qwen2.5-coder-7b-instruct | mid_summarize | 10 | 5485 | 6542 | 6542 | 29.02 |
| qwen2.5-coder-7b-instruct | long_analysis | 10 | 25427 | 25700 | 25700 | 31.42 |

---

## Leg E — Accuracy vs ground truth (planted-bugs.ts)

| model | unique_bugs_found | true_positive | false_positive | hallucinated_line | recall | precision |
| --- | --- | --- | --- | --- | --- | --- |
| qwen2.5-coder-7b-instruct | 6 | 6 | 0 | 0 | 1.000 | 1.000 |
| qwen2.5-coder-14b-instruct | 6 | 6 | 0 | 0 | 1.000 | 1.000 |

---

## Leg G — Cloud vs Local comparison

| Tier | Model | Cost / 1M tok (in/out) | Ctx window | Output cap | p50 latency/req | Best-fit shapes | Known failure modes |
|---|---|---|---|---|---|---|---|
| Local HEAVY | Qwen2.5-Coder-7B | $0 / $0 | 131072 (server-capped) | ~4k practical | see Leg D | audit/review/find/summarize of ≤3 files, short classify, diff review | NIT/BLOCKER section loop at ≥4 files; fabricated line-number +5 offsets |
| Local DEEP | Qwen2.5-Coder-14B | $0 / $0 | 131072 | ~2k practical | +8s JIT first call, ~2x 7B after | second-opinion audit (rule-4 ladder), single-file audit where 7B loop | must serialize (RAM cap ~15GB combined); first-call JIT cost |
| Cloud cheap | Claude Haiku 4.5 | $1 / $5 | 200k | 8k | ~2s | classify, trivial one-file read, bulk WebSearch verify | weaker on multi-file reasoning, prone to skim |
| Cloud mid | Claude Sonnet 4.6 | $3 / $15 | 1M | 8k | ~4s | multi-file explore, tool-iteration review, refactor analysis, graph walks | occasional over-confidence on unseen APIs |
| Cloud premium | Claude Opus 4.7 | $15 / $75 | 1M | 32k | ~8s | architecture, novel design, multi-step debug, prod-critical codegen | expensive; not needed for tier-2 shapes |

**Decision rule:** cheapest tier that fits. Local first when task matches the rule-2 tool table in `claude-local-llm-setup/mcp-bridge/CLAUDE-routing-policy.md`. Doubt ladder: local HEAVY → local DEEP → Haiku+WebSearch → Sonnet → Opus.

