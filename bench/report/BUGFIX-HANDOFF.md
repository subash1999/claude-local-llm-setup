# Server-side bugfix handoff — local LLM bridge

**Target machine:** home Mac (LM Studio host, `subashs-macbook-pro.local:1234`).
**Repo on server:** `~/claude-local-llm-setup/` (same git remote as client).
**Branch with evidence:** `bench/local-llm-capability-map`. Pull and read `bench/report/` + `bench/results/` for raw data.

Discovered during the 2026-04-17 capability-map bench. All bugs are in the bridge or LM Studio config — **not** in the model weights. Fix them server-side so every client gets the benefit, instead of adding defensive rules to every caller's routing policy.

---

## BUG 1 — Context window volatility (CRITICAL)

### Symptom

`local_capabilities` advertises `heavy_model.context_length = 131072`. Actual accepted-input ceiling on a single live session swung **38 038 → 4 031 actual prompt tokens** between leg runs (see `bench/results/leg-b-ctx-ceiling.csv` for the 38k pass, then `bench/harness/leg-b-ctx-ceiling.mjs` smoke probes mid-bench rejecting at ~5k). LM Studio quietly unloaded 7B and reloaded it with a smaller context window, probably triggered by memory pressure or TTL-based eviction.

Server response when exceeded:
```
HTTP 400 {"error":"The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input"}
```

### Root cause

LM Studio's on-demand reload picks up a default context size, not the value originally configured at manual load. The bridge has no visibility into the current loaded config — it returns the hard-coded `context_length` from `server.mjs` to callers.

### Fix candidates (do both)

**Fix A — pin the context at load, prevent reload with smaller config:**
- In LM Studio: load `qwen2.5-coder-7b-instruct` with explicit `Context Length` set high (test what the 18 GB M3 Pro comfortably sustains — earlier bench passed 38k, so ≥ 40 960 should be achievable).
- Turn on **Keep model loaded** / disable auto-unload TTL so nothing evicts it.
- Same for `qwen2.5-coder-14b-instruct` when used.
- Document in `01-server-setup-this-mac.md` so this survives future reinstalls.

