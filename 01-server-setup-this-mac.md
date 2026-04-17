# Server Setup — This MacBook Pro (M3 Pro 18 GB)

## Prerequisites (already confirmed Apr 15, 2026)

- macOS 26.3.1
- Python 3.13.5, pip, Homebrew installed
- 278 GB free disk
- LAN IP: resolved via `ipconfig getifaddr en0` (mine happened to be `192.168.1.21`)
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

## Step 2 — Download Qwen2.5-Coder-7B-Instruct (MLX 4-bit)

**Why 3-bit, not 4-bit?** Measured sizes on Apr 15, 2026:
- MLX 4-bit = **16.0 GB** weights → won't fit 18 GB Mac with any meaningful KV cache
- MLX 3-bit = **12.4 GB** weights → fits with ~5 GB headroom for 32K context + OS

For MoE models with only 3.3 B active params, 3-bit quality loss is minor (unlike dense models). This is the right pick for 18 GB Apple Silicon.

```bash
# ~13.4 GB download (weights + tokenizer), 5–15 min depending on network.
# lms get resolves HuggingFace URLs directly:
lms get "https://huggingface.co/mlx-community/Qwen2.5-Coder-7B-Instruct-4bit" -y

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

## Step 5 — Load HEAVY

Load HEAVY with an **explicit** context length and a **long TTL** so LM
Studio cannot silently reload it at a smaller default window:

```bash
lms load qwen2.5-coder-7b-instruct \
  --context-length 32768 \
  --gpu max \
  --parallel 2 \
  --ttl 2592000 \
  -y
