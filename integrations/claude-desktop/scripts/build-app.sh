#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
OUTPUT=""
SIGN_IDENTITY="${TOKEN_METER_CODESIGN_IDENTITY:--}"
EMBED_RUNTIME_ROOT=""
EMBED_NODE_ROOT=""
EMBED_NODE=""
EMBED_NODE_LICENSE=""
VERSION="$(/usr/bin/awk -F'"' '$2 == "version" { print $4; exit }' "$ROOT/package.json")"
BUILD_NUMBER="1"
ARCH=""
DISTRIBUTION=false

usage() {
  cat <<'EOF'
Usage: build-app.sh --output PATH [options]

Build the native Token Meter companion as a background macOS application.
The default signature is ad hoc; set TOKEN_METER_CODESIGN_IDENTITY or pass
--sign-identity to use a stable local signing identity.

Options:
  --embed-runtime-root PATH  Embed the Token Meter runtime for release use
  --embed-node-root PATH     Embed a portable Node.js distribution root
  --embed-node PATH          Embed a portable Node.js executable
  --embed-node-license PATH  Embed the matching Node.js license
  --version VERSION          Set CFBundleShortVersionString
  --build-number NUMBER      Set CFBundleVersion
  --arch ARCH                Build arm64 or x86_64
  --distribution             Enable Hardened Runtime and secure timestamp
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
    --embed-runtime-root)
      EMBED_RUNTIME_ROOT="${2:-}"
      shift 2
      ;;
    --embed-node)
      EMBED_NODE="${2:-}"
      shift 2
      ;;
    --embed-node-root)
      EMBED_NODE_ROOT="${2:-}"
      shift 2
      ;;
    --embed-node-license)
      EMBED_NODE_LICENSE="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --build-number)
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --distribution)
      DISTRIBUTION=true
      shift
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
case "$VERSION" in
  ''|*[!0-9A-Za-z.-]*)
    printf 'The version is invalid: %s\n' "$VERSION" >&2
    exit 2
    ;;
esac
case "$BUILD_NUMBER" in
  ''|*[!0-9]*)
    printf 'The build number must contain digits only.\n' >&2
    exit 2
    ;;
esac
case "$ARCH" in
  ''|arm64|x86_64) ;;
  *)
    printf 'Unsupported architecture: %s\n' "$ARCH" >&2
    exit 2
    ;;
esac
if [ -n "$EMBED_NODE_ROOT" ]; then
  if [ "${EMBED_NODE_ROOT#/}" = "$EMBED_NODE_ROOT" ] || \
     [ ! -x "$EMBED_NODE_ROOT/bin/node" ] || \
     [ ! -f "$EMBED_NODE_ROOT/LICENSE" ]; then
    printf 'The embedded Node.js distribution root is incomplete: %s\n' "$EMBED_NODE_ROOT" >&2
    exit 1
  fi
  if [ -n "$EMBED_NODE$EMBED_NODE_LICENSE" ]; then
    printf 'Use either --embed-node-root or the explicit Node.js paths, not both.\n' >&2
    exit 2
  fi
  EMBED_NODE="$EMBED_NODE_ROOT/bin/node"
  EMBED_NODE_LICENSE="$EMBED_NODE_ROOT/LICENSE"
fi
if [ -n "$EMBED_RUNTIME_ROOT$EMBED_NODE_ROOT$EMBED_NODE$EMBED_NODE_LICENSE" ]; then
  for value in "$EMBED_RUNTIME_ROOT" "$EMBED_NODE" "$EMBED_NODE_LICENSE"; do
    if [ -z "$value" ] || [ "${value#/}" = "$value" ]; then
      printf 'Embedded runtime, Node.js, and license paths must all be absolute.\n' >&2
      exit 2
    fi
  done
  if [ ! -d "$EMBED_RUNTIME_ROOT/src" ] || \
     [ ! -d "$EMBED_RUNTIME_ROOT/runtime" ] || \
     [ ! -d "$EMBED_RUNTIME_ROOT/integrations/claude-desktop/src" ]; then
    printf 'The embedded runtime root is incomplete: %s\n' "$EMBED_RUNTIME_ROOT" >&2
    exit 1
  fi
  if [ ! -x "$EMBED_NODE" ] || [ ! -f "$EMBED_NODE_LICENSE" ]; then
    printf 'The embedded Node.js executable or license is missing.\n' >&2
    exit 1
  fi
fi
if [ "$DISTRIBUTION" = true ] && [ "$SIGN_IDENTITY" = - ]; then
  printf 'Distribution builds require a non-ad-hoc signing identity.\n' >&2
  exit 2
fi

STAGING="$OUTPUT.building.$$"
cleanup() {
  /bin/rm -rf "$STAGING"
}
trap cleanup EXIT

