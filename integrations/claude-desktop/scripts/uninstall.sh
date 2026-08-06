#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
# shellcheck source=./path-safety.sh
source "$ROOT/integrations/claude-desktop/scripts/path-safety.sh"

BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CLAUDE_INSTALL_ROOT:-$BASE_ROOT/Claude Desktop}"
STATE_DIR="${TOKEN_METER_CLAUDE_STATE_DIR:-$BASE_ROOT/State/Claude Desktop}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${TOKEN_METER_CLAUDE_LOG_DIR:-$HOME/Library/Logs/Token Meter/Claude Desktop}"
LABEL="com.sergiochan.token-meter.claude-desktop"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"
PURGE_STATE=false
KEEP_LOGS=false
RESET_ACCESSIBILITY=false
TCCUTIL="${TOKEN_METER_TCCUTIL:-/usr/bin/tccutil}"
BUNDLE_ID="com.sergiochan.token-meter.claude-overlay"

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--purge-state] [--keep-logs] [--reset-accessibility]

Remove the Claude Desktop Token Meter companion and LaunchAgent without
quitting, relaunching, or modifying Claude.app. Position and collapsed state
are retained unless --purge-state is provided.

Use --reset-accessibility to remove the companion's macOS Accessibility grant.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge-state)
      PURGE_STATE=true
      shift
      ;;
    --keep-logs)
      KEEP_LOGS=true
      shift
      ;;
    --reset-accessibility)
      RESET_ACCESSIBILITY=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

token_meter_assert_safe_recursive_root "INSTALL_ROOT" "$INSTALL_ROOT"
token_meter_assert_safe_recursive_root "STATE_DIR" "$STATE_DIR"
token_meter_assert_safe_recursive_root "LOG_DIR" "$LOG_DIR"
token_meter_require_absolute_path "LAUNCH_AGENTS_DIR" "$LAUNCH_AGENTS_DIR"
token_meter_assert_no_symlinked_ancestor "LAUNCH_AGENTS_DIR" "$LAUNCH_AGENTS_DIR"
token_meter_assert_disjoint_roots "INSTALL_ROOT" "$INSTALL_ROOT" "STATE_DIR" "$STATE_DIR"
token_meter_assert_disjoint_roots "INSTALL_ROOT" "$INSTALL_ROOT" "LOG_DIR" "$LOG_DIR"
token_meter_assert_disjoint_roots "STATE_DIR" "$STATE_DIR" "LOG_DIR" "$LOG_DIR"

if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
fi
/bin/rm -f "$PLIST"
token_meter_remove_managed_directory "installation" "$INSTALL_ROOT" "$LABEL"
if [ "$PURGE_STATE" = true ]; then
  token_meter_remove_managed_directory "state" "$STATE_DIR" "$LABEL"
fi
if [ "$KEEP_LOGS" = false ]; then
  token_meter_remove_managed_directory "log" "$LOG_DIR" "$LABEL"
fi
if [ "$RESET_ACCESSIBILITY" = true ]; then
  if [ ! -x "$TCCUTIL" ]; then
    printf 'tccutil is not executable: %s\n' "$TCCUTIL" >&2
    exit 1
  fi
  "$TCCUTIL" reset Accessibility "$BUNDLE_ID"
fi

printf 'Claude Desktop Token Meter removed. Claude Desktop was not changed or restarted.\n'
if [ "$PURGE_STATE" = false ] && [ -d "$STATE_DIR" ]; then
  printf 'Saved layout state retained at %s\n' "$STATE_DIR"
fi
