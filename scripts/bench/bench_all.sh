#!/usr/bin/env bash
# Sequential bench driver: for each model, unload-all → load → run 6 fixtures.
# Writes per-model JSON to /tmp/bench_<slug>.json and a combined /tmp/bench_all.json.
set -u
LMS=~/.lmstudio/bin/lms
MODELS=("$@")
if [[ ${#MODELS[@]} -eq 0 ]]; then
  echo "Usage: bench_all.sh <model-id> [<model-id>...]" >&2
  exit 2
fi

COMBINED='{}'
for m in "${MODELS[@]}"; do
  slug=$(echo "$m" | tr '/:' '__' | tr -cd 'A-Za-z0-9._-')
  out=/tmp/bench_${slug}.json
  log=/tmp/bench_${slug}.log
  echo "==================================================================="
  echo "MODEL: $m    (slug: $slug)"
  echo "==================================================================="

  echo "[1/3] unloading all..."
  "$LMS" unload --all 2>/dev/null || true

  echo "[2/3] loading $m ..."
  if ! "$LMS" load "$m" --context-length 32768 --gpu max -y 2>&1 | tail -5; then
    echo "LOAD FAILED for $m — skipping"
    echo "{\"error\":\"load_failed\"}" > "$out"
    continue
  fi

  # Determine the actual model-id as exposed by /v1/models (lms may differ)
  actual=$(curl -s http://127.0.0.1:1234/v1/models 2>/dev/null | \
    python3 -c "import json,sys;d=json.load(sys.stdin);ids=[x['id'] for x in d.get('data',[]) if 'embed' not in x['id'].lower()];print(ids[0] if ids else '')" 2>/dev/null)
  if [[ -z "$actual" ]]; then
    echo "no model id from /v1/models — skipping"
    continue
  fi
  echo "exposed as: $actual"

  echo "[3/3] running bench..."
  node /tmp/bench2.mjs "$actual" 2>&1 | tee "$log"

  if [[ -f /tmp/bench2_results.json ]]; then
    cp /tmp/bench2_results.json "$out"
    COMBINED=$(python3 -c "
import json
a = json.load(open('/tmp/bench_all.json')) if __import__('os').path.exists('/tmp/bench_all.json') else {}
b = json.load(open('$out'))
a.update(b)
json.dump(a, open('/tmp/bench_all.json','w'), indent=2)
print('ok')
    " 2>&1)
  fi
done

echo "==================================================================="
echo "ALL DONE. Combined: /tmp/bench_all.json"
