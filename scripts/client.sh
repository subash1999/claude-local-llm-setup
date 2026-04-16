#!/usr/bin/env bash
# client.sh — one-shot client-side setup for claude-local-llm-setup.
#
# Run on the laptop you write code on (the one talking to Claude Code).
# Takes the server URL as the first arg (or prompts for it).
#
#   bash scripts/client.sh http://<server-host-or-ip>:1234
#
# What this does (idempotent — safe to re-run):
#   1. Verifies Claude Code is installed (installs via npm if not)
#   2. Tests reachability to the server URL
#   3. Writes `claude-local` / `claude-home` shell functions to your rc
#   4. Installs the MCP bridge to ~/.claude/mcp-servers/local-llm-bridge/
#   5. Runs `claude mcp add` with the correct env vars
#   6. Copies the skill files to ~/.claude/skills/
#
# What you still do by hand (can't be automated):
#   · claude login  (Max 20x OAuth — browser flow)
#   · (optional) install JuliusBrussee/caveman as a Claude Code skill
#     for the CLIENT SIDE too. The bridge already caveman-compresses
#     everything coming FROM the server; the JuliusBrussee skill
#     compresses prompts going TO the cloud model.

set -euo pipefail

SERVER_URL="${1:-}"
if [[ -z "$SERVER_URL" ]]; then
  read -rp "Server URL (e.g. http://your-mac.local:1234): " SERVER_URL
fi
SERVER_URL="${SERVER_URL%/}"  # strip trailing slash

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- 1. Claude Code ------------------------------------------------------

if ! command -v claude >/dev/null; then
  command -v npm >/dev/null || die "npm not found. Install Node.js 18+ first (e.g. brew install node)."
  say "Installing Claude Code"
  npm install -g @anthropic-ai/claude-code
else
  say "Claude Code already installed ($(claude --version 2>/dev/null || echo 'version unknown'))"
fi

# --- 2. Server reachability ---------------------------------------------

say "Testing server reachability at $SERVER_URL"
if ! curl -fsS -m 5 "$SERVER_URL/v1/models" >/tmp/models.json 2>/dev/null; then
  warn "Could not reach $SERVER_URL/v1/models. Continuing anyway — you can fix this later."
  warn "  - On the server Mac, verify:  lms status  (Server should be ON)"
  warn "  - Confirm same Wi-Fi and firewall is off on the server."
else
  count=$(grep -o '"id"' /tmp/models.json | wc -l | tr -d ' ')
  say "Server reachable — $count model(s) listed"
fi

# --- 3. Shell functions -------------------------------------------------

RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"
[[ -n "${BASH_VERSION:-}" ]] && RC_FILE="$HOME/.bashrc"
[[ "$SHELL" == *zsh* ]] && RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"

BLOCK_START="# === claude-local-llm-setup (managed) ==="
BLOCK_END="# === /claude-local-llm-setup ==="
MODEL_ENV="${LOCAL_HEAVY_MODEL:-qwen3-coder-30b-a3b-instruct}"

if grep -qF "$BLOCK_START" "$RC_FILE" 2>/dev/null; then
  say "Shell block already present in $RC_FILE — leaving as-is (edit by hand if server URL changed)"
else
  say "Appending shell functions to $RC_FILE"
  cat >> "$RC_FILE" <<EOF

$BLOCK_START
# Server URL — override by exporting HOME_LLM_URL before calling claude-local.
: \${HOME_LLM_URL:="$SERVER_URL"}

claude-local() {
  ANTHROPIC_BASE_URL="\$HOME_LLM_URL" \\
  ANTHROPIC_AUTH_TOKEN="lmstudio" \\
  ANTHROPIC_MODEL="$MODEL_ENV" \\
  CLAUDE_CODE_DISABLE_ATTRIBUTION=1 \\
  command claude "\$@"
}
alias claude-home='claude-local'

claude-home-check() {
  curl -s -m 3 "\$HOME_LLM_URL/v1/models" >/dev/null \\
    && echo "✓ home server up (\$HOME_LLM_URL)" \\
    || echo "✗ home server unreachable at \$HOME_LLM_URL"
}
$BLOCK_END
EOF
fi

# --- 4. MCP bridge install ----------------------------------------------

