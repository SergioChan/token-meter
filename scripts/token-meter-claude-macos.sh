#!/bin/bash
set -euo pipefail
umask 077

LABEL="com.sergiochan.token-meter.claude-desktop"
BUNDLE_ID="com.sergiochan.token-meter.claude-overlay"
TEAM_ID="DVA9SD82WQ"
CLAUDE_TEAM_ID="Q6L2SF6YDW"
CLAUDE_APP="/Applications/Claude.app"
INSTALL_ROOT="$HOME/Applications/Token Meter"
APP_BUNDLE="$INSTALL_ROOT/Token Meter for Claude.app"
STATE_DIR="$HOME/Library/Application Support/Token Meter/State/Claude Desktop"
LOG_DIR="$HOME/Library/Logs/Token Meter/Claude Desktop"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
MANAGER_DIR="$HOME/Library/Application Support/Token Meter/bin"
MANAGER="$MANAGER_DIR/token-meter-claude"
DOMAIN="gui/$(/usr/bin/id -u)"
HEALTH_FILE="$STATE_DIR/health.json"
EXECUTABLE="$APP_BUNDLE/Contents/MacOS/TokenMeterClaudeOverlay"
MARKER=".token-meter-installation"

usage() {
  cat <<'EOF'
Usage: token-meter-claude [command] [options]

Commands:
  install                    Download and install the latest signed release
  status [--json]            Inspect process, permission, UI, bridge, and Session state
  uninstall [options]        Remove the companion without restarting Claude

Install options:
  --version TAG              Install a specific tag instead of the latest release
  --no-load                  Install without loading the LaunchAgent
  --no-prompt                Do not request Accessibility permission

Uninstall options:
  --purge-state              Remove saved position and collapsed state
  --keep-logs                Retain local logs
  --reset-accessibility      Reset the companion's macOS Accessibility grant

The release app contains its own Node.js runtime. Node.js, Swift, Xcode, and
administrator privileges are not required.
EOF
}

require_safe_root() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ] || [ "${value#/}" = "$value" ]; then
    printf '%s must be an absolute path.\n' "$name" >&2
    return 2
  fi
  case "$value" in
    /|"$HOME"|"$HOME/Library"|"$HOME/Applications"|"$HOME/Library/Application Support"|"$HOME/Library/Logs")
      printf 'Refusing unsafe managed root for %s: %s\n' "$name" "$value" >&2
      return 1
      ;;
  esac
  local current="$value"
  while [ "$current" != / ]; do
    if [ -L "$current" ]; then
      case "$current" in
        /var|/tmp|/etc) ;;
        *)
          printf '%s has a symlinked ancestor: %s\n' "$name" "$current" >&2
          return 1
          ;;
      esac
    fi
    current="$(/usr/bin/dirname "$current")"
  done
}

mark_directory() {
  local directory="$1"
  /usr/bin/install -m 600 /dev/null "$directory/$MARKER"
  printf '%s\n' "$LABEL" > "$directory/$MARKER"
}

is_managed_directory() {
  local directory="$1"
  [ -f "$directory/$MARKER" ] && \
    [ "$(/usr/bin/tr -d '\r\n' < "$directory/$MARKER")" = "$LABEL" ]
}

remove_managed_directory() {
  local name="$1"
  local directory="$2"
  [ -e "$directory" ] || return 0
  require_safe_root "$name" "$directory"
  if ! is_managed_directory "$directory"; then
    printf 'Refusing to remove an unmarked %s directory: %s\n' "$name" "$directory" >&2
    return 1
  fi
  /bin/rm -rf "$directory"
}

process_matches_executable() {
  local pid="$1"
  local executable="$2"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    "$executable"|"$executable "*) return 0 ;;
    *) return 1 ;;
  esac
}

signature_team_id() {
  /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 | \
    /usr/bin/awk -F= '$1 == "TeamIdentifier" { print $2; exit }'
}

verify_claude() {
  if [ ! -d "$CLAUDE_APP" ] || [ -L "$CLAUDE_APP" ]; then
    printf 'The official Claude Desktop application was not found at %s.\n' "$CLAUDE_APP" >&2
    return 1
  fi
  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$CLAUDE_APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$bundle_id" != com.anthropic.claudefordesktop ]; then
    printf 'Refusing a Claude application with bundle ID %s.\n' "${bundle_id:-<missing>}" >&2
    return 1
  fi
  /usr/bin/codesign --verify --deep --strict "$CLAUDE_APP"
  if [ "$(signature_team_id "$CLAUDE_APP")" != "$CLAUDE_TEAM_ID" ]; then
    printf 'Claude Desktop has an unexpected signing Team ID.\n' >&2
    return 1
  fi
  [ -f "$CLAUDE_APP/Contents/Resources/app.asar" ]
}

