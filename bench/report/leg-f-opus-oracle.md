# Leg F: Opus Oracle — Cloud Quality Comparison vs Local 7B / 14B

- **Date:** 2026-04-17
- **Reviewer:** Claude Opus 4.7 (1M context) — cloud
- **Purpose:** Determine where local Qwen2.5-Coder 7B/14B lose to cloud on real daily-use shapes. Recall is a tie (P=R=1.0 for both local models on planted-bugs), so this report focuses on **line-number fidelity**, **remediation quality**, **false-positive calibration**, and **subtle findings** that local misses.
- **Tokens used:** this report, not tool calls. Opus did no local_* calls (per bench rules).

---

## Task A — `planted-bugs.ts`

### Opus findings (against ground-truth 6 bugs)

| ID | Line | Severity | Symptom | Remediation |
|---|---|---|---|---|
| BUG-1 | 9 | CRITICAL | SQL injection via string concatenation into `SELECT`. `email` is untrusted user input. | Use parameterized queries. Exact shape depends on the real driver behind `db: any`, but the generic fix is `db.query("SELECT * FROM users WHERE email = ?", [email])` or a tagged-template (`sql\`...\``) helper. Do not escape by hand. Tighten the `db: any` type so the signature itself refuses raw strings. |
| BUG-2 | 14 | CRITICAL | MD5 used for password hashing. MD5 is collision-broken and — more importantly here — it is a fast general-purpose hash, not a password KDF. An attacker with the hash can brute-force common passwords at GPU speed. | Use a password-KDF with a per-password salt and tunable work factor: `bcrypt` (10–12 rounds), `argon2id` (64 MB memory, 3 iters, 4 parallelism as a starting point), or `scrypt`. Never store the plaintext, the MD5, or a peppered MD5. If a pepper is used, store it out-of-band (KMS), not in the repo. Plan a rotation path for any hashes already stored under MD5 (rehash on next successful login). |
| BUG-3 | 20 | HIGH (logic) | Off-by-one. `for (let i = 0; i <= max; i++)` pushes up to `max + 1` items when `items.length > max`. | Change the condition to `i < max`, or replace the whole loop with `items.slice(0, max)`. `slice` also handles negative `max` and `max > items.length` correctly. Add a unit test: `limitItems([1,2,3], 2)` must return `[1,2]`, not `[1,2,3]`. |
| BUG-4 | 28 | HIGH | Optional-chain result cast to non-nullable string. If `profile` is undefined, `name` becomes `undefined`, then `name.toUpperCase()` throws `TypeError: Cannot read properties of undefined`. The `as string` is a lie to the type checker. | Drop the cast and branch: `const name = user.profile?.name; return name?.toUpperCase() ?? '';` — or, if the empty-string default is wrong for the caller, `if (!user.profile?.name) throw new Error('missing name')`. Either way, remove the `as string`. Better: tighten the input type to make `profile` required if the function requires it. |
| BUG-5 | 37 | HIGH | Empty catch swallows every failure from `fetch` and `res.json()`. Network errors, non-2xx statuses (actually `fetch` doesn't throw on non-2xx, but `res.json()` throws on invalid JSON), abort signals — all silently return `undefined`. Callers get `undefined` with no way to distinguish "success but null body" from "network down". | Log or rethrow: `catch (err) { logger.error({ err, url }, 'fetchData failed'); throw err; }`. Also check `res.ok` before parsing JSON — currently a 500 response with HTML body will throw inside `res.json()` and be swallowed. Consider returning `Result<T, Error>` if callers need to discriminate without exceptions. |
| BUG-6 | 41 | CRITICAL | Hardcoded `sk_live_` secret in source. `sk_live_` is Stripe's live-mode-secret-key prefix — this is a production credential. It is in git history even if removed now. | (a) **Rotate immediately** — treat it as leaked regardless of repo visibility. (b) Scrub history (`git filter-repo` or BFG) or, if the repo is public, consider it fully burned and rotate all downstream dependents. (c) Load from env: `process.env.API_KEY` with a fail-fast check at boot. (d) Add a pre-commit hook (`gitleaks`, `trufflehog`) and a CI secret-scan job so this cannot recur. (e) Audit logs on the key provider (Stripe) for the window between commit date and rotation. |

**Additional observations, not in ground truth** (flagged but not counted as quality delta):

- Line 8 `db: any` — the type annotation itself is a problem; a typed query builder or at least a narrow interface would have made BUG-1 unrepresentable at compile time.
- Line 13 `pwd: string` returned as `hex` digest — the function doesn't also accept/require a salt. Even after moving off MD5, the API shape is wrong: password hashing requires salt-in, salted-hash-out. Fix the signature too.
- Lines 44–54 `add`/`multiply`/`subtract` — clean, no findings. (Confirming compliance with the "any finding here = false positive" rule.)

### Comparison vs local

| Axis | local 7B | local 14B | Opus |
|---|---|---|---|
| Bugs found (of 6) | 6 | 6 | 6 |
| False positives | 0 | 0 | 0 |
| Hallucinated lines past EOF | 0 | 0 | 0 |
| Line numbers correct vs ground truth | **0/6** (all drifted ~-4) | **1/6** (only BUG-3 right at 20) | **6/6** |
| Severity labels | none | none | 6/6 |
| Remediation advice | none (just symptom labels) | none | full, per-finding |
| Subtlety beyond ground truth | none | none | 2 meta-observations (`db: any`, salt-in-signature) |

**Quality delta (what Opus caught that both local missed):** line-fidelity (both local models drifted systematically — 7B by ~4 lines on every finding), per-finding severity, and actionable remediation. On planted-bugs the *presence* of bugs is caught by local, but **the output is a label list, not a review**. If a human hands local output to a developer to fix, the developer still has to:

1. Re-locate each bug (line numbers are wrong).
2. Decide how to fix it (no remediation).
3. Assess priority (no severity).

With Opus output, the developer can act immediately.

**What local caught that Opus missed:** nothing on this fixture. Both local models returned cleanly with zero FPs.

---

## Task B — Clerk auth feature (6 files)

Spec: Clerk v3 Future API. Flag deprecated v2 shapes (`sendEmailCode`, `verifyEmailCode`, `signIn.emailCode.sendCode/verifyCode`, `startSSOFlow`), plus standard checks (loading states, submit-in-flight guards, error messages, `setActive`).

### Opus findings

#### `use-email-sign-up.ts`

| Line | Severity | Finding | Remediation |
|---|---|---|---|
| 19 | BLOCKER | Deprecated `signUp.verifications.sendEmailCode()` — v2 shape. Clerk v3 Future API uses `signUp.prepareVerification({ strategy: 'email_code' })`. | Replace call with `await signUp.prepareVerification({ strategy: 'email_code' })`. Same on line 26 (`resendCode`). |
| 26 | BLOCKER | Same deprecated `sendEmailCode()` in `resendCode`. | As above. |
| 32 | BLOCKER | Deprecated `signUp.verifications.verifyEmailCode({ code })` — v2 shape. | Replace with `await signUp.attemptVerification({ strategy: 'email_code', code })`. |
| 17, 20, 27, 33 | NIT (question) | `if (result.error) throw result.error` — in Clerk v3 Future API, SDK methods throw on error rather than return an `{ error }` field. These branches may be dead code (v2 shape retained after a partial migration), or the wrapper has been kept intentionally for type compat. | Confirm against `@clerk/expo` v3 types. If the return type has no `.error` field, remove these four branches. If they are TypeScript `any`-masked leftovers from v2, remove them; the `await` + global try/catch is enough. |
| 12 | NIT | `isLoading = fetchStatus === 'fetching'` reflects Clerk's internal fetch state, not the hook's own pending `create`/`prepareVerification`/`attemptVerification` calls. Consumers see `isLoading === false` mid-request. | The screen (`VerifyCodeScreen`) independently tracks `isSubmitting`, so UX is currently fine. But the hook's exported `isLoading` is misleading for other consumers. Either rename to `clerkFetching`, or wrap in a local `useState` flag toggled around each async call. |

#### `use-email-sign-in.ts`

| Line | Severity | Finding | Remediation |
|---|---|---|---|
| 19 | BLOCKER | Deprecated `signIn.emailCode.sendCode()` — v2 nested-resource shape. | Replace with `await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: <id> })`. Note v3 requires the identifier ID from `signIn.supportedFirstFactors`, not just the address; the current `signIn.create({ identifier })` on line 16 gives you the supported factors, pick the email_code entry. |
| 26 | BLOCKER | Same deprecated `signIn.emailCode.sendCode()` in `resendCode`. | As above. The resend path is harder because you need the `emailAddressId` cached from the initial `create`. Store it in hook-local state or in a ref. |
| 32 | BLOCKER | Deprecated `signIn.emailCode.verifyCode({ code })`. | Replace with `await signIn.attemptFirstFactor({ strategy: 'email_code', code })`. |
| 17, 20, 27, 33 | NIT | Same `if (result.error) throw result.error` question as `use-email-sign-up.ts`. | Same remediation. |
| 12 | NIT | Same `isLoading` issue as sign-up. | Same remediation. |

#### `use-google-auth.ts`

| Line | Severity | Finding | Remediation |
|---|---|---|---|
| 10 | BLOCKER | `const { startSSOFlow } = useSSO();` — `startSSOFlow` is the v2 name. Clerk v3 Future API exposes `startFlow` (or `ssoFlow.start()`, depending on SDK minor version — verify against `@clerk/expo` v3 release notes). | Replace with `const { startFlow } = useSSO();` and update the call site on line 18. Confirm the returned shape; in v3 the returned object uses `session` (with its `id`), not a flat `createdSessionId`. |
| 18 | BLOCKER | `startSSOFlow({ strategy: 'oauth_google' })` — name + possibly return shape. | `await startFlow({ strategy: 'oauth_google' })`. Destructure `{ session }` and use `session?.id` instead of `createdSessionId`. |
| 22 | BLOCKER (cascading) | `if (createdSessionId)` — depends on v2 return shape. | After v3 fix, `if (session?.id) await activateAndRegister(clerk, session.id);` |
| 26 | HIGH | `error.message.includes('cancel')` — fragile string match for control flow. Any localization or upstream message change (Clerk changing "cancel" to "canceled" or "Authentication cancelled") breaks cancel detection, causing the cancel path to bubble up as a user-visible error. | Clerk raises `ClerkAPIResponseError` with stable `code` values. Cancel should have a code like `oauth_cancelled` or the error is an `expo-web-browser` `WebBrowserResult` with `type === 'cancel'`. Inspect the real error shape in dev and check the code, not the message text. |
| 16–32 | LOW | `try/finally` with `setIsLoading` is correct, but the cancel branch returns inside `try` after which `finally` still runs — this works, just noting the control flow is subtle. | No change, optional refactor to split success / cancel / error paths into three branches for clarity. |

#### `use-me.ts`

No findings. The `if (!ctx) throw` guard at lines 7–9 is correct; type-narrowing on the return makes downstream `.activateAndRegister` safe.

> **Local 7B false positive:** leg-a labeled this as `use-me.ts:4 → null-safety gap` BLOCKER. The guard is present. This is an invented issue inside the "trustworthy first 10 findings" block.

#### `ClerkAuthProvider.tsx`

| Line | Severity | Finding | Remediation |
|---|---|---|---|
| 6 | HIGH | `process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY as string` — the `as string` hides a missing env var. If the key is not set at build time, `publishableKey` is `undefined` and `ClerkProvider` receives `undefined`, which in Clerk produces an opaque init error at runtime, sometimes swallowed by `ClerkLoaded` never firing. | Fail fast: `const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY; if (!publishableKey) { throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set'); }`. The throw will be caught by the JS error boundary and surfaces a clear message instead of the silent ClerkLoaded-hang. |
| 8–11 | NIT | `<ClerkLoaded>` with no fallback — while Clerk is bootstrapping, children render nothing (blank screen). | Add a splash / `ActivityIndicator` fallback: `<ClerkLoaded>{children}</ClerkLoaded><ClerkLoading><SplashScreen /></ClerkLoading>` or use the sibling `<ClerkLoading>` component. Low severity because bootstrap is usually <200 ms, but on cold start / slow network the flash is visible. |

#### `VerifyCodeScreen.tsx`

| Line | Severity | Finding | Remediation |
|---|---|---|---|
| 21 | LOW | `const mode = (params.mode as string) ?? 'sign-up';` — `as string` masks undefined, and `'sign-up'` vs `'sign-in'` is an untyped string literal. Passing `mode=banana` routes to the sign-in hook silently. | Type it: `type Mode = 'sign-up' \| 'sign-in'; const mode: Mode = params.mode === 'sign-in' ? 'sign-in' : 'sign-up';`. Or validate with zod and show an error screen on invalid mode. |
| 29–30 | LOW (perf) | Both `useEmailSignUp()` and `useEmailSignIn()` are always called regardless of `mode`. Each hook subscribes to Clerk state. Minor waste — both are lightweight, but it violates the principle of "don't load what you don't use". | Split into two screens (one per mode) under Expo Router, or conditionally call — though conditional hook calls violate Rules of Hooks, so the clean fix is the split. |
| 33–38 | NIT | `useEffect` with empty deps does cleanup on unmount. Correct. But the cleanup closes over `countdownTimer.current` which is fine because refs are stable. Just noting the pattern is not buggy here even though it looks suspicious. | No change. |
| 40–52 | MEDIUM | `startResendCooldown` reads `countdownTimer.current` and sets a new interval. If the component re-renders mid-countdown and `handleResend` is called again, `isResending` guard on line 73 prevents it. But if `resendCountdown` reaches 0 and user taps immediately, the old interval has already cleared itself on line 46 — fine. Subtle race: if `setInterval` fires *between* user action and `isResending` flip, nothing is broken but the countdown could tick one extra time. | Use `setTimeout` recursion or `requestAnimationFrame` if the tick precision matters. For a 60-second resend cooldown, `setInterval` is fine. Noted for completeness. |
| 55–58 | — | `code.length < 6` guard IS present. No finding. | — |
| 78, 82 | LOW | Alert text hardcoded Japanese. The project's CLAUDE.md notes "UI テキストは現在日本語ハードコード（i18n フレームワーク未導入）" — so this is known and accepted. | No change, known tech debt. |

> **Local 7B false positive:** leg-a labeled `VerifyCodeScreen.tsx:24 → no code.length < 6 guard` as a BLOCKER. The guard is at lines 55–58. This is the second invented issue inside the "first 10 trustworthy findings".

### Comparison vs local_7B (leg-a)

| Finding | local 7B | Opus | Notes |
|---|---|---|---|
| `sendEmailCode` deprecated (use-email-sign-up.ts) | ✓ @ L14 (wrong line, right symptom) | ✓ @ L19 (correct) | Both catch. Opus also flags L26 resend. |
| `verifyEmailCode` deprecated | ✓ @ L21 (wrong line) | ✓ @ L32 | Both catch. |
| `signIn.emailCode.sendCode` deprecated | ✓ @ L14 (wrong line) | ✓ @ L19 | Both catch. |
| `signIn.emailCode.verifyCode` deprecated | ✓ @ L21 (wrong line) | ✓ @ L32 | Both catch. |
| `startSSOFlow` deprecated | ✓ @ L14 (wrong line, labeled "wrong OAuth entry shape") | ✓ @ L10, L18, L22 (3 related call sites) | Opus decomposes the cascade; local gives one label. |
| `createdSessionId` return shape v2 | ✓ @ L23, L25 (wrong lines) | ✓ @ L22 | Both catch. |
| `use-me.ts` null-safety gap | ✓ @ L4 | ✗ (no finding) | **Local FP.** Guard exists lines 7–9. Opus correctly did not flag. |
| `VerifyCodeScreen` mode type too loose | ✓ @ L14 | ✓ @ L21 | Both catch. |
| `VerifyCodeScreen` missing `code.length < 6` guard | ✓ @ L24 | ✗ (no finding) | **Local FP.** Guard exists at L55–58. Opus correctly did not flag. |
| `publishableKey as string` silent on missing env | ✗ | ✓ @ L6 | **Quality delta — Opus only.** |
| `error.message.includes('cancel')` fragile | ✗ | ✓ @ L26 | **Quality delta — Opus only.** |
| `isLoading = fetchStatus` misleading to consumers | ✗ | ✓ @ L12 (both hooks) | **Quality delta — Opus only.** |
| `if (result.error) throw` — dead code in v3? | ✗ | ✓ (question, not assertion) | **Quality delta — Opus only.** Opus frames as a question because verification requires SDK source; local didn't see the issue. |
| Both hooks always called in VerifyCodeScreen (perf) | ✗ | ✓ @ L29–30 | **Quality delta — Opus only.** |
| `ClerkLoaded` with no fallback (UX) | ✗ | ✓ @ L8–11 | **Quality delta — Opus only.** |
| Loop pathology (28 fabricated `handleResend` findings) | ✓ (pathology) | ✗ | **Opus advantage: no pathology.** |

**Real BLOCKER count:**

- Local 7B: leg-a report claimed 10 real BLOCKERs. **Verified against source: 8 real, 2 false positives** (use-me.ts null-safety, code.length guard). Trust-map narrative "trust BLOCKERs #1–10" is too lenient.
- Opus: 9 BLOCKERs (6 deprecated-API + 3 cascading return-shape), 0 FPs.

**Quality delta (Opus caught, both local missed):**

1. `publishableKey as string` masks missing env var → silent boot failure.
2. `error.message.includes('cancel')` — fragile string-match for control flow.
3. Exported `isLoading` misleading to hook consumers (reflects Clerk state, not hook state).
4. `if (result.error) throw` may be dead code in v3 Future API.
5. Both hooks always called regardless of mode (perf/correctness smell).
6. `ClerkLoaded` with no fallback (UX).

**Signal local offers that Opus doesn't:** none on this feature. Every local finding Opus covered, and more. Local 7B produced **2 invented BLOCKERs inside the "trusted" block** and **28 fabricated repetitions after**.

**Nuance advantage (both caught, Opus remediation meaningfully better):** every deprecated-method finding. Local emits `"deprecated sendEmailCode"`; Opus emits `"replace with signUp.prepareVerification({ strategy: 'email_code' })"`, which is actionable. On `startSSOFlow`, Opus also flags that the return-shape migration (`createdSessionId` → `session.id`) is a cascade, not a single-line fix.

---

## Verdict

### Summary table

| Task | local 7B recall | local 7B precision | local 14B recall | local 14B precision | Opus recall | Opus precision | Line fidelity (7B / 14B / Opus) |
|---|---|---|---|---|---|---|---|
| A — planted-bugs | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 0/6 / 1/6 / 6/6 |
| B — 6-file Clerk audit | 8/15 (53%) | 8/38 (21% incl. loop) — or 8/10 (80%) if loop tail ignored | not benchmarked | n/a | 15/15 | 15/15 | mostly drifted / n/a / correct |

(Task B "15" = the union of findings in the Opus report. Local 7B caught 8 of those 15 genuinely, plus 2 invented issues, plus 28 pathology repetitions.)

### Recommendation per daily-use shape

| Shape | Local worth it? | Quality loss vs cloud | Reasoning |
|---|---|---|---|
| **Single-file audit** (`local_audit`) | ✅ Yes | Low. Labels are correct; remediation is absent. | For lint-tier sweeps, local's label-list is fine — the dev already knows how to fix SQL injection. For anything requiring remediation recommendations (architecture advice, library-specific fix), escalate. Line-number drift is annoying but not fatal in a <100 LOC file. |
| **Diff/PR review** (`local_diff_review`) | ✅ Yes, with re-read | Low–medium. | Trust-map says 🟢, bench shows clean output. But re-read the diff yourself — don't trust line numbers without a spot-check. |
| **Multi-file feature audit** (`local_feature_audit`, ≥4 files) | ⚠️ Cautious | **Medium–high.** | Loop pathology still present in leg-a (28 fabricated findings). Even the "trusted" first block contains invented BLOCKERs (2 of 10). Keep trust-map at 🟡. Cap at ≤3 files or escalate to `local_deep_audit` per file. For production-critical auth/payment features — **do not trust local, use cloud**. |
| **Commit grouping** (`local_group_commits`) | ✅ Yes | Negligible. | Heuristic task; exact hashes verified real. Overlap between groups is fine — the reviewer rebalances. |
| **Semantic search** (`local_semantic_search`) | ✅ Yes | None. | Embedding-only task; local is strictly better cost-wise and the bench showed real paths + line ranges. No reasoning-quality axis here. |
| **Keyword find** (`local_find`) | ✅ Yes | None. | Ripgrep-class task. |
| **Single-file classify / short enum** (`local_ask` ≤120 tok) | ✅ Yes | None. | 7B handles label-set tasks fine. |
| **Summarize 1–2 small files** (`local_summarize`) | ✅ Yes | Low. | Summary drift is content-only, no invented APIs in bench. Spot-check on safety-critical output. |

### Concrete bottom line

**You will notice quality loss going local for:**

1. **Multi-file feature audits (≥4 files)** — loop pathology, invented findings inside the "trusted" block, no remediation. Worst affected shape. For production-critical features (auth, payments, security), **do not trust local output without a cloud second opinion**.
2. **Any task where the consumer of the output is a developer who needs to fix the finding** — local gives labels, cloud gives patches. If your workflow is "local finds, human reads, human fixes", the cost of human translation is large. If your workflow is "triage for later review", local is cheap enough.
3. **Tasks requiring nuanced library-version awareness** — Opus correctly flagged Clerk v3 `prepareVerification`/`attemptVerification`/`prepareFirstFactor` replacements. Local gives you "deprecated" but no migration path. You won't notice this until you try to apply the fix.
4. **Any task where line-number precision matters for automation** — local drifts ~4 lines on 7B (more scattered on 14B). For an LLM → apply-suggestion pipeline, this is disqualifying.

**You will NOT notice quality loss going local for:**

1. Single-file planted-bug-class audits (SQL injection, MD5, missing null check). Both local models score P=R=1.0.
2. Keyword/semantic search, commit clustering, short classification.
3. Bulk operations where precision matters less than cost (triage over 100 files).

**Escalation rule to codify:**

- Auth/payment/security/migration → cloud mandatory (matches your current rule 4 "production-critical").
- ≥4-file feature audit → split into ≤3-file `local_feature_audit` batches, OR escalate to `local_deep_audit` per file, OR cloud. Do not single-shot.
- Any local output that will be applied automatically (codemod, autofix) → cloud. Line-number fidelity matters.
- Everything else → local first, escalate on rule-4 triggers.

### Trust-map delta suggestion

- `local_feature_audit` **should stay 🟡**, not be promoted. The invented BLOCKERs inside the "trusted" block (not just the loop tail) are the real signal — they indicate the model can confidently hallucinate a specific line + symptom inside what looks like a clean finding. The loop pathology is the obvious tell; the pre-loop FPs are the dangerous tell.
- `local_audit` **stays 🟢**, but add a spot-check note: "line numbers drift systematically; re-locate before applying". A developer running a single-file audit and then `sed -i` at the reported line will hit the wrong line.
- `local_deep_audit` **stays 🟢** based on leg-a evidence, but deserves re-bench on a 6-file Clerk-feature equivalent before routing feature audits there. Single-file performance ≠ feature-audit performance.

### One-line recommendation for the user

**Keep local for the happy-path single-file and ripgrep-class shapes; route feature audits ≥4 files and all production-critical reviews to cloud regardless of how clean the local output looks — the invented findings inside the "trusted" block are the failure mode that matters.**
