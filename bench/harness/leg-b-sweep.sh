#!/usr/bin/env bash
# Leg B sweep: run ctx ceiling probe at geometric sizes.
# Usage: MODEL=qwen2.5-coder-7b-instruct bench/harness/leg-b-sweep.sh
set -u
cd "$(dirname "$0")/../.."

MODEL="${MODEL:-qwen2.5-coder-7b-instruct}"
export MODEL

# Target sizes (what we AIM for; actual_prompt_tokens will differ due to char/token ratio)
SIZES=(2000 4000 8000 16000 24000 32000 48000 64000 96000 128000 160000)

echo "[sweep] model=$MODEL sizes=${SIZES[*]}"
for s in "${SIZES[@]}"; do
  echo "[sweep] --- target=$s ---"
  node bench/harness/leg-b-ctx-ceiling.mjs "$s" 2>&1 | tail -16
  echo
done
echo "[sweep] done. csv: bench/results/leg-b-ctx-ceiling.csv"
