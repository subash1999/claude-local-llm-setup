#!/usr/bin/env python3
"""find_parallel.py — empirically find the largest HEAVY_parallel / ctx the
current system can run without falling into swap.

Baseline assumption: Claude Code + Terminal (whatever you're using to drive
this session) stay running. Their memory footprint is RESERVED. This probe
measures what's still affordable on top.

The script:
  1. Unloads all models.
  2. Snapshots the baseline (free MB, swap used, swap free).
  3. For each candidate combo in a ladder (biggest first), loads HEAVY with
     that parallelism and context, fires a warmup request, snapshots memory.
  4. A combo PASSES only if:
       - swap used did NOT grow more than SWAP_GROW_LIMIT_MB
       - warmup request returned HTTP 200 with non-empty output
  5. Reports the largest combo that passed and writes the recommended
     `lms load ...` commands to scripts/recommended-load.sh.

Usage:
  python3 scripts/find_parallel.py                    # full ladder
  python3 scripts/find_parallel.py --quick            # only try 3 combos
  python3 scripts/find_parallel.py --heavy-ctx 16384  # override HEAVY context

Requires: lms CLI, LM Studio server up on :1234, HEAVY model downloaded.
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, asdict

URL = "http://127.0.0.1:1234/v1/chat/completions"
HEAVY = "qwen3-coder-30b-a3b-instruct"
LMS   = os.path.expanduser("~/.lmstudio/bin/lms")

# Thresholds — tune if your machine has different headroom.
# We measure swap_used deltas AFTER a warmup chat completes (steady-state),
# not during the load spike. macOS routinely reallocates "free" pages so
# free-MB floors are noisy — swap delta is the trustworthy signal.
SWAP_GROW_LIMIT_MB = 500   # +500 MB swap usage after steady-state = fail

# Ladder: tuples (heavy_parallel, heavy_ctx).
# Ordered biggest→smallest so we stop at the first PASS.
DEFAULT_LADDER = [
    (4, 32768),
    (3, 32768),
    (2, 32768),
    (1, 32768),
    (2, 24576),
    (1, 24576),
    (2, 16384),
    (1, 16384),
    (1, 8192),
]
QUICK_LADDER = [DEFAULT_LADDER[0], DEFAULT_LADDER[2], DEFAULT_LADDER[4]]


@dataclass
class MemSnap:
    free_mb: int
    active_mb: int
    wired_mb: int
    swap_used_mb: float
    swap_free_mb: float

    @classmethod
    def take(cls) -> "MemSnap":
        vm = subprocess.check_output(["vm_stat"]).decode()
        pages = {}
        for line in vm.splitlines()[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                pages[k.strip()] = int(v.strip().rstrip("."))
        free   = pages.get("Pages free", 0) * 16 // 1024
        active = pages.get("Pages active", 0) * 16 // 1024
        wired  = pages.get("Pages wired down", 0) * 16 // 1024

        sw = subprocess.check_output(["sysctl", "-n", "vm.swapusage"]).decode()
        # total = 4096.00M  used = 3146.88M  free = 949.12M  (encrypted)
        used = float(re.search(r"used = ([\d.]+)M", sw).group(1)) if "used" in sw else 0.0
        frees = float(re.search(r"free = ([\d.]+)M", sw).group(1)) if "free" in sw else 0.0
        return cls(free_mb=free, active_mb=active, wired_mb=wired,
                   swap_used_mb=used, swap_free_mb=frees)

    def brief(self) -> str:
        return (f"free={self.free_mb:>5} MB  "
                f"swap used={self.swap_used_mb:>7.1f} MB  "
                f"active={self.active_mb:>5} MB  wired={self.wired_mb:>5} MB")


def lms(*args, check=True) -> subprocess.CompletedProcess:
    return subprocess.run([LMS, *args], capture_output=True, text=True, check=check)


def unload_all():
    lms("unload", "--all", check=False)
    time.sleep(2)


def load_model(slug, ctx, parallel) -> tuple[bool, str]:
    cmd = [LMS, "load", slug, "--context-length", str(ctx), "--gpu", "max", "-y"]
    # Try to pass --parallel (v0.0.33+ supports it; silently ignored on older).
    try:
        r = subprocess.run(cmd + ["--parallel", str(parallel)],
                           capture_output=True, text=True, timeout=180)
        if r.returncode == 0:
            return True, r.stdout.strip()
        # Retry without --parallel on older CLI
        if "unknown option" in (r.stderr or "").lower() or "--parallel" in (r.stderr or ""):
            r2 = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            return (r2.returncode == 0), (r2.stdout + r2.stderr).strip()
        return False, (r.stderr or r.stdout).strip()
    except subprocess.TimeoutExpired as e:
        return False, f"timeout: {e}"


def chat(model, prompt, max_tok=40) -> tuple[bool, str, float]:
    # No /no_think here — we test production conditions (thinking on).
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tok,
        "temperature": 0.2,
    }).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            j = json.loads(r.read())
        dt = time.time() - t0
        out = j["choices"][0]["message"]["content"]
        return (bool(out.strip()), out[:80].replace("\n", " "), dt)
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:160]}", time.time() - t0
    except Exception as e:
        return False, f"{type(e).__name__}: {e}", time.time() - t0


def probe(hp, hc, baseline: MemSnap) -> dict:
    print(f"\n>>> probe: HEAVY(p={hp}, ctx={hc})")
    unload_all()

    ok_h, msg_h = load_model(HEAVY, hc, hp)
    if not ok_h:
        return {"combo": (hp, hc), "status": "HEAVY_LOAD_FAIL", "detail": msg_h}

    # Wait for memory to settle
    time.sleep(3)
    after_load = MemSnap.take()

    ok1, head1, dt1 = chat(HEAVY, "Say one short sentence about entropy.", 120)

    after_chat = MemSnap.take()

    swap_grew = after_chat.swap_used_mb - baseline.swap_used_mb
    free_after = after_chat.free_mb

    status = "PASS"
    reasons = []
    if not ok1:
        status = "FAIL"; reasons.append(f"heavy chat failed: {head1}")
    if swap_grew > SWAP_GROW_LIMIT_MB:
        status = "FAIL"; reasons.append(f"swap grew {swap_grew:.0f} MB (limit {SWAP_GROW_LIMIT_MB})")

    print(f"    after load: {after_load.brief()}")
    print(f"    after chat: {after_chat.brief()}")
    print(f"    heavy: ok={ok1} dt={dt1:.2f}s :: {head1}")
    print(f"    -> {status}  swap delta={swap_grew:+.1f} MB  free_after={free_after} MB")
    for r in reasons:
        print(f"       reason: {r}")

    return {
        "combo": (hp, hc),
        "status": status,
        "after_load": asdict(after_load),
        "after_chat": asdict(after_chat),
        "swap_delta_mb": swap_grew,
        "heavy_dt": dt1,
        "reasons": reasons,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--heavy-ctx", type=int)
    args = ap.parse_args()

    ladder = QUICK_LADDER if args.quick else DEFAULT_LADDER
    if args.heavy_ctx:
        ladder = [(hp, args.heavy_ctx) for (hp, _) in ladder]

    print(">>> unloading everything to get a clean baseline")
    unload_all()
    time.sleep(2)
    baseline = MemSnap.take()
    print(f"    baseline: {baseline.brief()}")
    if baseline.free_mb < 500:
        print(f"\n!!! baseline free RAM is only {baseline.free_mb} MB — consider running cleanup.sh first")

    results = []
    winner = None
    for combo in ladder:
        res = probe(*combo, baseline=baseline)
        results.append(res)
        if res["status"] == "PASS" and winner is None:
            winner = res
            break

    print("\n\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)
    for r in results:
        c = r["combo"]
        print(f"  {r['status']:>4}  HEAVY(p={c[0]},ctx={c[1]})  swap+={r.get('swap_delta_mb','?')}")

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recommended-load.sh")
    if winner:
        hp, hc = winner["combo"]
        print(f"\n*** OPTIMAL: HEAVY(parallel={hp}, ctx={hc}) ***")
        load_line = f'"$LMS" load {HEAVY} --context-length {hc} --gpu max --parallel {hp} -y'
        with open(out_path, "w") as f:
            f.write(f"""#!/usr/bin/env bash
# Auto-generated by find_parallel.py on {time.strftime('%Y-%m-%d %H:%M:%S')}
# Optimal empirical config for this machine with current background load.

LMS=~/.lmstudio/bin/lms

"$LMS" server start --bind 0.0.0.0 --port 1234 --cors
"$LMS" unload --all 2>/dev/null
{load_line}
"$LMS" ps
""")
        os.chmod(out_path, 0o755)
        print(f"Wrote {out_path}")
    else:
        print("\n*** NO combo PASSED. Options:")
        print("    (a) close more background apps, re-run")
        print("    (b) drop HEAVY to GPT-OSS-20B (see 04-doc)")
        print("    (c) try a smaller context: --heavy-ctx 8192")

    # Dump full log for the record
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "find_parallel.log.json")
    with open(log_path, "w") as f:
        json.dump({"baseline": asdict(baseline), "results": results}, f, indent=2, default=str)
    print(f"Full log: {log_path}")


if __name__ == "__main__":
    main()
