#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PORT=9334
APP_PATH="${CODEX_APP_PATH:-/Applications/ChatGPT.app}"
LABEL="com.sergiochan.token-meter"
BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CODEX_INSTALL_ROOT:-${TOKEN_METER_INSTALL_ROOT:-$BASE_ROOT/Codex Desktop}}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${TOKEN_METER_CODEX_LOG_DIR:-${TOKEN_METER_LOG_DIR:-$HOME/Library/Logs/Token Meter/Codex Desktop}}"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"
VERIFIER="${TOKEN_METER_CODEX_VERIFIER:-$ROOT/scripts/verify-codex-app-macos.sh}"

usage() {
  cat <<'EOF'
Usage: scripts/install-token-meter-macos.sh [--port PORT]

Install a per-user LaunchAgent that watches for verified Codex Desktop launches,
adds the loopback CDP flag when needed, and keeps Token Meter attached. A Codex
process already running without CDP receives one normal quit/relaunch attempt.
The installer never force-quits Codex.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
if [ -L "$INSTALL_ROOT" ]; then
  printf 'Refusing a symlinked installation directory: %s\n' "$INSTALL_ROOT" >&2
  exit 1
fi
if [ -e "$INSTALL_ROOT" ] && [ ! -d "$INSTALL_ROOT" ]; then
  printf 'Installation path exists and is not a directory: %s\n' "$INSTALL_ROOT" >&2
  exit 1
fi

if [ ! -x "$VERIFIER" ]; then
  printf 'Codex verifier is not executable: %s\n' "$VERIFIER" >&2
  exit 1
fi
NODE="$("$VERIFIER" "$APP_PATH")"
/bin/mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR" "$(/usr/bin/dirname "$INSTALL_ROOT")"

if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
  for _ in $(/usr/bin/seq 1 80); do
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    /bin/sleep 0.25
  done
  if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf 'The previous Token Meter LaunchAgent did not stop cleanly.\n' >&2
    exit 1
  fi
fi

STAGING="$INSTALL_ROOT.installing.$$"
BACKUP="$INSTALL_ROOT.previous.$$"
PLIST_TEMP="$PLIST.installing.$$"
PLIST_BACKUP="$PLIST.previous.$$"
cleanup() {
  /bin/rm -rf "$STAGING"
  /bin/rm -f "$PLIST_TEMP"
}
trap cleanup EXIT

/bin/rm -rf "$STAGING" "$BACKUP"
/bin/mkdir -p "$STAGING/scripts"
/bin/cp -R "$ROOT/src" "$STAGING/src"
/bin/cp -R "$ROOT/integrations" "$STAGING/integrations"
/bin/cp -R "$ROOT/runtime" "$STAGING/runtime"
/usr/bin/install -m 700 "$ROOT/scripts/token-meter-service-macos.sh" \
  "$STAGING/scripts/token-meter-service-macos.sh"
/usr/bin/install -m 700 "$ROOT/scripts/verify-codex-app-macos.sh" \
  "$STAGING/scripts/verify-codex-app-macos.sh"
/usr/bin/install -m 600 "$ROOT/scripts/macos-codex-processes.sh" \
  "$STAGING/scripts/macos-codex-processes.sh"
/usr/bin/install -m 600 "$ROOT/package.json" "$STAGING/package.json"
/usr/bin/install -m 600 "$ROOT/LICENSE" "$STAGING/LICENSE"

"$NODE" "$ROOT/scripts/render-launch-agent.mjs" \
  --output "$PLIST_TEMP" \
  --label "$LABEL" \
  --service "$INSTALL_ROOT/scripts/token-meter-service-macos.sh" \
  --root "$INSTALL_ROOT" \
  --app-path "$APP_PATH" \
  --port "$PORT" \
  --stdout "$LOG_DIR/service.log" \
  --stderr "$LOG_DIR/service-error.log"
/usr/bin/plutil -lint "$PLIST_TEMP" >/dev/null

if [ -d "$INSTALL_ROOT" ]; then
  /bin/mv "$INSTALL_ROOT" "$BACKUP"
fi
/bin/mv "$STAGING" "$INSTALL_ROOT"
if [ -f "$PLIST" ]; then
  /bin/mv "$PLIST" "$PLIST_BACKUP"
fi
/bin/mv "$PLIST_TEMP" "$PLIST"

if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; then
  /bin/rm -f "$PLIST"
  if [ -f "$PLIST_BACKUP" ]; then
    /bin/mv "$PLIST_BACKUP" "$PLIST"
  fi
  /bin/rm -rf "$INSTALL_ROOT"
  if [ -d "$BACKUP" ]; then
    /bin/mv "$BACKUP" "$INSTALL_ROOT"
  fi
  if [ -f "$PLIST" ]; then
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  fi
  printf 'LaunchAgent bootstrap failed; the previous installed files were restored.\n' >&2
  exit 1
fi
/bin/rm -rf "$BACKUP"
/bin/rm -f "$PLIST_BACKUP"

LEGACY_SERVICE="$BASE_ROOT/scripts/token-meter-service-macos.sh"
if [ "$INSTALL_ROOT" != "$BASE_ROOT" ] && [ -f "$LEGACY_SERVICE" ]; then
  /bin/rm -rf \
    "$BASE_ROOT/src" \
    "$BASE_ROOT/integrations" \
    "$BASE_ROOT/runtime" \
    "$BASE_ROOT/scripts"
  /bin/rm -f "$BASE_ROOT/package.json" "$BASE_ROOT/LICENSE"
fi
trap - EXIT

printf 'Token Meter installed and loaded as %s.\n' "$LABEL"
printf 'It will follow future Codex launches automatically.\n'
printf 'Logs: %s\n' "$LOG_DIR"
