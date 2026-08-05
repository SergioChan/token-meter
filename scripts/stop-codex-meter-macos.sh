#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=9334
RESTART_CODEX=false
APP_PATH="${CODEX_APP_PATH:-/Applications/ChatGPT.app}"

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
      printf 'Usage: scripts/stop-codex-meter-macos.sh [--restart] [--port PORT]\n'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

NODE="$APP_PATH/Contents/Resources/cua_node/bin/node"
if [ ! -x "$NODE" ]; then
  printf 'The bundled Codex Node runtime is missing: %s\n' "$NODE" >&2
  exit 1
fi

PIDS="$(/usr/bin/pgrep -f "$ROOT/src/cli.mjs inject" || true)"
for PID in $PIDS; do
  COMMAND="$(/bin/ps -p "$PID" -o command= 2>/dev/null || true)"
  case "$COMMAND" in
    *"$ROOT/src/cli.mjs inject"*)
      /bin/kill -TERM "$PID"
      ;;
  esac
done

for _ in $(/usr/bin/seq 1 20); do
  STILL_RUNNING=false
  for PID in $PIDS; do
    if /bin/kill -0 "$PID" 2>/dev/null; then
      STILL_RUNNING=true
      break
    fi
  done
  [ "$STILL_RUNNING" = false ] && break
  /bin/sleep 0.25
done
if [ "${STILL_RUNNING:-false}" = true ]; then
  printf 'The Token Meter injector did not stop cleanly; no force-kill was attempted.\n' >&2
  exit 1
fi

"$NODE" "$ROOT/src/cli.mjs" remove --cdp-port "$PORT"

if [ "$RESTART_CODEX" = true ]; then
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
  for _ in $(/usr/bin/seq 1 60); do
    /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1 || break
    /bin/sleep 0.25
  done
  if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
    printf 'Codex did not quit cleanly; no force-quit was attempted.\n' >&2
    exit 1
  fi
  /usr/bin/open -a "$APP_PATH"
fi