**Fix B — bridge-side: stop lying about `context_length`:**
- In `~/claude-local-llm-setup/mcp-bridge/server.mjs`, the `local_capabilities` handler currently returns a static number.
- Probe the real loaded limit on startup (one tiny completion request + introspect from the server's response if available, or attempt a no-op chat with a known-large dummy prompt and capture the 400 threshold; cache the floor).
- Alternatively: expose a `probe_context` helper that does one binary-search call at startup, cached for the session. Re-probe on every rule-10 cloud fallback trigger.
- At minimum: when the server returns HTTP 400 with `"greater than context length"`, the bridge should:
  1. Catch it (don't surface raw 400).
  2. Log the failure with the actual prompt token count it sent.
  3. Retry ONCE at 50% input length (drop oldest half of system+user content or split multi-file audits into two halves and merge).
  4. If still fails, bubble with a clear `LOCAL_CTX_OVERFLOW` error so the client can cloud-fallback cleanly per rule 10.

### Success criterion

After the fix, a bench re-run of Leg B (`bash bench/run.sh`) on this same host should show:
- Consistent accepted ceiling across ≥ 3 back-to-back full-sweep runs.
- No `context_length` drop during a single bench session.
- `local_capabilities.context_length` matches the actually-achievable ceiling (tolerance ≤ 5%).

---

## BUG 2 — `local_feature_audit` invents findings in the "clean" block + loop pathology tail (CRITICAL for trust)

### Symptom

Leg A ran `local_feature_audit` over 6 real Clerk auth files (see `bench/results/leg-a-feature-audit-6files.md` for the full output). Output structure:

1. **First "clean" block (10 BLOCKERs):** looked legitimate. Opus oracle cross-check (Leg F, `bench/report/leg-f-opus-oracle.md`) verified against source → **only 8 were real**. 2 were invented at precise-looking `file:line` locations with plausible symptoms:
   - `use-me.ts:4 → null-safety gap` — the guard exists at L7-9.
   - `VerifyCodeScreen.tsx:24 → no code.length < 6 guard` — the guard exists at L55-58.
2. **Loop tail (28+ fabricated BLOCKERs):** `handleResend does not handle the case where isSubmitting` at lines 31, 36, 41, 46 … 156 (file EOF is line 166). Mechanical `+5` line-offset pattern. Output truncated mid-token at `handleRes...`.

Direct-call path (no MCP bridge, just `curl /v1/chat/completions` with similar adversarial input) on BOTH 7B and 14B returns clean `no findings` for empty / binary / 30-near-identical-fns / 200-repeated-lines fixtures (see `bench/results/leg-c-adversarial.csv`). The model itself does not loop on repetitive code.

### Root cause

The pathology is in the bridge layer, not the model. Three mutually-compatible theories (instrument the bridge to tell which applies):

1. **Prompt template amplifies repetition.** The `local_feature_audit` system prompt probably asks for "one finding per issue, file:line references, list format". With 6 files of similar auth hook patterns (submit handlers with `isSubmitting` guards), the model locks into a per-pattern output cadence; once it emits one finding shaped `X does not handle Y`, autoregressive sampling pulls it toward emitting more of the same shape at mechanically-adjacent line numbers.
2. **No output de-dup / repetition breaker.** The bridge forwards raw model output to the client without any post-processing. A simple dedup (drop any finding whose `{symbol, problem-class}` already appeared) would eliminate the 28 repetitions, and a regex on `line mod 5 == 1 for 5+ consecutive findings → truncate` would catch the specific pattern seen.
3. **Missing source cross-check.** The bridge trusts `LINE N` from the model without verifying the finding matches what's actually at that line in the file. For the 2 invented pre-loop BLOCKERs, the model confidently named a file:line with a plausible symptom; a quick re-read of the file at the cited line would have shown the claimed issue isn't there.

### Fix candidates (ship in order of effort)

**Fix C — cap input at ≤3 files server-side (one-line change, immediate):**
- In `mcp-bridge/server.mjs` `local_feature_audit` handler, if `file_paths.length > 3`, respond with a structured error: `{ ok: false, reason: "feature_audit limited to 3 files — split your request", file_count: N }`. Current trust-map already advises ≤3; enforce it.

**Fix D — dedup findings + repetition breaker (medium effort):**
- After the model responds, post-process the findings list:
  - Parse each line into `{path, line, symbol, problem}`. Drop any where `{symbol, problem-class}` already appears in the output.
  - Detect mechanical `+N` line-offset pattern: if 5 consecutive findings share the same symbol and problem, and their lines form an arithmetic progression, truncate at the first repeat.
  - If truncation occurs, append a warning finding: `{severity: "WARN", symptom: "local model entered repetition loop on symbol X; output truncated at line Y — consider cloud fallback"}`.

**Fix E — source cross-check for every finding (higher effort, highest value):**
- For each `{path, line, symbol}` in the model's output, re-read `path` ± 3 lines around `line` and verify `symbol` (or a related keyword from the `problem` field) appears there. If not, either:
  - Attempt to re-locate the symbol by scanning the whole file (ripgrep for symbol name) and patch the line number.
  - Drop the finding and log as `likely hallucinated line`.
- This eliminates BOTH the invented pre-loop BLOCKERs AND the fabricated past-EOF loop lines.

**Fix F — structured output contract (ambitious, fixes the "no remediation" quality gap):**
- Update the `local_feature_audit` prompt template to require JSON output: `[{file, line, symbol, severity, problem, remediation}, ...]`.
- Validate the JSON server-side; retry once with a repair prompt if malformed.
- Pass severity and remediation through to the client. This closes the "local gives labels, cloud gives patches" gap called out in `leg-f-opus-oracle.md` Task B.

### Success criterion

After the fix, re-running Leg A (from a Claude Code client session via `mcp__local-llm-bridge__local_feature_audit`) on the same 6 Clerk files + Leg A spec should:
- Return ≤ 3 files per call OR return a structured error (Fix C).
- Contain zero findings whose cited `line` ± 3 does not contain the cited symbol (Fix E).
- Contain zero runs of ≥ 3 findings with the same symbol at `+5` mechanical offsets (Fix D).
- Promote the trust-map entry for `local_feature_audit` from 🟡 → 🟢.

---

## BUG 3 — `local_audit` line-number drift (HIGH, blocks auto-apply pipelines)

### Symptom

Leg E planted-bugs accuracy (`bench/results/leg-e-qwen2_5-coder-7b-instruct.txt`): 7B reports bugs at lines 5, 10, 17, 23, 30, 41 vs ground truth 9, 14, 20, 28, 37, 41. Systematic drift of ~4 lines (underbite — model counts from the function body start, skipping imports/comments). 14B drift is smaller (1-3 lines, see `leg-e-qwen2_5-coder-14b-instruct.txt`). Opus at 6/6 exact.

This is a soft bug — the *finding* is correct, the *position* is wrong. But for any "LLM audits, then an autofix tool applies patch at reported line" pipeline, it's fatal.

### Root cause

Model counts differently depending on whether it sees `<document>` framing, leading comments, line-prefix numbering, etc. Without explicit line-prefix numbering (`1: import ...`, `2: `, `3: function foo()`), it drifts.

### Fix candidates

**Fix G — prefix every line with its number before sending to the model:**
- In `mcp-bridge/server.mjs`, before forwarding file content for `local_audit` / `local_review` / `local_feature_audit`, add a line-number prefix:
  ```js
  content.split('\n').map((l, i) => `${String(i + 1).padStart(4, ' ')}| ${l}`).join('\n')
  ```
- Update the system prompt to tell the model: "lines are numbered at the start (`NNNN| `); cite the exact number shown". Model no longer has to count; it reads.
- This is a 10-minute fix and addresses 7B + 14B simultaneously.

**Fix H — validate + snap line numbers (post-processing):**
- After receiving the model's findings, for each `{line, symbol}`, verify `line` ± 3 contains `symbol`. If off by N, snap to the nearest match within ±10 lines. If no match within ±10, flag as suspicious.

### Success criterion

Re-run Leg E on both 7B and 14B: line-number accuracy should be 6/6 exact (or within ±1, to tolerate 0-index / 1-index edge cases).

---

## Priority order

1. **BUG 1 (ctx volatility)** — blocks every local_* call randomly. Ship Fix A immediately (LM Studio config change, 2 min). Ship Fix B next session (~1 hour in `server.mjs`).
2. **BUG 2 (feature_audit invented findings + loop)** — active trust hazard. Fix C (file cap) is 5 minutes and ships today. Fix D (dedup) is a half-day. Fix E (source cross-check) is higher value; schedule for this week. Fix F (structured JSON + remediation) is next sprint.
3. **BUG 3 (line drift)** — soft bug, 10-minute fix (Fix G).

## After fixing

Re-run the bench harness on this server:
```bash
cd ~/claude-local-llm-setup
git pull  # pull bench/ from the client branch
bash bench/run.sh
```

Compare `bench/results/*.csv` to the 2026-04-17 baseline committed on `bench/local-llm-capability-map`. Promote trust-map entries as improvements land. If anything regresses, stop the rollout.

## Non-goals / what NOT to fix here

- Don't retrain or re-quantize the models — the bench proved the weights are fine on direct-call.
- Don't add a retry-on-doubt loop that silently calls cloud — the client's rule 10 already handles that. Bridge's job is to fail loudly, not to paper over model weakness.
- Don't add a "trust the first 10 findings" heuristic to the client — that advice was wrong (2 of 10 were invented, per Leg F Opus cross-check).