verify_release_app() {
  local app="$1"
  if [ ! -d "$app" ] || [ -L "$app" ]; then
    printf 'The release archive does not contain the expected application.\n' >&2
    return 1
  fi
  local bundle_id
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
    "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$bundle_id" != "$BUNDLE_ID" ]; then
    printf 'The release application has an unexpected bundle ID.\n' >&2
    return 1
  fi
  /usr/bin/codesign --verify --deep --strict "$app"
  local signature
  signature="$(/usr/bin/codesign -dv --verbose=4 "$app" 2>&1)"
  if [ "$(printf '%s\n' "$signature" | /usr/bin/awk -F= '$1 == "TeamIdentifier" { print $2; exit }')" != "$TEAM_ID" ]; then
    printf 'The release application has an unexpected TeamIdentifier.\n' >&2
    return 1
  fi
  if ! printf '%s\n' "$signature" | /usr/bin/awk -F= '$1 == "Authority" && $2 ~ /^Developer ID Application/ { found=1 } END { exit found ? 0 : 1 }'; then
    printf 'The release application is not signed with Developer ID Application.\n' >&2
    return 1
  fi
  /usr/sbin/spctl --assess --type execute --verbose=4 "$app"
  local node="$app/Contents/Resources/Node/bin/node"
  if [ ! -x "$node" ] || ! "$node" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
  '; then
    printf 'The embedded Node.js runtime is missing or incompatible.\n' >&2
    return 1
  fi
}

health_boolean() {
  /usr/bin/plutil -extract "$1" raw -o - "$HEALTH_FILE" 2>/dev/null || true
}

status_command() {
  local json=false
  case "${1:-}" in
    --json) json=true ;;
    '') ;;
    *) printf 'Unknown status option: %s\n' "$1" >&2; return 2 ;;
  esac
  local installed=false plist_installed=false loaded=false running=false
  local accessibility=false overlay=false bridge=false session=false state=false
  [ -x "$EXECUTABLE" ] && installed=true
  [ -f "$PLIST" ] && plist_installed=true
  [ -d "$STATE_DIR" ] && state=true
  if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then loaded=true; fi
  if [ "$loaded" = true ] && [ -s "$HEALTH_FILE" ]; then
    local pid
    pid="$(/usr/bin/plutil -extract pid raw -o - "$HEALTH_FILE" 2>/dev/null || true)"
    if process_matches_executable "$pid" "$EXECUTABLE"; then running=true; fi
  fi
  if [ "$running" = true ] && "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
    accessibility=true
  fi
  if [ "$running" = true ]; then
    [ "$(health_boolean overlayReady)" = true ] && overlay=true
    [ "$(health_boolean bridgeHealthy)" = true ] && bridge=true
    [ "$(health_boolean sessionBound)" = true ] && session=true
  fi
  if [ "$json" = true ]; then
    printf '{"installed":%s,"launchAgentInstalled":%s,"launchAgentLoaded":%s,"running":%s,"accessibilityGranted":%s,"overlayReady":%s,"bridgeHealthy":%s,"sessionBound":%s,"statePresent":%s,"claudeRestartRequired":false}\n' \
      "$installed" "$plist_installed" "$loaded" "$running" "$accessibility" \
      "$overlay" "$bridge" "$session" "$state"
  else
    printf 'Installed: %s\n' "$installed"
    printf 'LaunchAgent installed: %s\n' "$plist_installed"
    printf 'LaunchAgent loaded: %s\n' "$loaded"
    printf 'Companion process running: %s\n' "$running"
    printf 'Accessibility permission: %s\n' "$accessibility"
    printf 'Overlay UI ready: %s\n' "$overlay"
    printf 'Snapshot bridge healthy: %s\n' "$bridge"
    printf 'Exact Session bound: %s\n' "$session"
    printf 'Claude restart required: false\n'
  fi
}

