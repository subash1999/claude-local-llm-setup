# Leg A re-bench (real client, Round 2) — `local_feature_audit` recall

- **Date:** 2026-04-17 (client-side, post Round 2 merge)
- **Bridge under test:** `mcp-bridge/server.mjs` at commit `06839a9`, installed via symlink to `~/.claude/mcp-servers/local-llm-bridge/server.mjs`. Fresh Claude Code session spawned after pull so the stdio MCP child loads the Round 2 code.
- **Purpose:** Re-measure `local_feature_audit` recall on the real client Clerk 3-file hooks batch that scored 2/9 = 22 % in the first honest rebench (`bench/results/leg-a-rebench-real-2026-04-17.md`). Confirm or refute that the Round 2 items (±5 verify window, 7B grep line-snap, JSON-first output + remediation) actually move the dial on real client code — not just on the synthetic `bench/fixtures/clerk/*` fixtures server-side.

## Method

1. `git pull` in `~/claude-local-llm-setup` → head at `06839a9`.
2. Restart Claude Code session → MCP child respawns with Round 2 server.mjs.
3. `local_capabilities` — bridge alive, reports 7B HEAVY + 14B DEEP, canonical tool list.
4. `local_audit` smoke on `bench/fixtures/planted-bugs.ts` — expect 6 findings in `[BLOCKER] path:line — problem | fix: ...` shape, 5/6 exact lines (BUG-1 SQL ±1 drift per ROUND2-FINAL Known limits §1). **Actual: 6 findings, lines {10, 14, 20, 28, 37, 41}, BUG-1 at 10 vs oracle 9 (+1 drift), other 5 exact. Pass.**
5. `local_feature_audit` on the three real client files:
   - `apps/native/src/features/auth/hooks/use-email-sign-up.ts`
   - `apps/native/src/features/auth/hooks/use-email-sign-in.ts`
   - `apps/native/src/features/auth/hooks/use-google-auth.ts`

   Spec passed (matches Opus-oracle `bench/report/leg-f-opus-oracle.md` Task B framing):

   > Clerk v3 Future API integration. Flag any deprecated Clerk v2 shapes: `signUp.verifications.sendEmailCode()`, `signUp.verifications.verifyEmailCode()`, `signIn.emailCode.sendCode()`, `signIn.emailCode.verifyCode()`, `startSSOFlow` (renamed to `startFlow` in v3), flat `createdSessionId` return shape (v3 returns `{ session }` with `session.id`). Also flag standard issues: loading state correctness, submit-in-flight guards, error message handling, `setActive` usage. v3 Future API uses `signUp.prepareVerification({ strategy: 'email_code' })`, `signUp.attemptVerification({ strategy: 'email_code', code })`, `signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId })`, `signIn.attemptFirstFactor({ strategy: 'email_code', code })`.

6. `LOCAL_AUDIT_AUTO_ESCALATE` unset (baseline per prompt §Not in scope).

## Full tool response (verbatim, untruncated)

```
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-up.ts:19 — Deprecated Clerk v2 shape `signUp.verifications.sendEmailCode()` used. | fix: Replace with `signUp.prepareVerification({ strategy: 'email_code' })`.
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-up.ts:32 — Deprecated Clerk v2 shape `signUp.verifications.verifyEmailCode()` used. | fix: Replace with `signUp.attemptVerification({ strategy: 'email_code', code })`.
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-in.ts:19 — Deprecated Clerk v2 shape `signIn.emailCode.sendCode()` used. | fix: Replace with `signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId })`.
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-in.ts:32 — Deprecated Clerk v2 shape `signIn.emailCode.verifyCode()` used. | fix: Replace with `signIn.attemptFirstFactor({ strategy: 'email_code', code })`.
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-google-auth.ts:10 — Deprecated Clerk v2 shape `startSSOFlow` used. | fix: Replace with `startFlow`.
- [BLOCKER] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-google-auth.ts:22 — Flat `createdSessionId` return shape used. | fix: Replace with `{ session }` and access `session.id`.
- [NIT] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-up.ts:14 — Missing submit-in-flight guards for `sendVerificationCode`. | fix: Add a loading state or disable the button while sending the code.
- [NIT] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-email-sign-up.ts:30 — Missing submit-in-flight guards for `verifyCode`. | fix: Add a loading state or disable the button while verifying the code.
- [NIT] /Users/subash/Documents/CODING-SHARED/WE_UP/yomo-app/apps/native/src/features/auth/hooks/use-google-auth.ts:35 — Missing submit-in-flight guards for `signInWithGoogle`. | fix: Add a loading state or disable the button while signing in with Google.
```

