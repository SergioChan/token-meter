#!/bin/bash

token_meter_command_matches_executable() {
  if [ "$#" -ne 2 ]; then
    return 2
  fi
  local command="$1"
  local executable="$2"
  case "$command" in
    "$executable"|"$executable "*) return 0 ;;
    *) return 1 ;;
  esac
}

token_meter_process_matches_executable() {
  if [ "$#" -ne 2 ]; then
    return 2
  fi
  local pid="$1"
  local executable="$2"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  token_meter_command_matches_executable "$command" "$executable"
}
