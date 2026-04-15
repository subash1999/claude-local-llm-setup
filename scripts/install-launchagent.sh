#!/usr/bin/env bash
# One-shot installer for the LM Studio boot-time auto-start LaunchAgent.
#
# Why this script exists: scripts inside ~/Documents are blocked from
# launchd by macOS TCC (Operation not permitted). We copy the boot
# scripts to ~/Library/Application Support/claude-local-llm-server/
# — that location isn't TCC-protected — and point the plist there.
#
# Re-run this script any time scripts/recommended-load.sh changes
# (e.g. after re-running find_parallel.py on different hardware).

set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/claude-local-llm-server"
PLIST="$HOME/Library/LaunchAgents/com.subash.lmstudio-server.plist"
LABEL="com.subash.lmstudio-server"

mkdir -p "$DEST"
cp "$REPO_DIR/scripts/boot-start.sh"        "$DEST/boot-start.sh"
cp "$REPO_DIR/scripts/recommended-load.sh"  "$DEST/recommended-load.sh"
chmod +x "$DEST/boot-start.sh" "$DEST/recommended-load.sh"

# Rewrite boot-start.sh so it calls recommended-load.sh next to itself,
# not the repo copy (repo is under ~/Documents = TCC-blocked at boot).
cat > "$DEST/boot-start.sh" <<'EOS'
#!/usr/bin/env bash
# Auto-installed by scripts/install-launchagent.sh. Do not edit here —
# edit the copy in the repo and re-run install-launchagent.sh.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LMS=~/.lmstudio/bin/lms
LOG=/tmp/lmstudio-server.log

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

log "boot-start.sh fired; HERE=$HERE"
for i in $(seq 1 30); do
  if "$LMS" status >/dev/null 2>&1; then
    log "lms backend ready (attempt $i)"
    break
  fi
  [ "$i" = 30 ] && { log "lms backend never came up after 60s"; exit 1; }
  sleep 2
done

bash "$HERE/recommended-load.sh" >> "$LOG" 2>&1
rc=$?
log "recommended-load.sh exited rc=$rc"
exit $rc
EOS
chmod +x "$DEST/boot-start.sh"

cat > "$PLIST" <<EOS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/boot-start.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/lmstudio-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/lmstudio-server.err</string>
</dict>
</plist>
EOS

# Reload (safe if not already loaded)
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load   "$PLIST"

echo "Installed:"
echo "  $DEST/boot-start.sh"
echo "  $DEST/recommended-load.sh"
echo "  $PLIST"
echo
echo "Trigger now (or just reboot) with:"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