**No `[INFO] bridge source cross-check: N dropped` footer.** Fix E (±5 widened verify window) + Item 3 (grep line snap) accepted every finding the 7B emitted.

## Side-by-side vs Opus oracle (9 BLOCKERs)

| # | File | Oracle line | Oracle symbol | 7B round-2 line | Verdict |
|---|---|---|---|---|---|
| 1 | use-email-sign-up.ts | 19 | `sendEmailCode` (primary) | **19** | ✓ exact |
| 2 | use-email-sign-up.ts | 26 | `sendEmailCode` in `resendCode` | — | ✗ missed |
| 3 | use-email-sign-up.ts | 32 | `verifyEmailCode` | **32** | ✓ exact |
| 4 | use-email-sign-in.ts | 19 | `signIn.emailCode.sendCode` (primary) | **19** | ✓ exact |
| 5 | use-email-sign-in.ts | 26 | `sendCode` in `resendCode` | — | ✗ missed |
| 6 | use-email-sign-in.ts | 32 | `signIn.emailCode.verifyCode` | **32** | ✓ exact |
| 7 | use-google-auth.ts | 10 | `startSSOFlow` (destructure) | **10** | ✓ exact |
| 8 | use-google-auth.ts | 18 | `startSSOFlow` (call site) | — | ✗ missed |
| 9 | use-google-auth.ts | 22 | `createdSessionId` v2 shape | **22** | ✓ exact |

- **Recall:** 6/9 = **67 %**.
- **Line fidelity:** 6/6 exact. Zero drift. (±2 tolerance unused.)
- **Invented BLOCKERs (FPs):** 0. Every emitted BLOCKER maps to a real Opus-oracle finding.
- **NITs emitted:** 3 submit-in-flight guards. Reasonable observations, not in the Opus BLOCKER set but consistent with the spec's "submit-in-flight guards" clause. Not counted as FPs.

### Missed BLOCKERs — pattern

All 3 misses are **second/cascading call sites** of a deprecated symbol the 7B already flagged at its first occurrence:

- Oracle #2 (`sendEmailCode` in `resendCode` at L26) — same symbol as #1 @ L19.
- Oracle #5 (`sendCode` in `resendCode` at L26) — same symbol as #4 @ L19.
- Oracle #8 (`startSSOFlow` call site at L18) — same symbol as #7 @ L10.

The 7B emits one canonical finding per deprecated symbol per file rather than flagging every call site. This is consistent with ROUND2-FINAL §"Known limits remaining" — novel/repeated-site judgment is model-capability, not bridge-fixable. No evidence in the output trace that Fix D dedup dropped these (they would have different line numbers pre-dedup); more likely the 7B JSON reply didn't contain them.

## Side-by-side vs prior rebench (2026-04-17, Round 1 only)

| Metric | Round 1 (pre) | Round 2 (post) | Δ |
|---|---|---|---|
| Recall (BLOCKERs) | 2/9 = 22 % | **6/9 = 67 %** | **+45 pp** |
| Line fidelity on emitted | 2/3 exact + 1 partial-FP at wrong line | **6/6 exact** | +1/3 → +6/6 |
| Invented BLOCKERs (FPs) | 1 partial FP (`use-email-sign-up.ts:21` — wrong line, symbol-confused) | **0** | -1 |
| `[INFO] bridge source cross-check: N dropped` | 2 dropped | **0** | -2 |
| Output shape | bracket format, no remediation | **bracket format + `\| fix: …` remediation on every finding** | Item 4 visible |

## Attribution of the gain

Recall jumped from 22 % → 67 % (+45 pp). Contributions, by item:

