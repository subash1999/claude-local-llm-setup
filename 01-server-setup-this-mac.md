# Server Setup — This MacBook Pro (M3 Pro 18 GB)

## Prerequisites (already confirmed Apr 15, 2026)

- macOS 26.3.1
- Python 3.13.5, pip, Homebrew installed
- 278 GB free disk
- LAN IP: `192.168.1.21` (en0)
- Firewall: disabled (no config needed for LAN access)

## Step 1 — Install LM Studio

```bash
brew install --cask lm-studio
open -a "LM Studio"
# Click through the first-run welcome dialog once
```

After first launch, enable in LM Studio preferences:
- **Settings → Developer → Enable CLI tool (`lms`)** — if the button is missing, run `~/.lmstudio/bin/lms bootstrap` from the terminal instead
- **Settings → Developer → Model Loading Guardrails** = **Relaxed** (default "Balanced" rejects loads above its pessimistic estimate; with 18 GB and 12.4 GB weights you need "Relaxed" or "Off")
- **Settings → Launch LM Studio at login** = ON
- **Settings → Keep models loaded in memory** = ON
- **Settings → JIT models auto-evict** = ON (recommended — unloads previous model if you switch)

## Step 2 — Download Qwen3-Coder-30B-A3B (MLX 3-bit)

**Why 3-bit, not 4-bit?** Measured sizes on Apr 15, 2026:
- MLX 4-bit = **16.0 GB** weights → won't fit 18 GB Mac with any meaningful KV cache
- MLX 3-bit = **12.4 GB** weights → fits with ~5 GB headroom for 32K context + OS

For MoE models with only 3.3 B active params, 3-bit quality loss is minor (unlike dense models). This is the right pick for 18 GB Apple Silicon.

```bash
# ~13.4 GB download (weights + tokenizer), 5–15 min depending on network.
# lms get resolves HuggingFace URLs directly:
lms get "https://huggingface.co/mlx-community/Qwen3-Coder-30B-A3B-Instruct-3bit" -y

# Verify
lms ls | grep -i qwen3-coder
```

> Note: `lms get` with a short slug like `mlx-community/...` fails against the LM Studio hub catalog — the hub only indexes staff-picked repos. Full HuggingFace URLs work for any public model.

## Step 3 — Bump GPU wired memory limit

Unified memory default is capped at ~66% for GPU use. Bumping it to ~14 GB gives the 12.4 GB model room to stay fully resident with KV cache.

```bash
# Session only (resets on reboot):
sudo sysctl iogpu.wired_limit_mb=14336

# Persistent — add to /etc/sysctl.conf:
echo "iogpu.wired_limit_mb=14336" | sudo tee -a /etc/sysctl.conf
```

## Step 4 — Start the server bound to LAN

**Important:** default LM Studio server binds to `localhost` only. Must override with `--host 0.0.0.0` to accept connections from the other laptop.

```bash
lms server start --bind 0.0.0.0 --port 1234 --cors
```

## Step 5 — Load the model

```bash
# Use the slug LM Studio assigned — `lms ls` shows it (usually "qwen3-coder-30b-a3b-instruct")
lms load qwen3-coder-30b-a3b-instruct --context-length 32768 --gpu max -y
```

Context length notes:
- **Start with 32768 (32K)** — fits comfortably with 12.4 GB weights on 18 GB
- Bump to 65536 only if `memory_pressure` stays green under real load
- Don't exceed 65536; KV cache will push you into swap

Verify it's loaded:
```bash
lms ps
```

## Step 6 — Verify reachability from the other laptop

From the **other laptop**:
```bash
curl http://192.168.1.21:1234/v1/models
# Should return JSON with Qwen3-Coder listed
```

If that fails, troubleshoot on server:
```bash
lsof -iTCP:1234 -sTCP:LISTEN   # confirm LM Studio is listening
ifconfig en0 | grep inet        # confirm IP didn't change
```

## Step 7 — Auto-start on login (optional but recommended)

LM Studio's "Launch at login" + "Keep models loaded" already handles most of this, but for a fully automated server, create a LaunchAgent:

