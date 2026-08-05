#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=9334
ALLOW_RESTART=false
APP_PATH="${CODEX_APP_PATH:-/Applications/ChatGPT.app}"

usage() {
  cat <<'EOF'
Usage: scripts/start-codex-meter-macos.sh [--restart] [--port PORT]

Attach Token Meter to a Codex instance that already exposes loopback CDP.
If Codex is running without CDP, pass --restart to explicitly allow a normal
Codex quit and relaunch with the loopback debugging port.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart)
      ALLOW_RESTART=true
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
      usage >&2
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

if [ ! -d "$APP_PATH" ]; then
  printf 'Codex application not found at %s\n' "$APP_PATH" >&2
  printf 'Set CODEX_APP_PATH to the current application bundle.\n' >&2
  exit 1
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")"
if [ "$BUNDLE_ID" != "com.openai.codex" ]; then
  printf 'Refusing an application whose bundle identifier is %s\n' "$BUNDLE_ID" >&2
  exit 1
fi

NODE="$APP_PATH/Contents/Resources/cua_node/bin/node"
if [ ! -x "$NODE" ]; then
  printf 'The bundled Codex Node runtime is missing: %s\n' "$NODE" >&2
  exit 1
fi

ENDPOINT="http://127.0.0.1:$PORT/json/version"
if ! /usr/bin/curl --silent --fail --max-time 1 "$ENDPOINT" >/dev/null 2>&1; then
  if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
    if [ "$ALLOW_RESTART" != true ]; then
      cat >&2 <<EOF
Codex is running without Token Meter's loopback CDP endpoint.
Re-run with --restart to explicitly allow a normal quit and relaunch.
EOF
      exit 3
    fi
    /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
    for _ in $(/usr/bin/seq 1 60); do
      /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1 || break
      /bin/sleep 0.25
    done
    if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
      printf 'Codex did not quit cleanly; no force-quit was attempted.\n' >&2
      exit 1
    fi
  fi

  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already owned by another process.\n' "$PORT" >&2
    exit 1
  fi

  /usr/bin/open -na "$APP_PATH" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$PORT"

  for _ in $(/usr/bin/seq 1 120); do
    /usr/bin/curl --silent --fail --max-time 1 "$ENDPOINT" >/dev/null 2>&1 && break
    /bin/sleep 0.25
  done
  if ! /usr/bin/curl --silent --fail --max-time 1 "$ENDPOINT" >/dev/null 2>&1; then
    printf 'Codex did not expose the verified CDP endpoint on port %s.\n' "$PORT" >&2
    exit 1
  fi
fi

cat <<EOF
Token Meter is attaching to Codex on 127.0.0.1:$PORT.
Keep this terminal open. Press Control-C to remove the injected meter.
Restart Codex normally afterward to close the debugging port.
EOF

exec "$NODE" "$ROOT/src/cli.mjs" inject --cdp-port "$PORT"

