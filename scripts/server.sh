#!/usr/bin/env bash
# server.sh — one-shot server-side setup for claude-local-llm-setup.
#
# Run this on the Mac you want to use as the LLM server.
# Idempotent: safe to re-run. Skips steps already done.
#
#   bash scripts/server.sh [--skip-models] [--skip-wired-limit] [--skip-launchagent]
#
# What runs automatically:
#   1. Homebrew + LM Studio install
#   2. lms CLI bootstrap
#   3. HEAVY model download
#   4. iogpu.wired_limit_mb bump (asks for sudo)
#   5. LaunchAgent install (boot-time auto-start + LAN binding)
#
# What you MUST do by hand (can't be automated — GUI-only):
#   A. First-launch LM Studio welcome dialog
#   B. Settings toggles inside LM Studio (listed at the end)
#
# After this finishes, share the printed "server URL" with the client laptop:
#   bash scripts/client.sh http://<that-url>:1234

set -euo pipefail

SKIP_MODELS=0
SKIP_WIRED=0
SKIP_LA=0
for arg in "$@"; do
  case "$arg" in
    --skip-models)       SKIP_MODELS=1 ;;
    --skip-wired-limit)  SKIP_WIRED=1 ;;
    --skip-launchagent)  SKIP_LA=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"; exit 0 ;;
    *)
      echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LMS=~/.lmstudio/bin/lms

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "server.sh supports macOS only (Apple Silicon)."
[[ "$(uname -m)" == "arm64" ]] || warn "Not Apple Silicon — MLX won't work; LM Studio will fall back to CPU or llama.cpp."

# --- 1. Homebrew ----------------------------------------------------------

if ! command -v brew >/dev/null; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  say "Homebrew already installed ($(brew --version | head -1))"
fi

# --- 2. LM Studio ---------------------------------------------------------

if ! [[ -d /Applications/LM\ Studio.app ]]; then
  say "Installing LM Studio"
  brew install --cask lm-studio
  cat <<'EOF'

╭───────────────────────── manual step ──────────────────────────╮
│ Open LM Studio now and click through the first-launch welcome  │
│ dialog. After the main window is open, come back here.         │
│                                                                │
│   open -a "LM Studio"                                          │
╰────────────────────────────────────────────────────────────────╯
EOF
  open -a "LM Studio" || true
  read -rp "Press Enter once LM Studio's main window is open... "
else
  say "LM Studio already installed"
fi

# --- 3. lms CLI -----------------------------------------------------------

if ! [[ -x "$LMS" ]]; then
  say "Bootstrapping lms CLI"
  if [[ -x ~/.lmstudio/bin/lms ]]; then
    ~/.lmstudio/bin/lms bootstrap
  else
    die "lms binary not found at ~/.lmstudio/bin/lms. Open LM Studio once, then re-run."
  fi
fi
"$LMS" --version >/dev/null || die "lms CLI broken — try reopening LM Studio."
say "lms ready: $("$LMS" --version 2>&1 | head -1)"

# --- 4. Models ------------------------------------------------------------

HEAVY_REPO="mlx-community/Qwen3-Coder-30B-A3B-Instruct-3bit"

have_model() { "$LMS" ls 2>/dev/null | grep -qi "$1"; }

if [[ $SKIP_MODELS -eq 0 ]]; then
  if have_model "qwen3-coder-30b-a3b"; then
    say "HEAVY model already downloaded"
  else
    say "Downloading HEAVY: $HEAVY_REPO (~13 GB, 5–15 min)"
    "$LMS" get "https://huggingface.co/$HEAVY_REPO" -y
  fi
else
  say "Skipping model downloads (--skip-models)"
fi

# --- 5. GPU wired memory limit -------------------------------------------

if [[ $SKIP_WIRED -eq 0 ]]; then
  current=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
  if [[ "$current" -ge 14336 ]]; then
    say "iogpu.wired_limit_mb already at $current MB"
  else
    say "Bumping iogpu.wired_limit_mb 14336 (needs sudo)"
    sudo sysctl iogpu.wired_limit_mb=14336
    if ! grep -q "iogpu.wired_limit_mb=14336" /etc/sysctl.conf 2>/dev/null; then
      echo "iogpu.wired_limit_mb=14336" | sudo tee -a /etc/sysctl.conf >/dev/null
    fi
  fi
else
  say "Skipping wired-limit bump (--skip-wired-limit)"
fi

# --- 6. LaunchAgent -------------------------------------------------------

if [[ $SKIP_LA -eq 0 ]]; then
  say "Installing boot-time LaunchAgent"
  if [[ ! -f "$REPO_DIR/scripts/recommended-load.sh" ]]; then
    warn "scripts/recommended-load.sh missing — run scripts/find_parallel.py first to probe your hardware."
    warn "Skipping LaunchAgent install. Re-run this script after probing."
  else
    bash "$REPO_DIR/scripts/install-launchagent.sh"
  fi
else
  say "Skipping LaunchAgent install (--skip-launchagent)"
fi

# --- 7. Start server + load models now -----------------------------------

say "Starting server and loading models now (so you don't have to wait for reboot)"
"$LMS" server start --bind 0.0.0.0 --port 1234 --cors 2>/dev/null || true
if [[ -f "$REPO_DIR/scripts/recommended-load.sh" ]]; then
  bash "$REPO_DIR/scripts/recommended-load.sh" || warn "recommended-load.sh exited non-zero — check 'lms ps'"
fi

# --- 8. Report server URL to share with the client -----------------------

HOSTNAME_LOCAL="$(scutil --get LocalHostName 2>/dev/null).local"
IP_EN0="$(ipconfig getifaddr en0 2>/dev/null || true)"
IP_EN1="$(ipconfig getifaddr en1 2>/dev/null || true)"
IP_FIRST="${IP_EN0:-$IP_EN1}"

cat <<EOF

╔══════════════════════════════════════════════════════════════════╗
║  SERVER READY                                                    ║
╚══════════════════════════════════════════════════════════════════╝

  Primary URL (use this):     http://${HOSTNAME_LOCAL}:1234
  Raw IP fallback:            http://${IP_FIRST:-<no LAN IP>}:1234

  Verify from this Mac:       curl http://${HOSTNAME_LOCAL}:1234/v1/models
  Verify from client laptop:  same URL, must return qwen3-coder-30b-a3b-instruct

  On the client laptop, run:
    git clone <this-repo> && cd claude-local-llm-setup
    bash scripts/client.sh http://${HOSTNAME_LOCAL}:1234

╭──────────────── remaining manual steps (GUI-only) ───────────────╮
│                                                                  │
│ Open LM Studio Settings and toggle these ONCE:                   │
│   · Developer → Model Loading Guardrails = Relaxed               │
│   · General   → Launch LM Studio at login = ON                   │
│   · General   → Keep models loaded in memory = ON                │
│   · General   → JIT models auto-evict = ON (recommended)         │
│                                                                  │
│ Without "Launch at login" + "Keep models loaded", the LaunchAgent│
│ has to cold-start LM Studio and models on every reboot (slower). │
╰──────────────────────────────────────────────────────────────────╯
EOF
