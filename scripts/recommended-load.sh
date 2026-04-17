#!/usr/bin/env bash
# HEAVY-only. Manually pinned 2026-04-17 after 9-model, 6-fixture head-to-head
# bench (see 04-fallback-gpt-oss-20b.md for full scorecard).
#
# Winner: Qwen2.5-Coder-7B-Instruct MLX 4-bit — scored a perfect 60/60 in 51s,
# beating 20B/30B rivals on every fixture. Uses only 4.3 GB resident, leaving
# room for bigger context and/or a parallel companion model.
#
# ctx=32768 and ttl=2592000 pinned 2026-04-18 after capability-map bench (see
# bench/report/BUGFIX-HANDOFF.md BUG 1). The old ctx=131072 + default 1 h TTL
# combo let LM Studio silently reload 7 B at 4 K under memory pressure, after
# which every request died with "HTTP 400 — greater than context length".
# 32 768 is Qwen2.5-Coder's native trained context; going higher requires RoPE
# extrapolation and trades quality for headroom. Escalate to cloud for >32 K
# prompts rather than stretch. Pinning explicit ctx + long TTL prevents silent
# reload to the default 4 K window.
#
# Re-run `python3 scripts/find_parallel.py` to re-probe if hardware changes.

LMS=~/.lmstudio/bin/lms

"$LMS" server start --bind 0.0.0.0 --port 1234 --cors
"$LMS" unload --all 2>/dev/null
"$LMS" load qwen2.5-coder-7b-instruct \
  --context-length 32768 \
  --gpu max \
  --parallel 2 \
  --ttl 2592000 \
  -y
"$LMS" ps
