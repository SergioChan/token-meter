#!/bin/bash

token_meter_node_version_is_compatible() {
  if [ "$#" -ne 1 ]; then return 2; fi
  local version="${1#v}"
  local major="${version%%.*}"
  local remainder="${version#*.}"
  [ "$remainder" != "$version" ] || return 1
  local minor="${remainder%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}

token_meter_node_is_compatible() {
  if [ "$#" -ne 1 ]; then return 2; fi
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  [ "${candidate#/}" != "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  local version
  version="$("$candidate" --version 2>/dev/null)" || return 1
  token_meter_node_version_is_compatible "$version" || return 1
  "$candidate" -e '
    import("node:sqlite").then(
      ({ DatabaseSync }) => process.exit(typeof DatabaseSync === "function" ? 0 : 1),
      () => process.exit(1),
    );
  ' >/dev/null 2>&1
}

token_meter_find_compatible_node() {
  local candidates="${TOKEN_METER_NODE_CANDIDATES:-}"
  if [ -z "$candidates" ]; then
    local path_node
    path_node="$(command -v node 2>/dev/null || true)"
    candidates="/opt/homebrew/bin/node:$path_node:/usr/local/bin/node:/usr/bin/node"
    local nvm_node
    for nvm_node in "$HOME"/.nvm/versions/node/*/bin/node; do
      [ -e "$nvm_node" ] || continue
      candidates="$candidates:$nvm_node"
    done
  fi

  local previous_ifs="$IFS"
  IFS=:
  local candidate
  local seen=":"
  for candidate in $candidates; do
    [ -n "$candidate" ] || continue
    case "$seen" in
      *:"$candidate":*) continue ;;
    esac
    seen="$seen$candidate:"
    if token_meter_node_is_compatible "$candidate"; then
      printf '%s\n' "$candidate"
      IFS="$previous_ifs"
      return 0
    fi
  done
  IFS="$previous_ifs"
  return 1
}

token_meter_resolve_node() {
  if [ "$#" -ne 1 ]; then return 2; fi
  local explicit="$1"
  if [ -n "$explicit" ]; then
    if token_meter_node_is_compatible "$explicit"; then
      printf '%s\n' "$explicit"
      return 0
    fi
    printf 'Node.js 22.13 or newer with node:sqlite is required: %s\n' "$explicit" >&2
    return 1
  fi

  local selected
  selected="$(token_meter_find_compatible_node || true)"
  if [ -z "$selected" ]; then
    printf 'Node.js 22.13 or newer with node:sqlite was not found. Run the Claude source-install doctor for details.\n' >&2
    return 1
  fi
  printf '%s\n' "$selected"
}
