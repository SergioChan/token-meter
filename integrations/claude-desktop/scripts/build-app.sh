#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
OUTPUT=""
SIGN_IDENTITY="${TOKEN_METER_CODESIGN_IDENTITY:--}"

usage() {
  cat <<'EOF'
Usage: build-app.sh --output PATH [--sign-identity IDENTITY]

Build the native Token Meter companion as a background macOS application.
The default signature is ad hoc; set TOKEN_METER_CODESIGN_IDENTITY or pass
--sign-identity to use a stable local signing identity.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="${2:-}"
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

if [ -z "$OUTPUT" ] || [ "${OUTPUT#/}" = "$OUTPUT" ]; then
  printf 'An absolute --output path is required.\n' >&2
  exit 2
fi
if [ -e "$OUTPUT" ] || [ -L "$OUTPUT" ]; then
  printf 'Refusing to replace an existing build output: %s\n' "$OUTPUT" >&2
  exit 1
fi
if [ -z "$SIGN_IDENTITY" ]; then
  printf 'The signing identity is invalid.\n' >&2
  exit 2
fi
case "$SIGN_IDENTITY" in
  *$'\r'*|*$'\n'*)
    printf 'The signing identity is invalid.\n' >&2
    exit 2
    ;;
esac

STAGING="$OUTPUT.building.$$"
cleanup() {
  /bin/rm -rf "$STAGING"
}
trap cleanup EXIT

/bin/mkdir -p "$STAGING/Contents/MacOS"
/usr/bin/swiftc \
  "$ROOT/integrations/claude-desktop/native/TokenMeterClaudeOverlay.swift" \
  -O \
  -whole-module-optimization \
  -framework AppKit \
  -framework ApplicationServices \
  -framework WebKit \
  -o "$STAGING/Contents/MacOS/TokenMeterClaudeOverlay"
/usr/bin/install -m 600 \
  "$ROOT/integrations/claude-desktop/native/Info.plist" \
  "$STAGING/Contents/Info.plist"
/usr/bin/plutil -lint "$STAGING/Contents/Info.plist" >/dev/null
/usr/bin/codesign \
  --force \
  --sign "$SIGN_IDENTITY" \
  --timestamp=none \
  --identifier com.sergiochan.token-meter.claude-overlay \
  "$STAGING"
/usr/bin/codesign --verify --deep --strict "$STAGING"
/bin/mv "$STAGING" "$OUTPUT"
trap - EXIT

printf 'Built %s\n' "$OUTPUT"