```

**Also set the per-model GUI default to match:** LM Studio → **My
Models** → ⚙️ next to `Qwen2.5-Coder-7B-Instruct-4bit` → **Context
and Offload** → **32768**. This covers JIT auto-loads that bypass the
CLI (e.g. `/v1/chat/completions` requests that hit the model before
`recommended-load.sh` has run). Do the same for
`Qwen2.5-Coder-14B-Instruct-4bit`.

**Why these numbers (updated 2026-04-18 after capability-map bench — see
`bench/report/BUGFIX-HANDOFF.md` BUG 1):**

- `parallel=2` — matches Claude's typical concurrent tool-call burst.
- `ctx=32768` — the model's **native trained** context. LM Studio's
  model panel advertises "Model supports up to 32768 tokens" for both
  7 B and 14 B 4-bit. Going higher (40 960+) requires RoPE
  extrapolation, which trades quality for headroom on positional
  encodings the model never saw during training. Leg B saw 38 038
  accepted at a 131 072 load (i.e. with aggressive RoPE scaling) —
  fine in theory, but not worth the quality hit for the 5 K of extra
  headroom. Sticking to native keeps behavior predictable. **Do NOT
  use 131 072 on 18 GB**: memory pressure from a parallel 14 B load
  causes LM Studio to quietly re-open 7 B at its default 4 K window;
  subsequent requests die with `HTTP 400 — greater than context
  length`. Pinning at native + explicit at load time prevents this.
- `ttl=2592000` (30 days) — `lms load` has no "never unload" sentinel;
  only `--ttl <seconds>`. The lms default of 1 h lets the model evict
  during idle gaps, and reloads trigger the same silent-ctx-drop
  pathology. 30 days is effectively "keep loaded" for any normal work
  session.

Resident after warmup: ~4.3 GB weights + ~1 GB KV cache ≈ ~5 GB used.
~9 GB free for the 14 B deep-audit companion or other headroom.

Verify:
```bash
lms ps
# qwen2.5-coder-7b-instruct   CONTEXT=32768   PARALLEL=2   TTL=720h
```

> **If you ever need >32 K context** — do not bump blindly. Re-run Leg B
> (`node bench/harness/leg-b-ctx-ceiling.mjs`) at the candidate value
> and confirm stability across ≥ 3 back-to-back runs. Consider the
> quality trade-off of RoPE extrapolation before promoting. In
> practice, escalate to cloud for prompts >32 K rather than stretch
> the local model.

### Re-measuring on different hardware

If you migrate to another Mac (different RAM, different macOS version) or add/remove background apps, re-run the probe:

```bash
# Unload cleanly first
lms unload --all
# Full ladder (~9 combos):
python3 scripts/find_parallel.py
# Quick (3 combos):
python3 scripts/find_parallel.py --quick
# Force a specific context:
python3 scripts/find_parallel.py --heavy-ctx 16384
```

The probe writes `scripts/recommended-load.sh` with the exact `lms load` command that fits your machine.

## Step 6 — Verify reachability from the other laptop

From the **other laptop**:
```bash
curl http://$(scutil --get LocalHostName).local:1234/v1/models
# Should return JSON with qwen2.5-coder-7b-instruct.
# The hostname resolves via Bonjour/mDNS so router DHCP changes don't break you.
# Fallback if mDNS fails (VPN, guest networks): curl http://$(ipconfig getifaddr en0):1234/v1/models
```

If that fails, troubleshoot on server:
```bash
lsof -iTCP:1234 -sTCP:LISTEN   # confirm LM Studio is listening
ifconfig en0 | grep inet        # confirm IP didn't change
```

## Step 7 — Auto-start on login (one command)

LM Studio's "Launch at login" + "Keep models loaded" auto-starts the GUI, but the server doesn't bind to `0.0.0.0` and our custom `parallel=2` flags aren't preserved. The installer below wires up a LaunchAgent that fixes both.

```bash
bash scripts/install-launchagent.sh
```

What it does:
1. Copies `scripts/boot-start.sh` and `scripts/recommended-load.sh` to `~/Library/Application Support/claude-local-llm-server/` (scripts inside `~/Documents` are blocked from launchd by macOS TCC — "Operation not permitted" — so they must live elsewhere).
2. Writes `~/Library/LaunchAgents/com.subash.lmstudio-server.plist` pointing at the copied `boot-start.sh`.
3. `launchctl load`s it (fires once now too).

At every login, the LaunchAgent will:
- Self-open LM Studio (`open -ga "LM Studio"`) so you don't depend on the GUI's "Launch at login" toggle
- Wait up to 60s for LM Studio's `lms` backend to be ready
- Start the server bound to `0.0.0.0:1234` with CORS
- Unload any stale models and reload HEAVY with the measured-optimal `--parallel 2` flags

Verify it's registered:
```bash
launchctl list | grep lmstudio-server
# Should show: <PID> 0 com.subash.lmstudio-server  (0 = last exit clean)
```

Test without rebooting:
```bash
launchctl kickstart -k gui/$(id -u)/com.subash.lmstudio-server
sleep 25 && lms ps
# HEAVY should appear with CONTEXT=32768 PARALLEL=2 TTL=720h.
```

Logs: `/tmp/lmstudio-server.log` (stdout) and `/tmp/lmstudio-server.err` (stderr).

> **Re-running the probe:** If you edit `scripts/find_parallel.py` for different thresholds or swap models, the probe regenerates `scripts/recommended-load.sh` in place. Re-run `bash scripts/install-launchagent.sh` to push the new config into the Application Support location and reload the agent.

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
- Drop context length: `lms load qwen2.5-coder-7b-instruct --context-length 16384 --ttl 2592000`
- Switch to the fallback model: see `04-fallback-gpt-oss-20b.md`

**`HTTP 400 — greater than context length` mid-session:**
- Means LM Studio reloaded the model at a smaller default context window
  (e.g. under memory pressure from loading a second model). Symptoms:
  `lms ps` shows `CONTEXT=4096` when you set 40960 earlier.
- Fix: re-run Step 5's `lms load` command (explicit `--context-length`
  and `--ttl 2592000`). The bridge-side retry-once path in
  `mcp-bridge/server.mjs` will mask a single occurrence, but repeated
  400s mean the pinned TTL / ctx is not being honored — verify with
  `lms ps`.

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
