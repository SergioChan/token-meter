#!/bin/bash
# Builds the self-contained "Token Widget.app" (prebuilt overlay + payload +
# embedded Node) and a drag-to-Applications DMG. Requires a Developer ID
# identity in TOKEN_METER_CODESIGN_IDENTITY; TOKEN_METER_NOTARIZE=1 notarizes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DIST="$ROOT/dist"
NODE_VERSION="v22.22.0"
NODE_TAR="$DIST/node-$NODE_VERSION-darwin-arm64.tar.gz"
IDENTITY="${TOKEN_METER_CODESIGN_IDENTITY:?set TOKEN_METER_CODESIGN_IDENTITY}"

/bin/mkdir -p "$DIST"
if [ ! -f "$NODE_TAR" ]; then
  echo "Downloading Node $NODE_VERSION..."
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" -o "$NODE_TAR"
fi

APP="$DIST/Token Widget.app"
/bin/rm -rf "$APP"
"$ROOT/integrations/claude-desktop/scripts/build-app.sh" --output "$APP" 2>/dev/null \
  || TOKEN_METER_CODESIGN_IDENTITY="$IDENTITY" "$ROOT/integrations/claude-desktop/scripts/build-app.sh" --output "$APP"

RES="$APP/Contents/Resources"
/bin/mkdir -p "$RES/root" "$RES/node"
for part in src runtime integrations web package.json LICENSE; do
  /bin/cp -R "$ROOT/$part" "$RES/root/$part"
done
/usr/bin/tar -xzf "$NODE_TAR" -C "$RES/node" --strip-components 1
/bin/rm -rf "$RES/node/lib/node_modules/npm" "$RES/node/bin/npm" "$RES/node/bin/npx" "$RES/node/bin/corepack" "$RES/node/share" "$RES/node/include"

ENT="$DIST/.node-entitlements.plist"
/bin/cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST
/usr/bin/codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$IDENTITY" "$RES/node/bin/node"
/usr/bin/codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
/bin/rm -f "$ENT"
/usr/bin/codesign --verify --strict "$APP"

STAGE="$DIST/dmg-stage"
/bin/rm -rf "$STAGE"
/bin/mkdir -p "$STAGE"
/bin/cp -R "$APP" "$STAGE/Token Widget.app"
/bin/ln -s /Applications "$STAGE/Applications"
DMG="$DIST/TokenWidget-$VERSION.dmg"
/bin/rm -f "$DMG"
/usr/bin/hdiutil create -volname "Token Widget" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
/usr/bin/codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "${TOKEN_METER_NOTARIZE:-}" = "1" ]; then
  echo "Notarizing DMG..."
  /usr/bin/xcrun notarytool submit "$DMG" --keychain-profile token-meter --wait
  /usr/bin/xcrun stapler staple "$DMG"
fi
/bin/rm -rf "$STAGE"
printf 'Built %s\n' "$DMG"