install_command() {
  local version=latest load=true prompt=true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) version="${2:-}"; shift 2 ;;
      --no-load) load=false; shift ;;
      --no-prompt) prompt=false; shift ;;
      --help|-h) usage; return 0 ;;
      *) printf 'Unknown install option: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  case "$version" in
    latest) release_base="https://github.com/SergioChan/token-meter/releases/latest/download" ;;
    v[0-9]*.[0-9]*.[0-9]*) release_base="https://github.com/SergioChan/token-meter/releases/download/$version" ;;
    [0-9]*.[0-9]*.[0-9]*) release_base="https://github.com/SergioChan/token-meter/releases/download/v$version" ;;
    *) printf 'The release version is invalid: %s\n' "$version" >&2; return 2 ;;
  esac
  local arch
  arch="$(/usr/bin/uname -m)"
  case "$arch" in arm64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; return 1 ;; esac

  require_safe_root INSTALL_ROOT "$INSTALL_ROOT"
  require_safe_root STATE_DIR "$STATE_DIR"
  require_safe_root LOG_DIR "$LOG_DIR"
  verify_claude

  local work asset_name archive checksums expected actual expanded_app
  work="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/token-meter-install.XXXXXX")"
  asset_name="token-meter-claude-macos-$arch.zip"
  archive="$work/$asset_name"
  checksums="$work/checksums.txt"
  cleanup_download() { /bin/rm -rf "$work"; }
  trap cleanup_download RETURN
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$archive" "$release_base/$asset_name"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$checksums" "$release_base/checksums.txt"
  expected="$(/usr/bin/awk -v file="$asset_name" '$2 == file || $2 == "*" file { print $1; exit }' "$checksums")"
  actual="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    printf 'The release archive failed SHA-256 verification.\n' >&2
    return 1
  fi
  /usr/bin/ditto -x -k "$archive" "$work/expanded"
  expanded_app="$work/expanded/Token Meter for Claude.app"
  verify_release_app "$expanded_app"

  /bin/mkdir -p "$HOME/Applications" "$STATE_DIR" "$LOG_DIR" "$LAUNCH_AGENTS_DIR" "$MANAGER_DIR"
  mark_directory "$STATE_DIR"
  mark_directory "$LOG_DIR"
  local staging backup plist_temp plist_backup was_loaded=false activated=false committed=false
  staging="$INSTALL_ROOT.installing.$$"
  backup="$INSTALL_ROOT.previous.$$"
  plist_temp="$PLIST.installing.$$"
  plist_backup="$PLIST.previous.$$"
  /bin/rm -rf "$staging" "$backup"
  /bin/mkdir -p "$staging"
  /bin/cp -R "$expanded_app" "$staging/Token Meter for Claude.app"
  mark_directory "$staging"
  local staged_app staged_node renderer
  staged_app="$staging/Token Meter for Claude.app"
  staged_node="$staged_app/Contents/Resources/Node/bin/node"
  renderer="$staged_app/Contents/Resources/TokenMeterRuntime/integrations/claude-desktop/scripts/render-launch-agent.mjs"
  "$staged_node" "$renderer" \
    --output "$plist_temp" \
    --label "$LABEL" \
    --executable "$EXECUTABLE" \
    --claude-app "$CLAUDE_APP" \
    --state-dir "$STATE_DIR" \
    --stdout "$LOG_DIR/overlay.log" \
    --stderr "$LOG_DIR/overlay-error.log"
  /usr/bin/plutil -lint "$plist_temp" >/dev/null

  rollback_release() {
    set +e
    if [ "$load" = true ] && /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
    fi
    /bin/rm -f "$PLIST"
    [ -f "$plist_backup" ] && /bin/mv "$plist_backup" "$PLIST"
    /bin/rm -rf "$INSTALL_ROOT"
    [ -d "$backup" ] && /bin/mv "$backup" "$INSTALL_ROOT"
    if [ "$load" = true ] && [ "$was_loaded" = true ] && [ -f "$PLIST" ]; then
      /bin/launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1
    fi
    set -e
  }
  finish_install() {
    local result="$?"
    trap - RETURN
    if [ "$result" -ne 0 ] && [ "$activated" = true ] && [ "$committed" = false ]; then
      rollback_release
    fi
    /bin/rm -rf "$staging"
    /bin/rm -f "$plist_temp"
    cleanup_download
    return "$result"
  }
  trap finish_install RETURN

  if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    if [ "$load" = false ]; then
      printf 'Refusing --no-load while the existing LaunchAgent is loaded.\n' >&2
      return 1
    fi
    was_loaded=true
    /bin/launchctl bootout "$DOMAIN/$LABEL"
  fi
  [ -d "$INSTALL_ROOT" ] && /bin/mv "$INSTALL_ROOT" "$backup"
  /bin/mv "$staging" "$INSTALL_ROOT"
  [ -f "$PLIST" ] && /bin/mv "$PLIST" "$plist_backup"
  /bin/mv "$plist_temp" "$PLIST"
  activated=true

  if [ "$prompt" = true ]; then
    /usr/bin/open -n -a "$APP_BUNDLE" --args --prompt-accessibility >/dev/null 2>&1 || true
    /bin/sleep 1
  fi
  if [ "$load" = true ]; then
    /bin/rm -f "$HEALTH_FILE"
    if ! /bin/launchctl bootstrap "$DOMAIN" "$PLIST"; then
      printf 'LaunchAgent bootstrap failed; the previous installation was restored.\n' >&2
      return 1
    fi
    local ready=false pid
    for _ in $(/usr/bin/seq 1 40); do
      pid="$(/usr/bin/plutil -extract pid raw -o - "$HEALTH_FILE" 2>/dev/null || true)"
      if process_matches_executable "$pid" "$EXECUTABLE"; then ready=true; break; fi
      /bin/sleep 0.25
    done
    if [ "$ready" = false ]; then
      printf 'The new companion did not become ready; the previous installation was restored.\n' >&2
      return 1
    fi
    if "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
      local overlay=false
      for _ in $(/usr/bin/seq 1 40); do
        if [ "$(health_boolean overlayReady)" = true ]; then overlay=true; break; fi
        /bin/sleep 0.25
      done
      if [ "$overlay" = false ]; then
        printf 'The new overlay did not become ready; the previous installation was restored.\n' >&2
        return 1
      fi
    fi
  fi

  /bin/rm -rf "$backup"
  /bin/rm -f "$plist_backup"
  if [ "${BASH_SOURCE[0]}" != "$MANAGER" ]; then
    /usr/bin/install -m 755 "${BASH_SOURCE[0]}" "$MANAGER"
  else
    /bin/chmod 755 "$MANAGER"
  fi
  committed=true
  printf 'Token Meter for Claude installed at %s\n' "$APP_BUNDLE"
  printf 'Claude Desktop was not modified or restarted.\n'
  if [ "$load" = true ] && ! "$EXECUTABLE" --check-accessibility >/dev/null 2>&1; then
    printf 'Accessibility permission is required. Enable Token Meter for Claude in System Settings > Privacy & Security > Accessibility.\n'
  fi
  printf 'Manage it with: %s status --json\n' "$MANAGER"
}

