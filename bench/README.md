# local LLM capability-map bench

Re-runnable harness for characterizing `local_*` MCP-bridge tools and the underlying models on the LM Studio host.

## Layout

```
bench/
├── run.sh                # orchestrator — runs B/C/D/E + renders report
├── harness/
│   ├── leg-b-ctx-ceiling.mjs    # binary-search context window via anchor retrieval
│   ├── leg-b-sweep.sh           # sweep script (size ladder)
│   ├── leg-c-adversarial.mjs    # empty / binary / repetition-bait / huge inputs
│   ├── leg-d-latency.mjs        # p50/p95/p99 per task shape, N runs each
│   ├── leg-d-percentiles.mjs    # reduces leg-d CSV → percentile summary
│   ├── leg-e-accuracy.mjs       # scores vs GROUND-TRUTH.md planted bugs
│   └── render-report.mjs        # builds bench/report/report.md from CSVs
├── fixtures/
│   ├── planted-bugs.ts          # 6 known bugs at known lines
│   ├── empty.ts                 # adversarial empty file
│   ├── repetition-bait.ts       # 30 near-identical fns — loop trap
│   └── GROUND-TRUTH.md          # scoring rubric
├── results/
│   ├── leg-a-feature-audit-6files.md   # MCP-bound manual leg
│   ├── leg-b-ctx-ceiling.csv
│   ├── leg-c-adversarial.csv
│   ├── leg-c-<case>-<model>.txt        # raw responses for inspection
│   ├── leg-d-latency.csv
│   ├── leg-d-percentiles.csv
│   ├── leg-e-accuracy.csv
│   └── leg-e-<model>.txt
└── report/
    ├── report.md                       # generated
    ├── executive-summary.md            # hand-written
    └── trust-map-patch.md              # proposed patch to routing-policy.md
```

## Run

```bash
# default: 7B heavy model
bash bench/run.sh

# alt model
MODEL=qwen2.5-coder-14b-instruct bash bench/run.sh

# single leg
node bench/harness/leg-e-accuracy.mjs

# single leg, single shape, bespoke N
MODEL=qwen2.5-coder-7b-instruct N=20 SHAPES=short_audit,long_analysis \
  node bench/harness/leg-d-latency.mjs
```

## Leg A — `local_feature_audit` multi-file

Leg A calls the MCP bridge tool directly, which is only reachable from a Claude Code session. Not part of `run.sh`. Procedure:

1. From a Claude Code session in this repo (or yomo-app), invoke `mcp__local-llm-bridge__local_feature_audit` with 3-6 auth/feature files and a realistic spec.
2. Record wall time, verbatim output to `bench/results/leg-a-feature-audit-<N>files.md`.
3. Classify findings into real / hallucinated (stop at first duplicate `symbol@line` + mechanical line offset).

## When to re-run

- Local model swap (e.g. 7B → 32B).
- LM Studio config change (context window, quant level).
- New MCP bridge release (Leg A may behave differently).
- Suspected degradation (2+ rule-4 doubt triggers in a session).

## Scoring rubric

All scoring is deterministic — no cloud oracle required.

- **Leg B:** recall = anchor-UUID-retrieved / 3 per run; repetition = any output line appearing ≥ 3 times.
- **Leg C:** correctness = output matches expected (e.g. `no findings` on empty); loop pathology = ≥ 5 findings with near-identical shape.
- **Leg D:** raw wall-ms per `/v1/chat/completions` call. Excludes warm-up. p50/p95/p99 computed post-hoc.
- **Leg E:** see `fixtures/GROUND-TRUTH.md`. Recall = unique bugs found / 6. Precision = true-positive findings / total findings. Hallucinated line = finding at line > EOF of fixture.

## Caveats

- **Context window is a runtime variable**, not a model constant. LM Studio may auto-unload and reload with a different context length. Re-probe before trusting the prior run's ceiling.
- **14B JIT cost** (~8 s first call) is excluded from per-run latency via warm-up.
- Concurrency limits are NOT re-probed here (trust `local_capabilities.concurrency`). Harness runs all calls serially.
