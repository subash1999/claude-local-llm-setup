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
- **Settings → Developer → Enable CLI tool (`lms`)**
- **Settings → Launch LM Studio at login** = ON
- **Settings → Keep models loaded in memory** = ON

## Step 2 — Download Qwen3-Coder-30B-A3B (MLX 4-bit)

```bash
# ~15 GB download, takes 5–15 min depending on network
lms get Qwen/Qwen3-Coder-30B-A3B-Instruct @mlx-q4_k_m

# Verify
lms ls | grep -i qwen3-coder
```

If `lms get` can't find the exact tag, use the full MLX community path:
```bash
lms get mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit
```

## Step 3 — Bump GPU wired memory limit

Unified memory default is capped at ~66% for GPU use. Bumping it to ~15 GB gives the model room to stay fully resident.

```bash
# Session only (resets on reboot):
sudo sysctl iogpu.wired_limit_mb=15360

# Persistent — add to /etc/sysctl.conf:
echo "iogpu.wired_limit_mb=15360" | sudo tee -a /etc/sysctl.conf
```

## Step 4 — Start the server bound to LAN

**Important:** default LM Studio server binds to `localhost` only. Must override with `--host 0.0.0.0` to accept connections from the other laptop.

```bash
lms server start --host 0.0.0.0 --port 1234
```

## Step 5 — Load the model

```bash
lms load Qwen/Qwen3-Coder-30B-A3B-Instruct --context-length 32768 --keep-alive forever
```

Context length notes:
- **Start with 32768 (32K)** — safe on 18 GB
- Bump to 65536 if you see no memory pressure under real load
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
    <string>/opt/homebrew/bin/lms server start --host 0.0.0.0 --port 1234 &amp;&amp; /opt/homebrew/bin/lms load Qwen/Qwen3-Coder-30B-A3B-Instruct --context-length 32768 --keep-alive forever</string>
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

Running a 15 GB model on 18 GB requires disciplined RAM. Run this cleanup script once.

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
- Drop context length: `lms load Qwen/Qwen3-Coder-30B-A3B-Instruct --context-length 16384`
- Switch to the fallback model: see `04-fallback-gpt-oss-20b.md`

**Server unreachable from other laptop:**
- Confirm both machines on same Wi-Fi network
- Try hostname: `http://subashs-macbook-pro.local:1234/v1/models`
- Confirm firewall is off: `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`

**Mac gets hot / fan spins:**
- Expected under inference load. Keep it plugged in.
- For overnight use: cap GPU wired memory at 13312 instead of 15360.