BRIDGE_DIR="$HOME/.claude/mcp-servers/local-llm-bridge"
mkdir -p "$BRIDGE_DIR"
cp "$REPO_DIR/mcp-bridge/server.mjs"    "$BRIDGE_DIR/server.mjs"
cp "$REPO_DIR/mcp-bridge/package.json"  "$BRIDGE_DIR/package.json"
chmod +x "$BRIDGE_DIR/server.mjs"

say "Installing bridge npm dependencies"
(cd "$BRIDGE_DIR" && npm install --silent --no-fund --no-audit)

# --- 5. Register MCP server ---------------------------------------------

BRIDGE_URL="$SERVER_URL/v1/chat/completions"

if claude mcp list 2>/dev/null | grep -q '^local-llm-bridge'; then
  say "MCP server 'local-llm-bridge' already registered — removing + re-adding with latest env"
  claude mcp remove local-llm-bridge --scope user 2>/dev/null || true
fi

say "Registering MCP server with Claude Code"
claude mcp add local-llm-bridge \
  --command node \
  --args "$BRIDGE_DIR/server.mjs" \
  --scope user \
  --env "LOCAL_LLM_URL=$BRIDGE_URL" \
  --env "LOCAL_LLM_MODEL=${LOCAL_HEAVY_MODEL:-qwen3-coder-30b-a3b-instruct}" \
  --env "CAVEMAN_MODE=${CAVEMAN_MODE:-on}"

# --- 6. Install skills --------------------------------------------------

SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"
cp "$REPO_DIR/mcp-bridge/skills/"*.md "$SKILLS_DIR/"
say "Installed $(ls "$REPO_DIR/mcp-bridge/skills/" | wc -l | tr -d ' ') skill files to $SKILLS_DIR"

# --- 6b. Routing policy in ~/.claude/CLAUDE.md --------------------------
# This is the real "prefer local first" policy. Skills alone are hints;
# this is a standing instruction Claude reads every session.

CLAUDE_MD="$HOME/.claude/CLAUDE.md"
POLICY_START="<!-- claude-local-llm-setup:routing-policy START -->"
POLICY_END="<!-- claude-local-llm-setup:routing-policy END -->"
POLICY_BODY="$(cat "$REPO_DIR/mcp-bridge/CLAUDE-routing-policy.md")"

mkdir -p "$(dirname "$CLAUDE_MD")"
touch "$CLAUDE_MD"

if grep -qF "$POLICY_START" "$CLAUDE_MD"; then
  say "Routing policy already in $CLAUDE_MD — refreshing the managed block"
  # Replace the existing managed block in-place
  python3 - "$CLAUDE_MD" "$POLICY_START" "$POLICY_END" "$POLICY_BODY" <<'PY'
import sys, pathlib
p, start, end, body = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
t = pathlib.Path(p).read_text()
i = t.index(start); j = t.index(end) + len(end)
new = t[:i] + start + "\n" + body + "\n" + end + t[j:]
pathlib.Path(p).write_text(new)
PY
else
  say "Appending routing policy to $CLAUDE_MD"
  {
    printf '\n%s\n' "$POLICY_START"
    printf '%s\n' "$POLICY_BODY"
    printf '%s\n' "$POLICY_END"
  } >> "$CLAUDE_MD"
fi

# --- 7. Report ----------------------------------------------------------

cat <<EOF

╔══════════════════════════════════════════════════════════════════╗
║  CLIENT READY                                                    ║
╚══════════════════════════════════════════════════════════════════╝

  Server URL:      $SERVER_URL
  Shell block:     $RC_FILE
  MCP bridge:      $BRIDGE_DIR
  Skills dir:      $SKILLS_DIR

  Reload your shell:
    source $RC_FILE

  Verify MCP tools are registered:
    claude mcp list

  Try it:
    claude
      > Call local_capabilities and show me what local tools you have.
      > Then audit $REPO_DIR/README.md for broken links.

  Whole-session local mode (zero cloud quota):
    claude-local

╭───────────────── remaining manual steps ─────────────────╮
│                                                          │
│  1. If this is a fresh install, finish Claude login:     │
│       claude login                                       │
│     (OAuth browser flow — uses your Max 20x sub)         │
│                                                          │
│  2. (Optional) Install JuliusBrussee/caveman as a skill  │
│     to compress YOUR prompts going TO cloud Claude too:  │
│       git clone https://github.com/JuliusBrussee/caveman \\│
│         ~/.claude/skills/caveman                         │
│     (The bridge already compresses replies FROM the      │
│     local server; that's independent.)                   │
│                                                          │
╰──────────────────────────────────────────────────────────╯
EOF
