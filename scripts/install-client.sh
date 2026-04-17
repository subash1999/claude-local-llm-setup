#!/usr/bin/env bash
# Install the client-side MCP bridge from this repo.
#
# The bridge (mcp-bridge/server.mjs) is a stdio-MCP server that Claude
# Code spawns per session. Claude Code looks for it at a fixed path
# under ~/.claude/mcp-servers/local-llm-bridge/ (per the MCP
# registration). We symlink that path to the repo copy so:
#
#   - `git pull` updates the bridge automatically.
#   - No per-pull `cp` step to forget.
#   - A single source of truth — the repo. No installed-vs-repo drift.
#
# Run once on each client Mac. Re-run is idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_BRIDGE="$REPO_DIR/mcp-bridge/server.mjs"
INSTALL_DIR="$HOME/.claude/mcp-servers/local-llm-bridge"
INSTALL_BRIDGE="$INSTALL_DIR/server.mjs"

if [ ! -f "$REPO_BRIDGE" ]; then
  echo "ERROR: repo bridge not found at $REPO_BRIDGE" >&2
  exit 1
fi

# Node resolves modules using the REAL path of a script, not the symlink
# path. So an installed bridge that is a symlink into this repo looks for
# node_modules in the REPO's mcp-bridge/ dir, not in the installed dir.
# Without this, the bridge crashes on startup with ERR_MODULE_NOT_FOUND
# for '@modelcontextprotocol/sdk'. Install deps at the real path.
if [ ! -d "$REPO_DIR/mcp-bridge/node_modules" ]; then
  echo "Installing bridge deps at $REPO_DIR/mcp-bridge ..."
  (cd "$REPO_DIR/mcp-bridge" && npm install)
fi

mkdir -p "$INSTALL_DIR"

# Replace whatever is there with a symlink to the repo copy.
if [ -L "$INSTALL_BRIDGE" ]; then
  existing_target="$(readlink "$INSTALL_BRIDGE")"
  if [ "$existing_target" = "$REPO_BRIDGE" ]; then
    echo "Already linked: $INSTALL_BRIDGE -> $REPO_BRIDGE"
    exit 0
  fi
  rm "$INSTALL_BRIDGE"
elif [ -e "$INSTALL_BRIDGE" ]; then
  # Backup the old installed copy before replacing it.
  backup="$INSTALL_BRIDGE.pre-symlink.$(date +%s)"
  mv "$INSTALL_BRIDGE" "$backup"
  echo "Backed up previous installed bridge to $backup"
fi

ln -s "$REPO_BRIDGE" "$INSTALL_BRIDGE"
echo "Linked: $INSTALL_BRIDGE -> $REPO_BRIDGE"
echo
echo "Next steps:"
echo "  1. Ensure node_modules are installed in \$HOME/.claude/mcp-servers/local-llm-bridge (already present on existing installs)."
echo "  2. Restart Claude Code (exit + relaunch) so the MCP child process respawns with the symlinked code."
echo "  3. In the new session, run a trivial local_capabilities call to confirm the bridge loaded cleanly."