/bin/mkdir -p "$STAGING/Contents/MacOS"
if [ -n "$ARCH" ]; then
  /usr/bin/swiftc \
    -target "$ARCH-apple-macosx13.0" \
    "$ROOT/integrations/claude-desktop/native/ClaudeAccessibility.swift" \
    "$ROOT/integrations/claude-desktop/native/ClaudeModelCatalog.swift" \
    "$ROOT/integrations/claude-desktop/native/TokenMeterClaudeOverlay.swift" \
    -O \
    -whole-module-optimization \
    -framework AppKit \
    -framework ApplicationServices \
    -framework WebKit \
    -o "$STAGING/Contents/MacOS/TokenMeterClaudeOverlay"
else
  /usr/bin/swiftc \
    "$ROOT/integrations/claude-desktop/native/ClaudeAccessibility.swift" \
    "$ROOT/integrations/claude-desktop/native/ClaudeModelCatalog.swift" \
    "$ROOT/integrations/claude-desktop/native/TokenMeterClaudeOverlay.swift" \
    -O \
    -whole-module-optimization \
    -framework AppKit \
    -framework ApplicationServices \
    -framework WebKit \
    -o "$STAGING/Contents/MacOS/TokenMeterClaudeOverlay"
fi
/usr/bin/install -m 600 \
  "$ROOT/integrations/claude-desktop/native/Info.plist" \
  "$STAGING/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" \
  "$STAGING/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" \
  "$STAGING/Contents/Info.plist"
/usr/bin/plutil -lint "$STAGING/Contents/Info.plist" >/dev/null

if [ -n "$EMBED_RUNTIME_ROOT" ]; then
  RUNTIME_DESTINATION="$STAGING/Contents/Resources/TokenMeterRuntime"
  NODE_DESTINATION="$STAGING/Contents/Resources/Node"
  /bin/mkdir -p \
    "$RUNTIME_DESTINATION/integrations/claude-desktop/scripts" \
    "$NODE_DESTINATION/bin"
  /bin/cp -R "$EMBED_RUNTIME_ROOT/src" "$RUNTIME_DESTINATION/src"
  /bin/cp -R "$EMBED_RUNTIME_ROOT/runtime" "$RUNTIME_DESTINATION/runtime"
  /bin/cp -R \
    "$EMBED_RUNTIME_ROOT/integrations/claude-desktop/src" \
    "$RUNTIME_DESTINATION/integrations/claude-desktop/src"
  /usr/bin/install -m 600 \
    "$EMBED_RUNTIME_ROOT/integrations/claude-desktop/scripts/render-launch-agent.mjs" \
    "$RUNTIME_DESTINATION/integrations/claude-desktop/scripts/render-launch-agent.mjs"
  /usr/bin/install -m 600 \
    "$EMBED_RUNTIME_ROOT/package.json" \
    "$RUNTIME_DESTINATION/package.json"
  /usr/bin/install -m 600 \
    "$EMBED_RUNTIME_ROOT/LICENSE" \
    "$RUNTIME_DESTINATION/LICENSE"
  /usr/bin/install -m 755 "$EMBED_NODE" "$NODE_DESTINATION/bin/node"
  /usr/bin/install -m 600 "$EMBED_NODE_LICENSE" "$NODE_DESTINATION/LICENSE"
  if [ -d "$EMBED_NODE_ROOT/lib" ]; then
    /bin/mkdir -p "$NODE_DESTINATION/lib"
    while IFS= read -r -d '' source_library; do
      /usr/bin/install -m 755 "$source_library" "$NODE_DESTINATION/lib/$(/usr/bin/basename "$source_library")"
    done < <(/usr/bin/find "$EMBED_NODE_ROOT/lib" -maxdepth 1 -type f -name '*.dylib' -print0)
  fi
  while IFS= read -r -d '' library; do
    if [ "$DISTRIBUTION" = true ]; then
      /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp \
        "$library"
    else
      /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp=none "$library"
    fi
  done < <(/usr/bin/find "$NODE_DESTINATION" -type f -name '*.dylib' -print0)
  if [ "$DISTRIBUTION" = true ]; then
    /usr/bin/codesign \
      --force \
      --sign "$SIGN_IDENTITY" \
      --options runtime \
      --timestamp \
      --entitlements "$ROOT/integrations/claude-desktop/native/Node.entitlements.plist" \
      "$NODE_DESTINATION/bin/node"
  else
    /usr/bin/codesign --force --sign "$SIGN_IDENTITY" --timestamp=none \
      "$NODE_DESTINATION/bin/node"
  fi
fi

if [ "$DISTRIBUTION" = true ]; then
  /usr/bin/codesign \
    --force \
    --sign "$SIGN_IDENTITY" \
    --options runtime \
    --timestamp \
    --identifier com.sergiochan.token-meter.claude-overlay \
    "$STAGING"
else
  /usr/bin/codesign \
    --force \
    --sign "$SIGN_IDENTITY" \
    --timestamp=none \
    --identifier com.sergiochan.token-meter.claude-overlay \
    "$STAGING"
fi
/usr/bin/codesign --verify --deep --strict "$STAGING"
/bin/mv "$STAGING" "$OUTPUT"
trap - EXIT

printf 'Built %s\n' "$OUTPUT"
