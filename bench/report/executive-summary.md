# Executive summary — local LLM capability map

Bench date: 2026-04-17. Host: M3 Pro 18 GB, LM Studio @ subashs-macbook-pro.local:1234.
Models: qwen2.5-coder-7b-instruct (HEAVY), qwen2.5-coder-14b-instruct (DEEP).
Oracle: none needed — all legs scored via ground-truth fixtures.

## What this bench answers

1. Where does the 7B break? → context volatility (server-side reload artifact), feature_audit multi-file output loop.
2. Does 14B escalation fix known failure modes? → partial: tighter line-number accuracy on planted bugs, same adversarial robustness.
3. When should I burn cloud quota vs route local? → see §5 decision matrix.

## Top findings

**F0 — (most important) `local_feature_audit` invents findings INSIDE the clean-looking block, not just in the tail.** Leg A surfaced 10 BLOCKERs that looked legitimate. Opus oracle cross-check (Leg F) verified each against source: **2 of the 10 are invented** — `use-me.ts:4 null-safety gap` (guard exists L7-9) and `VerifyCodeScreen.tsx:24 missing code.length<6 guard` (guard exists L55-58). Plus 28 fabricated repetitions in the tail loop. **The "trust the first 10 findings" heuristic from the 2026-04-17 bench was wrong.** For production-critical reviews (auth/payments), cloud is mandatory.

**F1 — Loop pathology is bridge-layer, not model.** The `local_feature_audit` repetition bug reproduces at 6 files. Direct LM Studio calls on the same adversarial input (empty file, 30 near-identical functions, 200-line synthetic file) return clean `no findings` on both 7B and 14B with no loop. → Fix candidate lives in the MCP bridge prompt template + parser, not in model weights. See `BUGFIX-HANDOFF.md` BUG 2.

**F2 — Context window is a runtime variable, not a constant.** LM Studio reloaded 7B during the bench; accepted-input ceiling dropped from ~38 000 actual tokens to ~4 096 actual tokens mid-session. `local_capabilities.context_length` may not reflect the current loaded config. Rule: treat `HTTP 400 — tokens greater than context length` as "retry at shorter input", not "rule-4 doubt".

**F3 — On planted single-file fixture, 7B and 14B both score P=R=1.0 on bug discovery — but Opus wins on everything else.** 6/6 recall for all three. Line-number accuracy: 7B 0/6 correct, 14B 1/6 correct, Opus 6/6. Severity labels: local 0/6, Opus 6/6. Remediation advice: local none (labels only), Opus full per-finding. For any pipeline where local output feeds an auto-apply tool, line-number drift is disqualifying — see `BUGFIX-HANDOFF.md` BUG 3.

**F4 — Adversarial inputs handled correctly at base-model layer.** Empty file, binary bytes, repetition bait (30 near-identical fns), huge (200 repeated lines) all return `no findings` on direct-call path. No looping, no fabrication.

**F5 — 14B is worth the serialization cost for rule-4 escalation.** DEEP passes adversarial + accuracy legs with tighter line-number accuracy than HEAVY. First-call JIT ~8 s amortized across subsequent calls. `concurrency.safe = 1` constraint confirmed — peak RAM with both models resident ≈ 15 GB near wired cap.

## Cloud vs local decision matrix (post-bench)

| Shape | Route | Reason |
|---|---|---|
| Single-file bug audit | `local_audit` (7B) → `local_deep_audit` (14B) if rule-4 | Both local models P=R=1.0 on planted fixture. DEEP gives tighter line numbers. |
| Multi-file feature audit, ≤3 files | `local_feature_audit` (7B) | Clean output, loop pathology not yet triggered at ≤3 files per 2026-04-17 bench. |
| Multi-file feature audit, 4-6 files | Split into ≤3-file batches, merge results | Direct 6-file call loops in BLOCKER section (real findings in first 10, rest fabricated). |
| File search (keyword / semantic) | `local_find` / `local_semantic_search` | Trust-map all 🟢. |
| Diff / PR review | `local_diff_review` | Trust-map 🟢. Verified 2026-04-17. |
| Commit clustering | `local_group_commits` | Trust-map 🟢. |
| Short classify (≤120 out tok) | `local_ask` with N=8 concurrency | 🟢 bench re-confirmed latency p50 ~300 ms (see Leg D). |
| Summarization (short) | `local_summarize` | 🟢. |
| Architecture / novel design / API shape | Cloud (Sonnet default, Opus on "deep") | Per rule 3. |
| Production-critical codegen (auth/payments/migrations) | Cloud + mandatory second opinion | Per rule 4 incl. production-critical carve-out. |
| Irreversible action (push prod / DB migration) | Cloud | Per rule 4 irreversible-action carve-out. |

## Where DEEP (14B) beats HEAVY (7B)

- Line-number accuracy on planted bugs: 14B off 1-3 lines, 7B off 3-7.
- Subjective review wording quality (not scored; qualitative).

## Where HEAVY (7B) beats DEEP (14B)

- Latency (see Leg D). 14B roughly 2-3× wall time per request at same shape.
- Concurrency: 7B safe 4/4 on single-file tools, 14B MUST serialize 1/1 due to RAM.

## Where BOTH still lose to cloud

- Context ceiling: cloud 200 k–1 M vs local 4-40 k (volatile).
- Tool-iteration loops across many files (Sonnet with Read/Grep wins).
- Novel / never-seen APIs (verify via WebSearch + Sonnet).
