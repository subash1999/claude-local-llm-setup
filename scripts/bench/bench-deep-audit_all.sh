#!/usr/bin/env bash
# F7 driver — sequentially loads DEEP (14B) and HEAVY (7B), runs the
# deep-audit bench against each, combines the two per-model results into
# a single `scripts/bench/results-deep-audit-<DATE>.json`.
#
# Unlike scripts/bench/bench_all.sh (6-fixture /60 general model picker),
# this is a pass/fail regression for the complementary-failure-mode claim
# that keeps the 14B around: HEAVY catches classic patterns (SQLi);
# DEEP is supposed to also catch the subtler non-injection findings.
#
#   bash scripts/bench/bench-deep-audit_all.sh
#   DEEP_MODEL=... HEAVY_MODEL=... bash scripts/bench/bench-deep-audit_all.sh
set -u
LMS=~/.lmstudio/bin/lms
DEEP="${DEEP_MODEL:-qwen2.5-coder-14b-instruct}"
HEAVY="${HEAVY_MODEL:-qwen2.5-coder-7b-instruct}"
CTX="${CTX:-4096}"  # tiny fixture; 4K fits well under wired RAM for both
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$HERE/bench-deep-audit.mjs"
DATE=$(date +%F)
OUT="$HERE/results-deep-audit-$DATE.json"

run_one() {
  local model="$1"
  echo "==================================================================="
  echo "MODEL: $model   (ctx=$CTX)"
  echo "==================================================================="
  "$LMS" unload --all 2>/dev/null || true
  if ! "$LMS" load "$model" --context-length "$CTX" --gpu max -y 2>&1 | tail -5; then
    echo "LOAD FAILED for $model"
    return 1
  fi
  # Use /v1/models to discover the exposed id (may differ from the lms arg).
  local actual
  actual=$(curl -s http://127.0.0.1:1234/v1/models | \
    python3 -c "import json,sys;d=json.load(sys.stdin);ids=[x['id'] for x in d.get('data',[]) if 'embed' not in x['id'].lower()];print(ids[0] if ids else '')")
  if [[ -z "$actual" ]]; then echo "no model id exposed"; return 1; fi
  echo "exposed as: $actual"
  node "$BENCH" "$actual"
  # bench writes $OUT keyed by the exposed id; read it back for merging.
  cp "$OUT" "/tmp/deep-audit-$(echo "$actual" | tr '/:' '__').json"
}

run_one "$DEEP"
run_one "$HEAVY"

# Merge the two per-model files. bench-deep-audit.mjs overwrites $OUT each run,
# so the last-run model's results are in $OUT; the earlier one is in /tmp.
python3 - <<PY
import json, pathlib, glob, os
date = "$DATE"
out  = pathlib.Path("$OUT")
here = pathlib.Path("$HERE")
combined = {"fixture": "F7-deep-audit", "date": date, "results": {}}
for p in glob.glob(f"/tmp/deep-audit-*.json"):
    d = json.load(open(p))
    combined["results"].update(d.get("results", {}))
# Include whatever is already in out (last run).
if out.exists():
    d = json.load(open(out))
    combined["results"].update(d.get("results", {}))
json.dump(combined, open(out, "w"), indent=2)
print(f"wrote combined: {out}")
PY
