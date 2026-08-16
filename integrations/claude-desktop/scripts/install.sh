#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
# shellcheck source=./process-identity.sh
source "$ROOT/integrations/claude-desktop/scripts/process-identity.sh"
# shellcheck source=./path-safety.sh
source "$ROOT/integrations/claude-desktop/scripts/path-safety.sh"
# shellcheck source=./runtime-selection.sh
source "$ROOT/integrations/claude-desktop/scripts/runtime-selection.sh"
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
READY_TIMEOUT_SECONDS="${TOKEN_METER_READY_TIMEOUT_SECONDS:-10}"

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

for pair in \
  "CLAUDE_APP_PATH=$CLAUDE_APP_PATH" \
  "INSTALL_ROOT=$INSTALL_ROOT" \
  "STATE_DIR=$STATE_DIR" \
  "LAUNCH_AGENTS_DIR=$LAUNCH_AGENTS_DIR" \
  "LOG_DIR=$LOG_DIR"; do
  token_meter_require_absolute_path "${pair%%=*}" "${pair#*=}"
done
token_meter_assert_safe_recursive_root "INSTALL_ROOT" "$INSTALL_ROOT"
token_meter_assert_safe_recursive_root "STATE_DIR" "$STATE_DIR"
token_meter_assert_safe_recursive_root "LOG_DIR" "$LOG_DIR"
token_meter_assert_no_symlinked_ancestor "LAUNCH_AGENTS_DIR" "$LAUNCH_AGENTS_DIR"
token_meter_assert_disjoint_roots "INSTALL_ROOT" "$INSTALL_ROOT" "STATE_DIR" "$STATE_DIR"
token_meter_assert_disjoint_roots "INSTALL_ROOT" "$INSTALL_ROOT" "LOG_DIR" "$LOG_DIR"
token_meter_assert_disjoint_roots "STATE_DIR" "$STATE_DIR" "LOG_DIR" "$LOG_DIR"
case "$READY_TIMEOUT_SECONDS" in
  ''|*[!0-9]*|0)
    printf 'TOKEN_METER_READY_TIMEOUT_SECONDS must be a positive integer.\n' >&2
    exit 2
    ;;
esac

NODE_PATH="$(token_meter_resolve_node "$NODE_PATH")"
token_meter_require_absolute_path "NODE_PATH" "$NODE_PATH"
if ! /usr/bin/xcode-select -p >/dev/null 2>&1 || [ ! -x /usr/bin/swiftc ]; then
  printf 'Xcode Command Line Tools with Swift are required for source installation. Run ./scripts/doctor-claude-meter-macos.sh for details.\n' >&2
  exit 1
fi
if [ ! -x /usr/bin/codesign ] || [ ! -x /usr/bin/plutil ]; then
  printf 'macOS code-signing tools are required for source installation.\n' >&2
  exit 1
fi
if [ ! -x "$VERIFIER" ]; then
  printf 'Claude verifier is not executable: %s\n' "$VERIFIER" >&2
  exit 1
fi
# The overlay also serves Codex windows, so Claude.app is no longer required.
# When it is present we still verify it is the genuine, unmodified app before
# reading its model catalog; when it is absent we install Codex-only support.
if [ -e "$CLAUDE_APP_PATH" ]; then
  "$VERIFIER" "$CLAUDE_APP_PATH" >/dev/null
  if [ ! -f "$CLAUDE_APP_PATH/Contents/Resources/app.asar" ]; then
    printf 'Claude model catalog is missing from %s; context-window sizing falls back to live readings.\n' "$CLAUDE_APP_PATH" >&2
  fi
else
  printf 'Claude.app not found at %s; installing without the Claude model catalog (Codex support only).\n' "$CLAUDE_APP_PATH" >&2
fi

/bin/mkdir -p \
  "$LAUNCH_AGENTS_DIR" \
  "$LOG_DIR" \
  "$STATE_DIR" \
  "$(/usr/bin/dirname "$INSTALL_ROOT")"
token_meter_mark_installation_directory "$STATE_DIR" "$LABEL"
token_meter_mark_installation_directory "$LOG_DIR" "$LABEL"

STAGING="$INSTALL_ROOT.installing.$$"
BACKUP="$INSTALL_ROOT.previous.$$"
PLIST_TEMP="$PLIST.installing.$$"
PLIST_BACKUP="$PLIST.previous.$$"
WAS_LOADED=false
ACTIVATED=false
COMMITTED=false

rollback_installation() {
  set +e
  if [ "$LOAD" = true ] && "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  fi
  /bin/rm -f "$PLIST"
  if [ -f "$PLIST_BACKUP" ]; then
    /bin/mv "$PLIST_BACKUP" "$PLIST"
  fi
  /bin/rm -rf "$INSTALL_ROOT"
  if [ -d "$BACKUP" ]; then
    /bin/mv "$BACKUP" "$INSTALL_ROOT"
  fi
  if [ "$LOAD" = true ] && [ "$WAS_LOADED" = true ] && [ -f "$PLIST" ]; then
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1
  fi
  set -e
}

cleanup() {
  local status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$ACTIVATED" = true ] && [ "$COMMITTED" = false ]; then
    rollback_installation
  fi
  /bin/rm -rf "$STAGING"
  /bin/rm -f "$PLIST_TEMP"
  exit "$status"
}
trap cleanup EXIT

