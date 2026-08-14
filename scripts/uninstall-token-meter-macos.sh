#!/bin/bash
set -euo pipefail

PORT=9334
RESTART_CODEX=false
APP_PATH="${CODEX_APP_PATH:-/Applications/ChatGPT.app}"
LABEL="com.sergiochan.token-meter"
BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CODEX_INSTALL_ROOT:-$BASE_ROOT/Codex Desktop}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${TOKEN_METER_CODEX_LOG_DIR:-$HOME/Library/Logs/Token Meter/Codex Desktop}"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"

usage() {
  cat <<'EOF'
Usage: scripts/uninstall-token-meter-macos.sh [--restart] [--port PORT]

Unload the per-user Token Meter service and remove its installed files. Pass
--restart to normally quit and reopen Codex without the debugging port. The
uninstaller never force-quits Codex.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart)
      RESTART_CODEX=true
      shift
      ;;
    --port)
      PORT="${2:-}"
      shift 2
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

case "$PORT" in
  ''|*[!0-9]*)
    printf 'Port must be numeric.\n' >&2
    exit 2
    ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  printf 'Port must be between 1024 and 65535.\n' >&2
  exit 2
fi

if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
  for _ in $(/usr/bin/seq 1 80); do
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    /bin/sleep 0.25
  done
  if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf 'The Token Meter LaunchAgent did not stop cleanly.\n' >&2
    exit 1
  fi
fi

RUNTIME_ROOT="$INSTALL_ROOT"
if [ ! -f "$RUNTIME_ROOT/src/cli.mjs" ] && \
  [ -f "$BASE_ROOT/scripts/token-meter-service-macos.sh" ]; then
  RUNTIME_ROOT="$BASE_ROOT"
fi
if [ -x "$RUNTIME_ROOT/scripts/verify-codex-app-macos.sh" ] && \
  [ -f "$RUNTIME_ROOT/src/cli.mjs" ]; then
  NODE="$("$RUNTIME_ROOT/scripts/verify-codex-app-macos.sh" "$APP_PATH" 2>/dev/null || true)"
  if [ -n "$NODE" ]; then
    "$NODE" "$RUNTIME_ROOT/src/cli.mjs" remove --cdp-port "$PORT" >/dev/null || true
  fi
fi

/bin/rm -f "$PLIST"
/bin/rm -rf "$INSTALL_ROOT" "$LOG_DIR"
if [ "$INSTALL_ROOT" != "$BASE_ROOT" ] && \
  [ -f "$BASE_ROOT/scripts/token-meter-service-macos.sh" ]; then
  /bin/rm -rf \
    "$BASE_ROOT/src" \
    "$BASE_ROOT/integrations" \
    "$BASE_ROOT/runtime" \
    "$BASE_ROOT/scripts"
  /bin/rm -f "$BASE_ROOT/package.json" "$BASE_ROOT/LICENSE"
fi

if [ "$RESTART_CODEX" = true ] && [ -d "$APP_PATH" ]; then
  SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
  # shellcheck source=./macos-codex-processes.sh
  source "$SCRIPT_ROOT/macos-codex-processes.sh"
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  if ! wait_for_codex_exit "$APP_PATH" 160 0.25; then
    printf 'Codex did not quit cleanly; no force-quit was attempted.\n' >&2
    exit 1
  fi
  /usr/bin/open "$APP_PATH"
fi

printf 'Token Meter was uninstalled.\n'
