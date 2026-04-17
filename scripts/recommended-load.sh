#!/usr/bin/env bash
# HEAVY-only. Manually pinned 2026-04-17 after 9-model, 6-fixture head-to-head
# bench (see 04-fallback-gpt-oss-20b.md for full scorecard).
#
# Winner: Qwen2.5-Coder-7B-Instruct MLX 4-bit — scored a perfect 60/60 in 51s,
# beating 20B/30B rivals on every fixture. Uses only 4.3 GB resident, leaving
# room for bigger context and/or a parallel companion model.
#
# Re-run `python3 scripts/find_parallel.py` to re-probe if hardware changes.

LMS=~/.lmstudio/bin/lms

"$LMS" server start --bind 0.0.0.0 --port 1234 --cors
"$LMS" unload --all 2>/dev/null
"$LMS" load qwen2.5-coder-7b-instruct --context-length 131072 --gpu max -y
"$LMS" ps
