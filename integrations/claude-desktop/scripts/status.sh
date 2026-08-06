#!/bin/bash
set -euo pipefail

BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CLAUDE_INSTALL_ROOT:-$BASE_ROOT/Claude Desktop}"
STATE_DIR="${TOKEN_METER_CLAUDE_STATE_DIR:-$BASE_ROOT/State/Claude Desktop}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LABEL="com.sergiochan.token-meter.claude-desktop"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"
EXECUTABLE="$INSTALL_ROOT/Token Meter for Claude.app/Contents/MacOS/TokenMeterClaudeOverlay"
JSON=false

case "${1:-}" in
  --json)
    JSON=true
    ;;
  --help|-h)
    printf 'Usage: status.sh [--json]\n'
    exit 0
    ;;
  '')
    ;;
  *)
    printf 'Unknown argument: %s\n' "$1" >&2
    exit 2
    ;;
esac

INSTALLED=false
PLIST_INSTALLED=false
LOADED=false
RUNNING=false
ACCESSIBILITY=false
STATE_PRESENT=false
[ -x "$EXECUTABLE" ] && INSTALLED=true
[ -f "$PLIST" ] && PLIST_INSTALLED=true
[ -d "$STATE_DIR" ] && STATE_PRESENT=true
if LAUNCH_STATUS="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null)"; then
  LOADED=true
  if printf '%s\n' "$LAUNCH_STATUS" | /usr/bin/grep -q 'state = running'; then
    RUNNING=true
  fi
fi
if [ "$INSTALLED" = true ] && "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
  ACCESSIBILITY=true
fi

if [ "$JSON" = true ]; then
  printf '{"installed":%s,"launchAgentInstalled":%s,"launchAgentLoaded":%s,"running":%s,"accessibilityGranted":%s,"statePresent":%s,"claudeRestartRequired":false}\n' \
    "$INSTALLED" \
    "$PLIST_INSTALLED" \
    "$LOADED" \
    "$RUNNING" \
    "$ACCESSIBILITY" \
    "$STATE_PRESENT"
  exit 0
fi

printf 'Installed: %s\n' "$INSTALLED"
printf 'LaunchAgent installed: %s\n' "$PLIST_INSTALLED"
printf 'LaunchAgent loaded: %s\n' "$LOADED"
printf 'Overlay running: %s\n' "$RUNNING"
printf 'Accessibility permission: %s\n' "$ACCESSIBILITY"
printf 'Claude restart required: false\n'
