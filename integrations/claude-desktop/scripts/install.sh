#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
CLAUDE_APP_PATH="${CLAUDE_APP_PATH:-/Applications/Claude.app}"
BASE_ROOT="${TOKEN_METER_BASE_ROOT:-$HOME/Library/Application Support/Token Meter}"
INSTALL_ROOT="${TOKEN_METER_CLAUDE_INSTALL_ROOT:-$BASE_ROOT/Claude Desktop}"
STATE_DIR="${TOKEN_METER_CLAUDE_STATE_DIR:-$BASE_ROOT/State/Claude Desktop}"
LAUNCH_AGENTS_DIR="${TOKEN_METER_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${TOKEN_METER_CLAUDE_LOG_DIR:-$HOME/Library/Logs/Token Meter/Claude Desktop}"
LABEL="com.sergiochan.token-meter.claude-desktop"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHCTL="${TOKEN_METER_LAUNCHCTL:-/bin/launchctl}"
VERIFIER="${TOKEN_METER_CLAUDE_VERIFIER:-$ROOT/scripts/verify-claude-app-macos.sh}"
NODE_PATH="${TOKEN_METER_NODE:-}"
LOAD=true
PROMPT=true

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the native Token Meter companion for Claude Code inside Claude Desktop.
This installer does not quit, relaunch, modify, patch, or re-sign Claude.app.

Options:
  --node PATH         Absolute Node.js 22.12+ executable path
  --claude-app PATH   Claude.app path (default: /Applications/Claude.app)
  --no-load           Install files and LaunchAgent without loading it
  --no-prompt         Do not request macOS Accessibility permission
  --help              Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node)
      NODE_PATH="${2:-}"
      shift 2
      ;;
    --claude-app)
      CLAUDE_APP_PATH="${2:-}"
      shift 2
      ;;
    --no-load)
      LOAD=false
      shift
      ;;
    --no-prompt)
      PROMPT=false
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

require_absolute_path() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ] || [ "${value#/}" = "$value" ]; then
    printf '%s must be an absolute path: %s\n' "$name" "${value:-<empty>}" >&2
    exit 2
  fi
  if printf '%s' "$value" | /usr/bin/grep -q $'[\r\n]'; then
    printf '%s contains invalid characters.\n' "$name" >&2
    exit 2
  fi
}

for pair in \
  "CLAUDE_APP_PATH=$CLAUDE_APP_PATH" \
  "INSTALL_ROOT=$INSTALL_ROOT" \
  "STATE_DIR=$STATE_DIR" \
  "LAUNCH_AGENTS_DIR=$LAUNCH_AGENTS_DIR" \
  "LOG_DIR=$LOG_DIR"; do
  require_absolute_path "${pair%%=*}" "${pair#*=}"
done
for target in "$INSTALL_ROOT" "$STATE_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"; do
  if [ -L "$target" ]; then
    printf 'Refusing a symlinked installation path: %s\n' "$target" >&2
    exit 1
  fi
done

if [ -z "$NODE_PATH" ]; then
  NODE_PATH="$(command -v node 2>/dev/null || true)"
fi
require_absolute_path "NODE_PATH" "$NODE_PATH"
if [ ! -x "$NODE_PATH" ]; then
  printf 'Node.js is not executable: %s\n' "$NODE_PATH" >&2
  exit 1
fi
if ! "$NODE_PATH" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
'; then
  printf 'Node.js 22.12 or newer is required: %s\n' "$NODE_PATH" >&2
  exit 1
fi
if [ ! -x "$VERIFIER" ]; then
  printf 'Claude verifier is not executable: %s\n' "$VERIFIER" >&2
  exit 1
fi
"$VERIFIER" "$CLAUDE_APP_PATH" >/dev/null
if [ ! -f "$CLAUDE_APP_PATH/Contents/Resources/app.asar" ]; then
  printf 'Claude model catalog is missing from %s\n' "$CLAUDE_APP_PATH" >&2
  exit 1
fi

/bin/mkdir -p \
  "$LAUNCH_AGENTS_DIR" \
  "$LOG_DIR" \
  "$STATE_DIR" \
  "$(/usr/bin/dirname "$INSTALL_ROOT")"

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
/bin/mkdir -p "$STAGING"
/bin/cp -R "$ROOT/src" "$STAGING/src"
/bin/cp -R "$ROOT/runtime" "$STAGING/runtime"
/bin/cp -R "$ROOT/integrations" "$STAGING/integrations"
/usr/bin/install -m 600 "$ROOT/package.json" "$STAGING/package.json"
/usr/bin/install -m 600 "$ROOT/LICENSE" "$STAGING/LICENSE"
"$ROOT/integrations/claude-desktop/scripts/build-app.sh" \
  --output "$STAGING/Token Meter for Claude.app"

EXECUTABLE="$INSTALL_ROOT/Token Meter for Claude.app/Contents/MacOS/TokenMeterClaudeOverlay"
"$NODE_PATH" "$ROOT/integrations/claude-desktop/scripts/render-launch-agent.mjs" \
  --output "$PLIST_TEMP" \
  --label "$LABEL" \
  --executable "$EXECUTABLE" \
  --root "$INSTALL_ROOT" \
  --node "$NODE_PATH" \
  --claude-app "$CLAUDE_APP_PATH" \
  --state-dir "$STATE_DIR" \
  --stdout "$LOG_DIR/overlay.log" \
  --stderr "$LOG_DIR/overlay-error.log"
/usr/bin/plutil -lint "$PLIST_TEMP" >/dev/null

if [ "$LOAD" = true ] && "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
  for _ in $(/usr/bin/seq 1 80); do
    "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    /bin/sleep 0.25
  done
  if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf 'The previous Claude Token Meter LaunchAgent did not stop cleanly.\n' >&2
    exit 1
  fi
fi

if [ -d "$INSTALL_ROOT" ]; then
  /bin/mv "$INSTALL_ROOT" "$BACKUP"
fi
/bin/mv "$STAGING" "$INSTALL_ROOT"
if [ -f "$PLIST" ]; then
  /bin/mv "$PLIST" "$PLIST_BACKUP"
fi
/bin/mv "$PLIST_TEMP" "$PLIST"

if [ "$PROMPT" = true ]; then
  "$EXECUTABLE" --prompt-accessibility >/dev/null 2>&1 || true
fi

if [ "$LOAD" = true ] && ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; then
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
  printf 'LaunchAgent bootstrap failed; the previous installation was restored.\n' >&2
  exit 1
fi

/bin/rm -rf "$BACKUP"
/bin/rm -f "$PLIST_BACKUP"
trap - EXIT

printf 'Claude Desktop Token Meter installed at %s\n' "$INSTALL_ROOT"
if [ "$LOAD" = true ]; then
  printf 'LaunchAgent loaded as %s; Claude Desktop was not restarted.\n' "$LABEL"
else
  printf 'LaunchAgent written but not loaded (--no-load).\n'
fi
if "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
  printf 'Accessibility permission: granted.\n'
else
  printf 'Accessibility permission: required. Enable Token Meter for Claude in System Settings > Privacy & Security > Accessibility.\n'
fi
printf 'Logs: %s\n' "$LOG_DIR"
