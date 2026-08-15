#!/bin/bash
# Builds the self-contained "Token Widget.app" (prebuilt overlay + payload +
# embedded Node) and a styled drag-to-Applications DMG. Requires a Developer ID
# identity in TOKEN_METER_CODESIGN_IDENTITY; TOKEN_METER_NOTARIZE=1 notarizes.
# The DMG window layout is applied through Finder, so the build host must grant
# this shell Automation access to Finder (prompted once, first run).
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

# DMG window layout. Keep in sync with scripts/make-dmg-background.py.
WIN_W=660
WIN_H=400
ICON_SIZE=128
ICON_X=180
APPS_X=480
ICON_Y=228

STAGE="$DIST/dmg-stage"
/bin/rm -rf "$STAGE"
/bin/mkdir -p "$STAGE/.background"
/bin/cp -R "$APP" "$STAGE/Token Widget.app"
/bin/ln -s /Applications "$STAGE/Applications"

# Finder picks the @2x representation on Retina displays, so ship both in one TIFF.
BG="$ROOT/assets/dmg/background.png"
[ -f "$BG" ] || python3 "$ROOT/scripts/make-dmg-background.py"
/usr/bin/tiffutil -cathidpicheck "$BG" "$ROOT/assets/dmg/background@2x.png" \
  -out "$STAGE/.background/background.tiff" >/dev/null

# Style a read-write image first: the icon layout, window size and background
# only persist once Finder writes them into the volume's .DS_Store.
RW="$DIST/.TokenWidget-rw.dmg"
/bin/rm -f "$RW"
STAGE_KB="$(/usr/bin/du -sk "$STAGE" | /usr/bin/awk '{print $1}')"
/usr/bin/hdiutil create -volname "Token Widget" -srcfolder "$STAGE" -ov \
  -format UDRW -fs HFS+ -size "$(( STAGE_KB / 1024 + 60 ))m" "$RW" >/dev/null

MOUNT="$(/usr/bin/hdiutil attach -readwrite -noverify -noautoopen "$RW" \
  | /usr/bin/awk -F'\t' '/\/Volumes\//{print $NF}')"
trap '/usr/bin/hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true' EXIT
# Not necessarily "Token Widget": Finder appends a suffix when a volume of that
# name is already mounted, and styling the wrong disk fails or corrupts it.
VOL="$(/usr/bin/basename "$MOUNT")"

# Needs Automation permission for Finder; macOS prompts once on the build host.
/usr/bin/osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, $(( 200 + WIN_W )), $(( 120 + WIN_H ))}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to $ICON_SIZE
    set text size of opts to 13
    set background picture of opts to file ".background:background.tiff"
    set position of item "Token Widget.app" of container window to {$ICON_X, $ICON_Y}
    set position of item "Applications" of container window to {$APPS_X, $ICON_Y}
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT

/bin/sync
/usr/bin/hdiutil detach "$MOUNT" >/dev/null
trap - EXIT

DMG="$DIST/TokenWidget-$VERSION.dmg"
/bin/rm -f "$DMG"
/usr/bin/hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
/bin/rm -f "$RW"
/usr/bin/codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "${TOKEN_METER_NOTARIZE:-}" = "1" ]; then
  echo "Notarizing DMG..."
  /usr/bin/xcrun notarytool submit "$DMG" --keychain-profile token-meter --wait
  /usr/bin/xcrun stapler staple "$DMG"
fi
/bin/rm -rf "$STAGE"
printf 'Built %s\n' "$DMG"
