#!/usr/bin/env bash
# cleanup.sh — free up RAM before running the local LLM server on an 18 GB Mac.
#
# What it does (all reversible):
#   1. Snapshot free RAM + swap (before)
#   2. Unload user LaunchAgents listed in 01-server-setup-this-mac.md
#   3. Unload system LaunchDaemons (needs sudo)
#   4. Quit a curated list of background GUI apps
#   5. Trigger `sudo purge` to drop macOS disk cache (optional, --purge)
#   6. Snapshot again (after)
#
# This is a server-mode cleanup. Run it BEFORE loading models.
# NEVER killed by this script (you need them to drive the session):
#   - Claude Code (any flavor), Terminal / iTerm / Warp, the shell itself
#   - Magnet, CopyLess (user keeps these running per 01-doc)
# Their memory footprint is RESERVED headroom and the parallel probe treats it as baseline.
#
# Usage:
#   ./cleanup.sh              # safe cleanup, no sudo prompts needed for basic
#   ./cleanup.sh --purge      # also run sudo purge (prompts for password)
#   ./cleanup.sh --all        # cleanup + daemons + purge (heaviest)
#   ./cleanup.sh --restore    # reverse: reload the unloaded agents (for dev work)
#
# Exit codes: 0 on success; non-zero if a required tool is missing.

set -u
DO_PURGE=0
DO_DAEMONS=0
DO_RESTORE=0

for arg in "$@"; do
  case "$arg" in
    --purge)    DO_PURGE=1 ;;
    --all)      DO_PURGE=1; DO_DAEMONS=1 ;;
    --daemons)  DO_DAEMONS=1 ;;
    --restore)  DO_RESTORE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# ---- user launch agents (no sudo) ----
USER_AGENTS=(
  homebrew.mxcl.mysql.plist
  homebrew.mxcl.redis.plist
  com.github.facebook.watchman.plist
  com.google.GoogleUpdater.wake.plist
  com.google.keystone.agent.plist
  com.google.keystone.xpcservice.plist
  com.grammarly.ProjectLlama.Shepherd.plist
  com.parallels.mobile.startgui.launchagent.plist
  io.podman_desktop.PodmanDesktop.plist
)

# ---- system daemons (sudo) ----
SYS_DAEMONS=(
  com.docker.socket.plist
  com.docker.vmnetd.plist
  com.github.containers.podman.helper-subash.plist
  com.parallels.mobile.audioloader.launchd.plist
  com.parallels.mobile.dispatcher.launchdaemon.plist
  com.nordvpn.macos.helper.plist
  com.teamviewer.Helper.plist
  com.philandro.anydesk.Helper.plist
  com.philandro.anydesk.service.plist
  us.zoom.ZoomDaemon.plist
  com.microsoft.autoupdate.helper.plist
  com.microsoft.OneDriveStandaloneUpdaterDaemon.plist
  com.microsoft.OneDriveUpdaterDaemon.plist
)

# ---- GUI apps to quit (via osascript; no force-kill) ----
QUIT_APPS=( "OneDrive" "Docker" "Docker Desktop" "Parallels Desktop" "Slack" "Discord" "Spotify" "zoom.us" )

# ---- measurement helpers ----
snap() {
  local free_mb=$(vm_stat | awk '/Pages free/ {gsub("\\.",""); print int($3*16384/1048576)}')
  local swap_used=$(sysctl -n vm.swapusage | awk -F'=' '/used/ {print $3}' | awk '{print $1}' | tr -d 'M')
  printf "  free: %5s MB   swap: %7s MB used\n" "$free_mb" "${swap_used:-?}"
}

echo "==> BEFORE"
snap

if [[ $DO_RESTORE -eq 1 ]]; then
  echo "==> restore: reloading user launch agents"
  for p in "${USER_AGENTS[@]}"; do
    [[ -f "$HOME/Library/LaunchAgents/$p" ]] && launchctl load "$HOME/Library/LaunchAgents/$p" 2>/dev/null
  done
  echo "==> AFTER"
  snap
  exit 0
fi

echo "==> unloading user LaunchAgents"
for p in "${USER_AGENTS[@]}"; do
  if [[ -f "$HOME/Library/LaunchAgents/$p" ]]; then
    launchctl unload -w "$HOME/Library/LaunchAgents/$p" 2>/dev/null && echo "  - $p"
  fi
done
# non-standard name with spaces handled separately
[[ -f "$HOME/Library/LaunchAgents/VPN by Google One.plist" ]] && \
  launchctl unload -w "$HOME/Library/LaunchAgents/VPN by Google One.plist" 2>/dev/null && echo "  - VPN by Google One.plist"

if [[ $DO_DAEMONS -eq 1 ]]; then
  echo "==> unloading system LaunchDaemons (sudo)"
  for p in "${SYS_DAEMONS[@]}"; do
    if [[ -f "/Library/LaunchDaemons/$p" ]]; then
      sudo launchctl unload -w "/Library/LaunchDaemons/$p" 2>/dev/null && echo "  - $p"
    fi
  done
fi

echo "==> quitting background GUI apps"
for app in "${QUIT_APPS[@]}"; do
  if osascript -e "application \"$app\" is running" 2>/dev/null | grep -q true; then
    osascript -e "tell application \"$app\" to quit" 2>/dev/null && echo "  - $app"
  fi
done

if [[ $DO_PURGE -eq 1 ]]; then
  echo "==> sudo purge (drops macOS disk cache, may take a few seconds)"
  sudo purge
fi

sleep 2
echo "==> AFTER"
snap

echo
echo "Tip: after your server session ends, run './cleanup.sh --restore' to bring the user agents back."
