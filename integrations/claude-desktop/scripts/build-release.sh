#!/bin/bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
VERSION=""
BUILD_NUMBER="1"
ARCH="$(/usr/bin/uname -m)"
NODE_VERSION="v22.23.2"
NODE_ROOT=""
OUTPUT_DIR=""
SIGN_IDENTITY="${TOKEN_METER_CODESIGN_IDENTITY:-}"
NOTARY_PROFILE="${TOKEN_METER_NOTARY_PROFILE:-}"
AD_HOC=false

usage() {
  cat <<'EOF'
Usage: build-release.sh --version VERSION --output-dir PATH [options]

Build a self-contained Claude companion release asset.

Options:
  --build-number NUMBER    CFBundleVersion (default: 1)
  --arch ARCH              arm64 or x86_64 (default: host architecture)
  --node-version VERSION   Official Node.js release (default: v22.23.2)
  --node-root PATH         Use an already extracted Node.js distribution
  --sign-identity NAME     Developer ID Application identity
  --notary-profile NAME    notarytool Keychain profile
  --ad-hoc                 Development-only build without notarization
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --node-version)
      NODE_VERSION="${2:-}"
      shift 2
      ;;
    --node-root)
      NODE_ROOT="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="${2:-}"
      shift 2
      ;;
    --notary-profile)
      NOTARY_PROFILE="${2:-}"
      shift 2
      ;;
    --ad-hoc)
      AD_HOC=true
      SIGN_IDENTITY="-"
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

case "$VERSION" in
  ''|*[!0-9A-Za-z.-]*)
    printf 'A valid --version is required.\n' >&2
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
  arm64|x86_64) ;;
  *)
    printf 'Unsupported architecture: %s\n' "$ARCH" >&2
    exit 2
    ;;
esac
case "$NODE_VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    printf 'The Node.js version is invalid: %s\n' "$NODE_VERSION" >&2
    exit 2
    ;;
esac
if [ -z "$OUTPUT_DIR" ] || [ "${OUTPUT_DIR#/}" = "$OUTPUT_DIR" ]; then
  printf 'An absolute --output-dir is required.\n' >&2
  exit 2
fi
if [ "$AD_HOC" = false ] && [ -z "$SIGN_IDENTITY" ]; then
  printf 'A Developer ID Application signing identity is required.\n' >&2
  exit 2
fi

/bin/mkdir -p "$OUTPUT_DIR"
WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/token-meter-release.XXXXXX")"
cleanup() {
  /bin/rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "$NODE_ROOT" ]; then
  NODE_ARCHIVE="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
  NODE_BASE_URL="https://nodejs.org/dist/$NODE_VERSION"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$WORK/$NODE_ARCHIVE" "$NODE_BASE_URL/$NODE_ARCHIVE"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$WORK/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"
  EXPECTED_NODE_SHA="$(/usr/bin/awk -v file="$NODE_ARCHIVE" '$2 == file { print $1; exit }' \
    "$WORK/SHASUMS256.txt")"
  if [ -z "$EXPECTED_NODE_SHA" ]; then
    printf 'The official Node.js checksum is missing for %s.\n' "$NODE_ARCHIVE" >&2
    exit 1
  fi
  ACTUAL_NODE_SHA="$(/usr/bin/shasum -a 256 "$WORK/$NODE_ARCHIVE" | /usr/bin/awk '{print $1}')"
  if [ "$ACTUAL_NODE_SHA" != "$EXPECTED_NODE_SHA" ]; then
    printf 'The downloaded Node.js archive failed checksum verification.\n' >&2
    exit 1
  fi
  /usr/bin/tar -xzf "$WORK/$NODE_ARCHIVE" -C "$WORK"
  NODE_ROOT="$WORK/node-$NODE_VERSION-darwin-$ARCH"
fi
if [ "${NODE_ROOT#/}" = "$NODE_ROOT" ] || \
   [ ! -x "$NODE_ROOT/bin/node" ] || \
   [ ! -f "$NODE_ROOT/LICENSE" ]; then
  printf 'The Node.js distribution root is incomplete: %s\n' "$NODE_ROOT" >&2
  exit 1
fi
if ! /usr/bin/lipo -archs "$NODE_ROOT/bin/node" | /usr/bin/awk -v arch="$ARCH" '{ for (i=1;i<=NF;i++) if ($i==arch) found=1 } END { exit found ? 0 : 1 }'; then
  printf 'The Node.js runtime does not contain architecture %s.\n' "$ARCH" >&2
  exit 1
fi

APP="$WORK/Token Meter for Claude.app"
BUILD_ARGUMENTS=(
  --output "$APP"
  --sign-identity "$SIGN_IDENTITY"
  --embed-runtime-root "$ROOT"
  --embed-node-root "$NODE_ROOT"
  --version "$VERSION"
  --build-number "$BUILD_NUMBER"
  --arch "$ARCH"
)
if [ "$AD_HOC" = false ]; then
  BUILD_ARGUMENTS+=( --distribution )
fi
"$ROOT/integrations/claude-desktop/scripts/build-app.sh" "${BUILD_ARGUMENTS[@]}"

ASSET_NAME="token-meter-claude-macos-$ARCH.zip"
ASSET="$OUTPUT_DIR/$ASSET_NAME"
METADATA="$OUTPUT_DIR/token-meter-claude-macos-$ARCH.json"
if [ -e "$ASSET" ] || [ -e "$METADATA" ]; then
  printf 'Refusing to overwrite an existing release asset for %s.\n' "$ARCH" >&2
  exit 1
fi
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ASSET"

NOTARIZED=false
if [ "$AD_HOC" = false ]; then
  if [ -n "$NOTARY_PROFILE" ]; then
    /usr/bin/xcrun notarytool submit "$ASSET" --keychain-profile "$NOTARY_PROFILE" --wait
  elif [ -n "${APPLE_NOTARY_KEY_FILE:-}" ] && \
       [ -n "${APPLE_NOTARY_KEY_ID:-}" ] && \
       [ -n "${APPLE_NOTARY_ISSUER_ID:-}" ]; then
    /usr/bin/xcrun notarytool submit "$ASSET" \
      --key "$APPLE_NOTARY_KEY_FILE" \
      --key-id "$APPLE_NOTARY_KEY_ID" \
      --issuer "$APPLE_NOTARY_ISSUER_ID" \
      --wait
  else
    printf 'Notarization credentials are required for a distribution build.\n' >&2
    exit 1
  fi
  /usr/bin/xcrun stapler staple "$APP"
  /usr/bin/xcrun stapler validate "$APP"
  /bin/rm -f "$ASSET"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ASSET"
  /usr/sbin/spctl --assess --type execute --verbose=4 "$APP"
  NOTARIZED=true
fi

/usr/bin/codesign --verify --deep --strict "$APP"
ASSET_SHA="$(/usr/bin/shasum -a 256 "$ASSET" | /usr/bin/awk '{print $1}')"
printf '{"version":"%s","architecture":"%s","nodeVersion":"%s","sha256":"%s","notarized":%s}\n' \
  "$VERSION" "$ARCH" "$NODE_VERSION" "$ASSET_SHA" "$NOTARIZED" > "$METADATA"
printf 'Built %s\n' "$ASSET"
printf 'SHA-256 %s\n' "$ASSET_SHA"
