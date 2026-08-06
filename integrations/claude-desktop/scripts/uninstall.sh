#!/bin/bash
set -euo pipefail

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

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--purge-state] [--keep-logs]

Remove the Claude Desktop Token Meter companion and LaunchAgent without
quitting, relaunching, or modifying Claude.app. Position and collapsed state
are retained unless --purge-state is provided.
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

for target in "$INSTALL_ROOT" "$STATE_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"; do
  if [ -z "$target" ] || [ "${target#/}" = "$target" ]; then
    printf 'Refusing a non-absolute removal path: %s\n' "${target:-<empty>}" >&2
    exit 2
  fi
  if [ -L "$target" ]; then
    printf 'Refusing a symlinked removal path: %s\n' "$target" >&2
    exit 1
  fi
done

if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
fi
/bin/rm -f "$PLIST"
/bin/rm -rf "$INSTALL_ROOT"
if [ "$PURGE_STATE" = true ]; then
  /bin/rm -rf "$STATE_DIR"
fi
if [ "$KEEP_LOGS" = false ]; then
  /bin/rm -rf "$LOG_DIR"
fi

printf 'Claude Desktop Token Meter removed. Claude Desktop was not changed or restarted.\n'
if [ "$PURGE_STATE" = false ] && [ -d "$STATE_DIR" ]; then
  printf 'Saved layout state retained at %s\n' "$STATE_DIR"
fi
