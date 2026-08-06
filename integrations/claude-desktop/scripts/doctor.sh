#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
# shellcheck source=./runtime-selection.sh
source "$ROOT/integrations/claude-desktop/scripts/runtime-selection.sh"

JSON=false
NODE_PATH="${TOKEN_METER_NODE:-}"

usage() {
  cat <<'EOF'
Usage: doctor.sh [--json] [--node PATH]

Check prerequisites for building the Claude Desktop companion from source.
Token Meter does not publish a prebuilt Claude companion.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      JSON=true
      shift
      ;;
    --node)
      NODE_PATH="${2:-}"
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

MACOS_SUPPORTED=false
XCODE_TOOLS=false
SWIFT_COMPILER=false
CODE_SIGNING_TOOLS=false
GIT_AVAILABLE=false
NODE_COMPATIBLE=false
RESOLVED_NODE=""

if [ "$(/usr/bin/uname -s)" = Darwin ]; then
  MACOS_MAJOR="$(/usr/bin/sw_vers -productVersion | /usr/bin/cut -d. -f1)"
  case "$MACOS_MAJOR" in
    ''|*[!0-9]*) ;;
    *) [ "$MACOS_MAJOR" -ge 13 ] && MACOS_SUPPORTED=true ;;
  esac
fi
if /usr/bin/xcode-select -p >/dev/null 2>&1; then XCODE_TOOLS=true; fi
if [ -x /usr/bin/swiftc ]; then SWIFT_COMPILER=true; fi
if [ -x /usr/bin/codesign ] && [ -x /usr/bin/plutil ]; then CODE_SIGNING_TOOLS=true; fi
if [ -x /usr/bin/git ]; then GIT_AVAILABLE=true; fi
if RESOLVED_NODE="$(token_meter_resolve_node "$NODE_PATH" 2>/dev/null)"; then
  NODE_COMPATIBLE=true
fi

READY=false
if [ "$MACOS_SUPPORTED" = true ] && \
   [ "$XCODE_TOOLS" = true ] && \
   [ "$SWIFT_COMPILER" = true ] && \
   [ "$CODE_SIGNING_TOOLS" = true ] && \
   [ "$GIT_AVAILABLE" = true ] && \
   [ "$NODE_COMPATIBLE" = true ]; then
  READY=true
fi

if [ "$JSON" = true ]; then
  SAFE_NODE="$(printf '%s' "$RESOLVED_NODE" | /usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"macosSupported":%s,"xcodeCommandLineTools":%s,"swiftCompiler":%s,"codeSigningTools":%s,"gitAvailable":%s,"nodeCompatible":%s,"nodePath":"%s","readyForSourceInstall":%s}\n' \
    "$MACOS_SUPPORTED" "$XCODE_TOOLS" "$SWIFT_COMPILER" "$CODE_SIGNING_TOOLS" \
    "$GIT_AVAILABLE" "$NODE_COMPATIBLE" "$SAFE_NODE" "$READY"
else
  printf 'macOS 13 or newer: %s\n' "$MACOS_SUPPORTED"
  printf 'Xcode Command Line Tools: %s\n' "$XCODE_TOOLS"
  printf 'Swift compiler: %s\n' "$SWIFT_COMPILER"
  printf 'Code-signing tools: %s\n' "$CODE_SIGNING_TOOLS"
  printf 'Git: %s\n' "$GIT_AVAILABLE"
  printf 'Node.js 22.12 or newer: %s' "$NODE_COMPATIBLE"
  [ -n "$RESOLVED_NODE" ] && printf ' (%s)' "$RESOLVED_NODE"
  printf '\nReady for source install: %s\n' "$READY"
fi

[ "$READY" = true ]
