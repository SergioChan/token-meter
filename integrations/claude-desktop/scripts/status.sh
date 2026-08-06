#!/bin/bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
# shellcheck source=./process-identity.sh
source "$SCRIPT_ROOT/integrations/claude-desktop/scripts/process-identity.sh"

BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CLAUDE_INSTALL_ROOT:-$BASE_ROOT/Claude Desktop}"
STATE_DIR="${TOKEN_METER_CLAUDE_STATE_DIR:-$BASE_ROOT/State/Claude Desktop}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LABEL="com.sergiochan.token-meter.claude-desktop"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"
EXECUTABLE="$INSTALL_ROOT/Token Meter for Claude.app/Contents/MacOS/TokenMeterClaudeOverlay"
HEALTH_FILE="$STATE_DIR/health.json"
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
OVERLAY_READY=false
BRIDGE_HEALTHY=false
SESSION_BOUND=false
STATE_PRESENT=false
[ -x "$EXECUTABLE" ] && INSTALLED=true
[ -f "$PLIST" ] && PLIST_INSTALLED=true
[ -d "$STATE_DIR" ] && STATE_PRESENT=true
if LAUNCH_STATUS="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null)"; then
  LOADED=true
fi
if [ "$LOADED" = true ] && [ -s "$HEALTH_FILE" ]; then
  READY_PID="$(/usr/bin/plutil -extract pid raw -o - "$HEALTH_FILE" 2>/dev/null || true)"
  case "$READY_PID" in
    ''|*[!0-9]*)
      ;;
    *)
      if token_meter_process_matches_executable "$READY_PID" "$EXECUTABLE"; then
        RUNNING=true
      fi
      ;;
  esac
fi
if [ "$RUNNING" = true ] && "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
  ACCESSIBILITY=true
fi
if [ "$RUNNING" = true ]; then
  [ "$(/usr/bin/plutil -extract overlayReady raw -o - "$HEALTH_FILE" 2>/dev/null || true)" = true ] && OVERLAY_READY=true
  [ "$(/usr/bin/plutil -extract bridgeHealthy raw -o - "$HEALTH_FILE" 2>/dev/null || true)" = true ] && BRIDGE_HEALTHY=true
  [ "$(/usr/bin/plutil -extract sessionBound raw -o - "$HEALTH_FILE" 2>/dev/null || true)" = true ] && SESSION_BOUND=true
fi

if [ "$JSON" = true ]; then
  printf '{"installed":%s,"launchAgentInstalled":%s,"launchAgentLoaded":%s,"running":%s,"accessibilityGranted":%s,"overlayReady":%s,"bridgeHealthy":%s,"sessionBound":%s,"statePresent":%s,"claudeRestartRequired":false}\n' \
    "$INSTALLED" \
    "$PLIST_INSTALLED" \
    "$LOADED" \
    "$RUNNING" \
    "$ACCESSIBILITY" \
    "$OVERLAY_READY" \
    "$BRIDGE_HEALTHY" \
    "$SESSION_BOUND" \
    "$STATE_PRESENT"
  exit 0
fi

printf 'Installed: %s\n' "$INSTALLED"
printf 'LaunchAgent installed: %s\n' "$PLIST_INSTALLED"
printf 'LaunchAgent loaded: %s\n' "$LOADED"
printf 'Overlay running: %s\n' "$RUNNING"
printf 'Accessibility permission: %s\n' "$ACCESSIBILITY"
printf 'Overlay UI ready: %s\n' "$OVERLAY_READY"
printf 'Snapshot bridge healthy: %s\n' "$BRIDGE_HEALTHY"
printf 'Exact Session bound: %s\n' "$SESSION_BOUND"
printf 'Claude restart required: false\n'