uninstall_command() {
  local purge=false keep_logs=false reset_accessibility=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --purge-state) purge=true; shift ;;
      --keep-logs) keep_logs=true; shift ;;
      --reset-accessibility) reset_accessibility=true; shift ;;
      --help|-h) usage; return 0 ;;
      *) printf 'Unknown uninstall option: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  require_safe_root INSTALL_ROOT "$INSTALL_ROOT"
  require_safe_root STATE_DIR "$STATE_DIR"
  require_safe_root LOG_DIR "$LOG_DIR"
  if [ -e "$INSTALL_ROOT" ] && ! is_managed_directory "$INSTALL_ROOT"; then
    printf 'Refusing to uninstall an unmarked installation directory: %s\n' "$INSTALL_ROOT" >&2
    return 1
  fi
  if [ "$purge" = true ] && [ -e "$STATE_DIR" ] && ! is_managed_directory "$STATE_DIR"; then
    printf 'Refusing to purge an unmarked state directory: %s\n' "$STATE_DIR" >&2
    return 1
  fi
  if [ "$keep_logs" = false ] && [ -e "$LOG_DIR" ] && ! is_managed_directory "$LOG_DIR"; then
    printf 'Refusing to remove an unmarked log directory: %s\n' "$LOG_DIR" >&2
    return 1
  fi
  if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootout "$DOMAIN/$LABEL"
  fi
  /bin/rm -f "$PLIST"
  remove_managed_directory installation "$INSTALL_ROOT"
  if [ "$purge" = true ]; then remove_managed_directory state "$STATE_DIR"; fi
  if [ "$keep_logs" = false ]; then remove_managed_directory logs "$LOG_DIR"; fi
  if [ "$reset_accessibility" = true ]; then
    /usr/bin/tccutil reset Accessibility "$BUNDLE_ID"
  fi
  if [ "${BASH_SOURCE[0]}" != "$MANAGER" ]; then /bin/rm -f "$MANAGER"; fi
  printf 'Token Meter for Claude removed. Claude Desktop was not modified or restarted.\n'
}

command="${1:-install}"
case "$command" in
  --help|-h) usage ;;
  install) shift; install_command "$@" ;;
  status) shift; status_command "$@" ;;
  uninstall) shift; uninstall_command "$@" ;;
  *) printf 'Unknown command: %s\n\n' "$command" >&2; usage >&2; exit 2 ;;
esac
