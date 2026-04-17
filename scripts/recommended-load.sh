#!/usr/bin/env bash
# HEAVY-only. Manually pinned 2026-04-17 after 9-model, 6-fixture head-to-head
# bench (see 04-fallback-gpt-oss-20b.md for full scorecard).
#
# Winner: Qwen2.5-Coder-7B-Instruct MLX 4-bit — scored a perfect 60/60 in 51s,
# beating 20B/30B rivals on every fixture. Uses only 4.3 GB resident, leaving
# room for bigger context and/or a parallel companion model.
#
# ctx=40960 and ttl=2592000 pinned 2026-04-18 after capability-map bench (see
# bench/report/BUGFIX-HANDOFF.md BUG 1). The old ctx=131072 + default 1 h TTL
# combo let LM Studio silently reload 7 B at 4 K under memory pressure, after
# which every request died with "HTTP 400 — greater than context length".
# Pinning explicit + long TTL prevents the silent reload.
#
# Re-run `python3 scripts/find_parallel.py` to re-probe if hardware changes.

LMS=~/.lmstudio/bin/lms

"$LMS" server start --bind 0.0.0.0 --port 1234 --cors
"$LMS" unload --all 2>/dev/null
"$LMS" load qwen2.5-coder-7b-instruct \
  --context-length 40960 \
  --gpu max \
  --parallel 2 \
  --ttl 2592000 \
  -y
"$LMS" ps
