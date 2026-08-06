#!/bin/bash

TOKEN_METER_INSTALL_MARKER=".token-meter-installation"

token_meter_require_absolute_path() {
  if [ "$#" -ne 2 ]; then return 2; fi
  local name="$1"
  local value="$2"
  if [ -z "$value" ] || [ "${value#/}" = "$value" ]; then
    printf '%s must be an absolute path: %s\n' "$name" "${value:-<empty>}" >&2
    return 2
  fi
  case "$value" in
    *$'\r'*|*$'\n'*|*/../*|*/..|*/./*|*/.)
      printf '%s contains unsafe path components.\n' "$name" >&2
      return 2
      ;;
  esac
}

token_meter_assert_no_symlinked_ancestor() {
  if [ "$#" -ne 2 ]; then return 2; fi
  local name="$1"
  local current="$2"
  while [ "$current" != "/" ]; do
    if [ -L "$current" ]; then
      case "$current" in
        /var|/tmp|/etc)
          ;;
        *)
          printf '%s has a symlinked ancestor: %s\n' "$name" "$current" >&2
          return 1
          ;;
      esac
    fi
    current="$(/usr/bin/dirname "$current")"
  done
}

token_meter_assert_safe_recursive_root() {
  if [ "$#" -ne 2 ]; then return 2; fi
  local name="$1"
  local value="$2"
  token_meter_require_absolute_path "$name" "$value" || return
  token_meter_assert_no_symlinked_ancestor "$name" "$value" || return

  local home="${HOME%/}"
  case "$value" in
    /|"$home"|"$home/Library"|"$home/Library/Application Support"|"$home/Library/Logs"|"$home/Library/LaunchAgents")
      printf 'Refusing unsafe removal root for %s: %s\n' "$name" "$value" >&2
      return 1
      ;;
  esac
  case "$home/" in
    "$value/"*)
      printf 'Refusing a removal root that contains HOME for %s: %s\n' "$name" "$value" >&2
      return 1
      ;;
  esac
}

token_meter_assert_disjoint_roots() {
  local left_name="$1"
  local left="$2"
  local right_name="$3"
  local right="$4"
  if [ "$left" = "$right" ]; then
    printf '%s and %s must not use the same directory: %s\n' \
      "$left_name" "$right_name" "$left" >&2
    return 1
  fi
  case "$left/" in
    "$right/"*)
      printf '%s must not contain %s: %s\n' "$right_name" "$left_name" "$right" >&2
      return 1
      ;;
  esac
  case "$right/" in
    "$left/"*)
      printf '%s must not contain %s: %s\n' "$left_name" "$right_name" "$left" >&2
      return 1
      ;;
  esac
}

token_meter_mark_installation_directory() {
  if [ "$#" -ne 2 ]; then return 2; fi
  local directory="$1"
  local label="$2"
  /usr/bin/install -m 600 /dev/null "$directory/$TOKEN_METER_INSTALL_MARKER"
  printf '%s\n' "$label" > "$directory/$TOKEN_METER_INSTALL_MARKER"
}

token_meter_directory_has_installation_marker() {
  if [ "$#" -ne 2 ]; then return 2; fi
  local directory="$1"
  local label="$2"
  [ -f "$directory/$TOKEN_METER_INSTALL_MARKER" ] || return 1
  [ "$(/usr/bin/tr -d '\r\n' < "$directory/$TOKEN_METER_INSTALL_MARKER")" = "$label" ]
}

token_meter_remove_managed_directory() {
  if [ "$#" -ne 3 ]; then return 2; fi
  local name="$1"
  local directory="$2"
  local label="$3"
  [ -e "$directory" ] || return 0
  token_meter_assert_safe_recursive_root "$name" "$directory" || return
  if ! token_meter_directory_has_installation_marker "$directory" "$label"; then
    printf 'Refusing to remove an unmarked %s directory: %s\n' "$name" "$directory" >&2
    return 1
  fi
  /bin/rm -rf "$directory"
}
