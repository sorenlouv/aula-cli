#!/usr/bin/env bash
#
# Installs the launchd agent that generates the Aula AI oversigt each weekday
# morning.
#
# launchd, not a Claude scheduled task, because this has to run whether or not
# any app is open — and it needs the credentials in ~/.aula, which only exist on
# this machine.
#
# Idempotent: re-running replaces the agent.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.aula-cli.brief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN="$(command -v bun)"
# The brief's model calls run `claude`, which launchd's bare PATH may not
# reach — resolve its directory now and bake it into the agent's PATH.
CLAUDE_DIR="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"
LOG_DIR="$HOME/.aula/brief"

HOUR="${BRIEF_HOUR:-6}"
MINUTE="${BRIEF_MINUTE:-30}"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# launchd starts with a bare environment, so every tool this needs has to be on
# an explicit PATH: bun to run the CLI, claude for the model calls, and Chrome
# is invoked by absolute path from publish.ts.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>$REPO/src/cli.ts</string>
    <string>brief</string>
    <string>--text</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$CLAUDE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/launchd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL — weekdays at $(printf '%02d:%02d' "$HOUR" "$MINUTE")."
echo "  plist:  $PLIST"
echo "  log:    $LOG_DIR/launchd.log"
echo "  run now:    launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  uninstall:  launchctl bootout gui/$(id -u)/$LABEL && rm $PLIST"
