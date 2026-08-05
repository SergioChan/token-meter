#!/bin/bash
set -uo pipefail

ROOT=""
PORT=9334
APP_PATH="/Applications/ChatGPT.app"
STOPPING=false
INJECTOR_PID=""
HANDLED_PID=""
LAST_STATE=""

usage() {
  cat <<'EOF'
Usage: token-meter-service-macos.sh --root PATH [--app-path PATH] [--port PORT]

Run the persistent per-user Token Meter controller. This script is intended to
be managed by launchd; use install-token-meter-macos.sh instead of invoking it
directly.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --app-path)
      APP_PATH="${2:-}"
      shift 2
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

if [ -z "$ROOT" ] || [ "${ROOT#/}" = "$ROOT" ]; then
  printf 'A canonical absolute --root path is required.\n' >&2
  exit 2
fi
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
if [ ! -f "$ROOT/src/cli.mjs" ] || [ ! -f "$ROOT/scripts/macos-codex-processes.sh" ]; then
  printf 'Token Meter installation is incomplete at %s\n' "$ROOT" >&2
  exit 1
fi

# shellcheck source=./macos-codex-processes.sh
source "$ROOT/scripts/macos-codex-processes.sh"

timestamp() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

set_state() {
  local state="$1"
  shift
  if [ "$LAST_STATE" != "$state" ]; then
    LAST_STATE="$state"
    log "$*"
  fi
}

endpoint_ready() {
  /usr/bin/curl --silent --fail --max-time 1 \
    "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

port_listening() {
  /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

stop_service() {
  STOPPING=true
  if [ -n "$INJECTOR_PID" ] && /bin/kill -0 "$INJECTOR_PID" 2>/dev/null; then
    /bin/kill -TERM "$INJECTOR_PID" 2>/dev/null || true
  fi
}
trap stop_service INT TERM

while [ "$STOPPING" = false ]; do
  if endpoint_ready; then
    NODE="$("$ROOT/scripts/verify-codex-app-macos.sh" "$APP_PATH")"
    if [ "$?" -ne 0 ] || [ -z "$NODE" ]; then
      set_state "verification-failed" \
        "Codex verification failed; Token Meter is waiting without injecting."
      /bin/sleep 30
      continue
    fi

    set_state "attached" "Attaching Token Meter to verified Codex on 127.0.0.1:$PORT."
    "$NODE" "$ROOT/src/cli.mjs" inject --cdp-port "$PORT" &
    INJECTOR_PID="$!"
    wait "$INJECTOR_PID"
    INJECTOR_STATUS="$?"
    INJECTOR_PID=""
    if [ "$STOPPING" = true ]; then
      break
    fi
    set_state "injector-exited" \
      "Injector exited with status $INJECTOR_STATUS; waiting for the endpoint to change."
    while [ "$STOPPING" = false ] && endpoint_ready; do
      /bin/sleep 5
    done
    continue
  fi

  if port_listening; then
    set_state "port-occupied" \
      "Port $PORT is occupied without a valid CDP endpoint; refusing to restart or inject."
    /bin/sleep 5
    continue
  fi

  CURRENT_PID="$(codex_main_pid "$APP_PATH" 2>/dev/null || true)"
  if [ -z "$CURRENT_PID" ]; then
    HANDLED_PID=""
    set_state "waiting-for-codex" "Waiting for Codex to launch."
    /bin/sleep 1
    continue
  fi

  if [ "$CURRENT_PID" = "$HANDLED_PID" ]; then
    set_state "recovery-exhausted-$CURRENT_PID" \
      "Codex PID $CURRENT_PID still lacks CDP after one recovery attempt; no retry will be made for this process."
    /bin/sleep 5
    continue
  fi

  HANDLED_PID="$CURRENT_PID"
  NODE="$("$ROOT/scripts/verify-codex-app-macos.sh" "$APP_PATH")"
  if [ "$?" -ne 0 ] || [ -z "$NODE" ]; then
    set_state "verification-failed-$CURRENT_PID" \
      "Codex verification failed; refusing to relaunch PID $CURRENT_PID."
    /bin/sleep 30
    continue
  fi

  set_state "recovering-$CURRENT_PID" \
    "Codex PID $CURRENT_PID lacks the loopback endpoint; performing one normal quit and relaunch."
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  if ! wait_for_codex_exit "$APP_PATH" 160 0.25; then
    set_state "quit-failed-$CURRENT_PID" \
      "Codex did not quit cleanly; no force-quit or relaunch was attempted."
    /bin/sleep 5
    continue
  fi
  if port_listening; then
    set_state "port-occupied-after-quit" \
      "Port $PORT became occupied; refusing to launch Codex with debugging enabled."
    /bin/sleep 5
    continue
  fi

  /usr/bin/open -na "$APP_PATH" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$PORT"

  ENDPOINT_STARTED=false
  for _ in $(/usr/bin/seq 1 160); do
    if [ "$STOPPING" = true ]; then
      break
    fi
    NEW_PID="$(codex_main_pid "$APP_PATH" 2>/dev/null || true)"
    if [ -n "$NEW_PID" ]; then
      HANDLED_PID="$NEW_PID"
    fi
    if endpoint_ready; then
      ENDPOINT_STARTED=true
      break
    fi
    /bin/sleep 0.25
  done
  if [ "$ENDPOINT_STARTED" = false ] && [ "$STOPPING" = false ]; then
    set_state "launch-failed-${HANDLED_PID:-unknown}" \
      "Codex did not expose CDP after the single relaunch; no further retry will be made for this process."
    /bin/sleep 5
  fi
done

log "Token Meter service stopped."
