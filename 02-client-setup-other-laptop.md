# Client Setup — Other Laptop (Claude Code)

This assumes the other laptop is a Mac or Linux machine with Homebrew or npm available. Adjust for Windows if needed.

## Prerequisites

- Node.js ≥ 18 (for Claude Code npm install)
- On same LAN/Wi-Fi as the server Mac (`192.168.1.21`)
- Claude Max 20x subscription active (already logged in via `claude login`)

## Step 1 — Install Claude Code (if not already)

```bash
# macOS / Linux:
npm install -g @anthropic-ai/claude-code

# Verify subscription login:
claude --version
claude          # If prompted, run 'claude login' and OAuth-auth with Max account
```

## Step 2 — Verify the home server is reachable

```bash
curl http://192.168.1.21:1234/v1/models
# Expected: JSON with qwen3-coder-30b-a3b-instruct in the data array
```

If the Mac's IP changes on your router, use the hostname instead: `http://subashs-macbook-pro.local:1234/v1/models`.

## Step 3 — Add the two-mode toggle to your shell

Append to `~/.zshrc` (or `~/.bashrc` on Linux):

```bash
cat >> ~/.zshrc <<'EOF'

# =========================================================================
# Claude Code modes
#
#   claude          → cloud mode via Max 20x subscription (default)
#   claude-local    → local mode via home Mac (Qwen3-Coder-30B-A3B)
#   claude-home     → alias for claude-local
# =========================================================================

# Local mode — routes Claude Code to the home Mac's LM Studio server
claude-local() {
  ANTHROPIC_BASE_URL="http://192.168.1.21:1234" \
  ANTHROPIC_AUTH_TOKEN="lmstudio" \
  ANTHROPIC_MODEL="qwen3-coder-30b-a3b-instruct" \
  CLAUDE_CODE_DISABLE_ATTRIBUTION=1 \
  command claude "$@"
}
alias claude-home='claude-local'

# Use hostname if IP changes frequently on your router:
claude-local-host() {
  ANTHROPIC_BASE_URL="http://subashs-macbook-pro.local:1234" \
  ANTHROPIC_AUTH_TOKEN="lmstudio" \
  ANTHROPIC_MODEL="qwen3-coder-30b-a3b-instruct" \
  CLAUDE_CODE_DISABLE_ATTRIBUTION=1 \
  command claude "$@"
}

# Quick health check for the home server
claude-home-check() {
  curl -s -m 3 http://192.168.1.21:1234/v1/models >/dev/null \
    && echo "✓ home server up" \
    || echo "✗ home server unreachable"
}
EOF

source ~/.zshrc
```

## Step 4 — Sanity check both modes

```bash
# Cloud (Max 20x — uses subscription):
claude --print "say hello"

# Local (home Mac — uses Qwen3-Coder):
claude-local --print "say hello"

# Confirm local actually routed locally (not to Anthropic):
claude-local --print "what model are you?"    # Should mention Qwen
```

## Step 5 — Daily workflow

```bash
# Open a project
cd ~/code/some-project

# Heavy thinking / multi-file refactor → use cloud Claude
claude

# Routine work, bulk reads, iterative code generation → use local
claude-local
```

Everything else about Claude Code (slash commands, agents, tools) works identically in both modes. **The only difference is which model is answering.**

## Step 6 — File sharing (optional — only if you want to edit on server Mac too)

By default, Claude Code runs on the **client laptop** and reads/writes files **on the client laptop**. It just sends prompts to the Mac for model inference. Files never leave the client.

If you also want the two machines to share a working directory (so you can switch between the client laptop and the server Mac for editing), pick one:

### Option A — Syncthing (recommended: bidirectional, continuous, LAN-only)
```bash
# On both machines:
brew install syncthing
brew services start syncthing
# Open http://localhost:8384 on each, pair devices, share ~/code
```

### Option B — Git (simplest, versioned)
```bash
# Clone same repo on both machines. Commit/pull to sync.
```

### Option C — SSHFS mount (client mounts server's filesystem)
```bash
# Install once on client:
brew install macfuse sshfs
mkdir -p ~/mac-server
sshfs subash@192.168.1.21:/Users/subash/Documents/CODING-SHARED ~/mac-server \
  -o reconnect,defer_permissions,auto_cache
```

**Recommended:** Syncthing. Git for project work. Skip sharing entirely if Claude Code on the client is all you need.

## Troubleshooting

### `claude-local` hangs or returns "connection refused"
```bash
claude-home-check
# If unreachable: SSH to the server Mac and restart LM Studio:
#   lms server stop && lms server start --host 0.0.0.0 --port 1234
```

### Local responses are slow
- Check on the server Mac: `memory_pressure` — if "Critical", reduce context length
- Only one request at a time is optimal; parallel requests on 18 GB will thrash

### `claude-local` uses wrong model
Check env vars are set inside the function:
```bash
typeset -f claude-local
```
If `ANTHROPIC_MODEL` isn't there, reload shell: `source ~/.zshrc`.

### `CLAUDE_CODE_DISABLE_ATTRIBUTION=1` — what is this?
There's a known Claude Code bug where its attribution header invalidates the KV cache on every turn with local models, causing ~90% slowdown. This env var disables that header. Harmless in cloud mode, essential in local mode.

### Want to see which mode is active in prompt?
```bash
# Add to ~/.zshrc after the functions:
precmd() {
  if [[ -n "$ANTHROPIC_BASE_URL" ]]; then
    PS1="[local] %1~ %# "
  fi
}
```