```bash
cat > ~/Library/LaunchAgents/com.subash.lmstudio-server.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.subash.lmstudio-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>/Users/subash/.lmstudio/bin/lms server start --bind 0.0.0.0 --port 1234 --cors &amp;&amp; /Users/subash/.lmstudio/bin/lms load qwen3-coder-30b-a3b-instruct --context-length 32768 --gpu max -y</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lmstudio-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/lmstudio-server.err</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.subash.lmstudio-server.plist
```

## Step 8 — Free up RAM on this Mac (critical on 18 GB)

Running a 12.4 GB model + KV cache on 18 GB requires disciplined RAM. Run this cleanup script once.

Keep: **Magnet, CopyLess**. Disable everything else that's background-only.

### User LaunchAgents — unload without sudo
```bash
for plist in \
  homebrew.mxcl.mysql.plist \
  homebrew.mxcl.redis.plist \
  com.github.facebook.watchman.plist \
  com.google.GoogleUpdater.wake.plist \
  com.google.keystone.agent.plist \
  com.google.keystone.xpcservice.plist \
  com.grammarly.ProjectLlama.Shepherd.plist \
  com.parallels.mobile.startgui.launchagent.plist \
  io.podman_desktop.PodmanDesktop.plist; do
  launchctl unload -w ~/Library/LaunchAgents/$plist 2>/dev/null
done
launchctl unload -w "~/Library/LaunchAgents/VPN by Google One.plist" 2>/dev/null
```

### System LaunchDaemons — requires sudo
```bash
for plist in \
  com.docker.socket.plist \
  com.docker.vmnetd.plist \
  com.github.containers.podman.helper-subash.plist \
  com.parallels.mobile.audioloader.launchd.plist \
  com.parallels.mobile.dispatcher.launchdaemon.plist \
  com.nordvpn.macos.helper.plist \
  com.teamviewer.Helper.plist \
  com.philandro.anydesk.Helper.plist \
  com.philandro.anydesk.service.plist \
  us.zoom.ZoomDaemon.plist \
  com.microsoft.autoupdate.helper.plist \
  com.microsoft.OneDriveStandaloneUpdaterDaemon.plist \
  com.microsoft.OneDriveUpdaterDaemon.plist; do
  sudo launchctl unload -w /Library/LaunchDaemons/$plist 2>/dev/null
done
```

### Quit running GUI apps not needed
```bash
osascript -e 'quit app "OneDrive"'
# Also close Terminal windows you don't need, browsers, IDEs
```

### macOS settings to flip
- System Settings → **Spotlight** → uncheck every category (stops `corespotlightd`, `mds_stores`)
- System Settings → **Battery / Energy** → "Prevent automatic sleeping when display is off" = ON
- System Settings → **General → Software Update → Automatic Updates** = OFF (prevents mid-day reboots)
- System Settings → **iCloud** → turn off Photos/Drive/Desktop sync if not needed
- System Settings → **General → Sharing** → turn off Handoff/AirDrop

## Step 9 — Verify memory headroom after cleanup

```bash
memory_pressure    # should show "Green"
vm_stat | head     # Pages free should be > 30000 pages (~500 MB min)
```

## Troubleshooting

**Model fails to load / crashes:**
- Drop context length: `lms load qwen3-coder-30b-a3b-instruct --context-length 16384`
- Switch to the fallback model: see `04-fallback-gpt-oss-20b.md`

**Server unreachable from other laptop:**
- Confirm both machines on same Wi-Fi network
- Try hostname: `http://subashs-macbook-pro.local:1234/v1/models`
- Confirm firewall is off: `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`

**Mac gets hot / fan spins:**
- Expected under inference load. Keep it plugged in.
- For overnight use: cap GPU wired memory at 13312 instead of 14336.

**`lms: command not found` after installing LM Studio:**
- LM Studio's "Enable CLI tool" button sometimes is missing in Developer settings.
- Fix: run `~/.lmstudio/bin/lms bootstrap` — adds `lms` to `~/.zshrc`, `~/.bashrc`, etc.
- New shell, or `source ~/.zshrc`, picks it up.