/bin/rm -rf "$STAGING" "$BACKUP"
/bin/mkdir -p "$STAGING"
/bin/cp -R "$ROOT/src" "$STAGING/src"
/bin/cp -R "$ROOT/runtime" "$STAGING/runtime"
/bin/cp -R "$ROOT/integrations" "$STAGING/integrations"
/bin/cp -R "$ROOT/web" "$STAGING/web"
/usr/bin/install -m 600 "$ROOT/package.json" "$STAGING/package.json"
/usr/bin/install -m 600 "$ROOT/LICENSE" "$STAGING/LICENSE"
token_meter_mark_installation_directory "$STAGING" "$LABEL"
"$ROOT/integrations/claude-desktop/scripts/build-app.sh" \
  --output "$STAGING/Token Widget for Claude.app"

EXECUTABLE="$INSTALL_ROOT/Token Widget for Claude.app/Contents/MacOS/TokenMeterClaudeOverlay"
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

if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  if [ "$LOAD" = false ]; then
    printf 'Refusing --no-load while the existing Claude Token Meter LaunchAgent is loaded.\n' >&2
    exit 1
  fi
  WAS_LOADED=true
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
ACTIVATED=true

APP_BUNDLE="$INSTALL_ROOT/Token Widget for Claude.app"
if [ "$PROMPT" = true ]; then
  /usr/bin/open -n -a "$APP_BUNDLE" --args --prompt-accessibility >/dev/null 2>&1 || true
  /bin/sleep 1
fi

if [ "$LOAD" = true ]; then
  /bin/rm -f "$STATE_DIR/health.json"
fi
if [ "$LOAD" = true ] && ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; then
  printf 'LaunchAgent bootstrap failed; the previous installation was restored.\n' >&2
  exit 1
fi

PROCESS_READY=false
if [ "$LOAD" = true ]; then
  for _ in $(/usr/bin/seq 1 "$((READY_TIMEOUT_SECONDS * 4))"); do
    HEALTH_FILE="$STATE_DIR/health.json"
    if [ -s "$HEALTH_FILE" ]; then
      READY_PID="$(/usr/bin/plutil -extract pid raw -o - "$HEALTH_FILE" 2>/dev/null || true)"
      if token_meter_process_matches_executable "$READY_PID" "$EXECUTABLE"; then
        PROCESS_READY=true
        break
      fi
    fi
    /bin/sleep 0.25
  done
  if [ "$PROCESS_READY" = false ]; then
    printf 'The new Claude Token Meter did not become ready; the previous installation was restored.\n' >&2
    exit 1
  fi
fi

ACCESSIBILITY_GRANTED=false
OVERLAY_READY=false
ACCESSIBILITY_CHECKED=false
if [ "$LOAD" = true ]; then
  for _ in $(/usr/bin/seq 1 "$((READY_TIMEOUT_SECONDS * 4))"); do
    if [ "$(/usr/bin/plutil -extract accessibilityChecked raw -o - "$STATE_DIR/health.json" 2>/dev/null || true)" = true ]; then
      ACCESSIBILITY_CHECKED=true
      break
    fi
    /bin/sleep 0.25
  done
  if [ "$ACCESSIBILITY_CHECKED" = false ]; then
    printf 'The new Claude Token Meter did not report its Accessibility state; the previous installation was restored.\n' >&2
    exit 1
  fi
  HEALTH_ACCESSIBILITY="$(/usr/bin/plutil -extract accessibilityGranted raw -o - "$STATE_DIR/health.json" 2>/dev/null || true)"
  case "$HEALTH_ACCESSIBILITY" in
    true)
      ACCESSIBILITY_GRANTED=true
      ;;
    false)
      ;;
    *)
      printf 'The new Claude Token Meter reported an invalid Accessibility state; the previous installation was restored.\n' >&2
      exit 1
      ;;
  esac
fi
if [ "$LOAD" = true ] && [ "$ACCESSIBILITY_GRANTED" = true ]; then
  for _ in $(/usr/bin/seq 1 "$((READY_TIMEOUT_SECONDS * 4))"); do
    if [ "$(/usr/bin/plutil -extract overlayReady raw -o - "$STATE_DIR/health.json" 2>/dev/null || true)" = true ]; then
      OVERLAY_READY=true
      break
    fi
    /bin/sleep 0.25
  done
  if [ "$OVERLAY_READY" = false ]; then
    printf 'The new Claude Token Meter UI did not become ready; the previous installation was restored.\n' >&2
    exit 1
  fi
fi

/bin/rm -rf "$BACKUP"
/bin/rm -f "$PLIST_BACKUP"
COMMITTED=true

printf 'Claude Desktop Token Meter installed at %s\n' "$INSTALL_ROOT"
if [ "$LOAD" = true ]; then
  printf 'LaunchAgent loaded as %s; Claude Desktop was not restarted.\n' "$LABEL"
else
  printf 'LaunchAgent written but not loaded (--no-load).\n'
fi
if [ "$ACCESSIBILITY_GRANTED" = true ]; then
  printf 'Accessibility permission: granted.\n'
else
  printf 'Accessibility permission: required. Enable Token Widget for Claude in System Settings > Privacy & Security > Accessibility.\n'
fi
printf 'Logs: %s\n' "$LOG_DIR"
trap - EXIT
