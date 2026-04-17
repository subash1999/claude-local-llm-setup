#!/usr/bin/env bash
# Re-runnable bench harness orchestrator.
# Runs Legs B/C/D/E against local LM Studio and renders report.md.
# Leg A is MCP-bound (requires Claude Code session) — run manually.
#
# Usage:
#   bench/run.sh                 # full sweep on HEAVY (7B)
#   MODEL=qwen2.5-coder-14b-instruct bench/run.sh   # sweep on DEEP (14B)
set -eu

cd "$(dirname "$0")"

MODEL="${MODEL:-qwen2.5-coder-7b-instruct}"
export MODEL

echo "=== Leg B: context ceiling sweep ==="
MODEL="$MODEL" bash harness/leg-b-sweep.sh

echo "=== Leg C: adversarial inputs ==="
node harness/leg-c-adversarial.mjs

echo "=== Leg D: latency distribution (N=20) ==="
node harness/leg-d-latency.mjs
node harness/leg-d-percentiles.mjs

echo "=== Leg E: accuracy vs ground truth ==="
node harness/leg-e-accuracy.mjs

echo "=== Render report ==="
node harness/render-report.mjs

echo "Done. Report: bench/report/report.md · CSVs: bench/results/*.csv"
