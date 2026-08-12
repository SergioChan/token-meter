#!/bin/bash

codex_executable_path() {
  local app_path="$1"
  local executable
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \
    "$app_path/Contents/Info.plist" 2>/dev/null)" || return 1
  printf '%s/Contents/MacOS/%s\n' "$app_path" "$executable"
}

codex_main_pid() {
  local app_path="$1"
  local executable_path
  executable_path="$(codex_executable_path "$app_path")" || return 1
  /bin/ps -axo pid=,command= | /usr/bin/awk -v executable="$executable_path" '
    {
      pid = $1
      $1 = ""
      sub(/^[[:space:]]+/, "")
      if ($0 == executable || index($0, executable " ") == 1) {
        print pid
        exit
      }
    }
  '
}

codex_main_process_running() {
  local app_path="$1"
  [ -n "$(codex_main_pid "$app_path" 2>/dev/null || true)" ]
}

wait_for_codex_exit() {
  local app_path="$1"
  local attempts="${2:-120}"
  local delay_seconds="${3:-0.25}"
  local attempt
  for attempt in $(/usr/bin/seq 1 "$attempts"); do
    if ! codex_main_process_running "$app_path"; then
      return 0
    fi
    /bin/sleep "$delay_seconds"
  done
  return 1
}
