# Round 2 Phase 3 — pre-filter snapshot analysis

- **Date:** 2026-04-17
- **Bridge:** server.mjs @ `0d8d03c` (Item 1 logging shipped)
- **Target:** `local_feature_audit` on 3-file Clerk hooks batch
- **Harness:** `bench/harness/leg-a-direct.mjs` (MCP stdio client, drives real server.mjs with `LOCAL_LLM_DEBUG_DIR` set)
- **Fixtures:** synthetic reconstructions in `bench/fixtures/clerk/` keyed to Opus oracle line numbers (`bench/report/leg-f-opus-oracle.md`). Real client Clerk files not available server-side.

## Method

Ran 2 snapshots of the same 3-file batch (`use-email-sign-up.ts`, `use-email-sign-in.ts`, `use-google-auth.ts`) against 7B HEAVY via the real MCP bridge. Each snapshot writes one JSONL file with 6 stages: `raw-model`, `post-think`, `post-json-first`, `pre-e`, `post-e`, `post-d`.

## Findings-per-stage table

| Run | raw-model | post-json-first | pre-e | post-e | post-d | Drops (E) | Drops (D) |
|---|---|---|---|---|---|---|---|
| 2026-04-17-11-46-49 | 3799 B | 11 | 11 | 11 | 11 | **0** | **0** |
| 2026-04-17-11-48-44 | 2831 B | 9 | 9 | 9 | 9 | **0** | **0** |

**Both runs: Fix E dropped 0 findings. Fix D dropped 0 findings.**

## Findings content (stochastic across runs)

- Run 1: 11 × `null-safety` BLOCKER (hallucinated — model found "undefined check missing" instead of v2 deprecation). Zero real Clerk-v3 findings.
- Run 2: 9 × deprecated-method BLOCKER. 4 correctly located (sign-up L19/L32, sign-in L19/L32, google-auth L26 cancel). 3 drifted by ±1 line (google-auth L17 where real is L18, L21 where real is L22, sign-up L20 where real is L19 echo/L26 resend).

## Diagnosis (answers Phase 3 question)

**Phase 3 prompt question:** "Which real BLOCKERs the model emitted but Fix E dropped (over-drop) vs which real BLOCKERs the model never emitted (not bridge-fixable)?"

**Answer on this evidence:** 0 over-drops. The recall gap observed in the client-side leg-a rebench (22 % = 2/9 on real Clerk batch) is NOT caused by Fix E over-dropping on this reconstruction. The gap is:
- **Run 1-style behavior:** model emits wrong-shape findings (null-safety hallucination). Never-emit → model-capability, NOT bridge-fixable.
- **Run 2-style behavior:** model emits right-shape findings but some miss the `resendCode` sites and have ±1-line drift. Every finding passed through Fix E untouched — symbols (`sendEmailCode`, `startSSOFlow`, `error.message`) were present within ±3 of the cited line.

## Divergence from client rebench

Client rebench (`bench/results/leg-a-rebench-real-2026-04-17.md:45-59`) reported `[INFO] bridge source cross-check: 2 dropped` on its Clerk batch. This snapshot on synthetic fixtures: 0 dropped. Plausible reasons for divergence:
1. Real client Clerk files have longer imports / comment headers, pushing symbol occurrences farther from the model's cited line than ±3.
2. Real files contain shared helper imports whose names the model confused with Clerk symbols, producing findings with citations more than ±3 away.
3. Stochastic variance — the 2 drops could be a single-run observation not reproducible.

Regardless, on synthetic fixtures the Fix E algorithm is demonstrably not over-dropping.

## Item 2 decision

Per prompt options:
- **(a) widen ±3 → ±5**: safe expansion. No regression on this evidence (0 drops → 0 drops). Aligns with rebench hypothesis "may be too narrow for long imports/comments at the top of Clerk hook files" (leg-a-rebench-real-2026-04-17.md:81). Ships.
- (b) keyword match in window: more complex, no evidence it would help on this snapshot. Defer.
- (c) BLOCKER strong-evidence: would only help if whole-file has symbol but ±3 window doesn't. Synthetic fixtures show ±3 window already finds the symbol. Defer.

**Choice: (a).** Minimal-risk expansion. Commit body will cite this file.

## Limitations

- Synthetic fixtures are not the real client's Clerk files. The 22 % recall from the client rebench may not be reproducible on these reconstructions.
- Server-side cannot re-run the client's exact batch. Future round-3 evidence-gathering should come from the client re-running leg-a after each round-2 push.
- Run-to-run stochasticity is large (11 vs 9 findings, entirely different content). Two-run sample is small; conclusions are directional, not statistically strong.

## Files

- `snapshot-2026-04-17-11-46-49/` — run 1 (null-safety hallucination run)
- `snapshot-2026-04-17-11-48-44/` — run 2 (deprecated-method run)
- Each contains: `jsonl/local-llm-bridge-filters-<call_ts>.jsonl`, `tool-response.txt`, `manifest.json`