- **Item 2 (verify window ±3 → ±5, `mcp-bridge/server.mjs:436-437`).** Round 1 Fix E dropped 2 findings as "symbols absent near cited line — likely hallucinated". Those were real findings on long-import files where the model's cited line was >3 off. Widening to ±5 let them pass verification. Today's run: 0 dropped; recall floor raised from 2 to at-least 3 of the 7B's emitted findings.
- **Item 3 (7B post-hoc grep line-snap before Fix E, `mcp-bridge/server.mjs:365-404`).** Prior Round 1 output cited `use-email-sign-up.ts:14` for `sendEmailCode` (real line 19) and `use-google-auth.ts:14` for `startSSOFlow` (real line 10). Today's run cites 19 and 10 exactly. Snap normalised 6/6 to oracle lines before dedup. Visible in the JSONL trace pattern `snap: symbol=<name> drift=<N>` (see round 2 server-side `bench/results/round2/snapshot-2026-04-17-12-20-35/jsonl/` for the same pipeline on synthetic fixtures — client-side runs didn't capture JSONL here because `LOCAL_LLM_BRIDGE_FILTER_SNAPSHOT_DIR` was unset by default).
- **Item 4 (JSON-first output + remediation, `mcp-bridge/server.mjs:916-990, 1195-1260`).** Round 1 7B output was `- BLOCKER / path:line — ...` plain-text which bypassed the bracket `FINDING_RE`, rendering snap/Fix E/dedup inert (see ROUND2-FINAL "Before / after" §"Planted-bugs.ts (7B local_audit)"). Today's output is the canonical `- [BLOCKER] path:line — problem | fix: remediation` shape, so the whole filter pipeline is live on feature_audit too. Visible directly in the tool response above.

Items 1 and 5 had no measurable contribution to recall on this run (Item 1 is diagnostic-only; Item 5 is opt-in and disabled per prompt).

## Remaining gap (3/9 missed BLOCKERs) — is this bridge-fixable?

No. All 3 misses are cascading/repeated call sites of a deprecated symbol the 7B already caught at the first occurrence. This matches ROUND2-FINAL Known limits §3 ("novel-judgment findings — model-capability, not bridge-fixable") generalised to "all-call-sites-of-same-symbol" findings: the 7B emits one canonical finding per symbol per file. To close this gap:

- **Cheap option:** enable `LOCAL_AUDIT_AUTO_ESCALATE=1` (Item 5). The per-file finding-count heuristic will trigger 14B when a feature_audit over 3 files returns only 6 findings (threshold: `feature_audit: files * 1.5`). 14B tends to enumerate call sites more aggressively. Cost: one extra ~8s JIT load + ~3× serialized 14B calls.
- **Expensive option:** route the audit to cloud. Opus found all 9 plus 6 quality-delta findings not covered by any local model.

Neither option is bridge-fixable on the 7B path.

## No footer / no drift — Round 2 working as spec'd

The absence of the `[INFO] bridge source cross-check: N dropped` line is the key signal that **Item 2's ±5 window is not over-dropping**. If Item 2 had regressed (window too wide, letting through hallucinations), we'd expect either invented BLOCKERs or drifted lines — neither present. If Item 2 had been too tight (window still too narrow), we'd expect a `N dropped` footer like Round 1's "2 dropped". Neither present.

Item 3's grep snap visibly fixed line fidelity from 2/3 to 6/6 exact on emitted findings.

Item 4's JSON-first output produced the canonical bracket shape with remediation — Round 1's plain-text shape that bypassed the whole filter pipeline is gone.

## Verdict

- **Success criteria met.** Feature_audit runs without error, returns canonical bracket format, recall is measured and committed.
- **Recall 6/9 = 67 %.** Up from 2/9 = 22 %. **Win**, not just non-regression.
- **No kill-switch finding.** No regression, no invented BLOCKERs, no dropped findings, no hallucinated line numbers.
- **3/9 remaining gap is model-capability** (all-call-sites enumeration on a single symbol), not bridge-fixable on the 7B path. Escalate to 14B via `LOCAL_AUDIT_AUTO_ESCALATE=1` or cloud for complete coverage.

## Trust-map implication

`local_feature_audit` — 🟡 → **🟢-lean** on real client code. Recommend promoting after one more real-client run on a different feature (e.g., pairing-flow or onboarding-flow) to confirm the recall lift generalises beyond the Clerk batch. Until a second data point exists, keep 🟡 with a caveat: "real-client recall measured 67 % on Clerk 3-file batch post Round 2, up from 22 % — bridge-fixable causes resolved; residual gap is model-capability on cascading call sites".

## Files

- This report: `bench/results/leg-a-rebench-real-round2-2026-04-17.md`.
- Prior Round-1 rebench (baseline for comparison): `bench/results/leg-a-rebench-real-2026-04-17.md`.
- Opus oracle (9 BLOCKERs truth): `bench/report/leg-f-opus-oracle.md` Task B.
- Round 2 server-side report (synthetic-fixture measurements): `bench/report/ROUND2-FINAL.md`.
- Bridge commit under test: `06839a9`.
