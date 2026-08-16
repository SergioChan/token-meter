#!/bin/bash
# Builds a downloadable macOS bundle: source tree plus double-click installer.
# Output: dist/token-meter-<version>-macos.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
DIST="$ROOT/dist"
STAGE="$DIST/TokenWidget"

/bin/rm -rf "$STAGE"
/bin/mkdir -p "$STAGE/token-meter"

/usr/bin/rsync -a \
  --exclude ".git" \
  --exclude ".commons" \
  --exclude "dist" \
  --exclude "node_modules" \
  --exclude "web/__harness.html" \
  "$ROOT/" "$STAGE/token-meter/"

/bin/cat > "$STAGE/Install Token Widget.command" <<'INSTALL'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/token-meter"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; printf '%s\n' "${2:-}"; read -r -p "Press Return to close..." _; exit 1; }

bold "Token Widget installer"
echo "Checks prerequisites, then builds and installs the Claude Desktop overlay."
echo

sw_vers -productVersion | awk -F. '{ exit ($1 < 13) }' \
  || fail "macOS 13 or newer is required." "You are on $(sw_vers -productVersion)."

xcode-select -p >/dev/null 2>&1 \
  || fail "Xcode Command Line Tools are required." "Run:  xcode-select --install   then re-run this installer."

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22.12+ is required." "Install with:  brew install node   (or https://nodejs.org) then re-run."
fi
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 12) ? 0 : 1)' \
  || fail "Node.js 22.12+ is required (found $(node --version))." "Upgrade with:  brew upgrade node   or via nvm."

echo "Prerequisites OK (Node $(node --version)). Building — this takes about a minute..."
echo
npm run claude:install

echo
bold "Installed!"
echo "Final step (one time): System Settings > Privacy & Security > Accessibility"
echo "  -> enable 'Token Widget' (add it with + from"
echo "     ~/Library/Application Support/Token Meter/Claude Desktop/ if missing)."
echo
echo "Then focus a Claude Code session in Claude Desktop and the meter appears."
echo "Click the meter's @handle any time to open your usage dashboard."
read -r -p "Press Return to close..." _
INSTALL

/bin/cat > "$STAGE/Uninstall Token Widget.command" <<'UNINSTALL'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/token-meter"
npm run claude:uninstall
echo "Token Widget removed."
read -r -p "Press Return to close..." _
UNINSTALL

/bin/cat > "$STAGE/README FIRST.txt" <<'README'
Token Widget (internal test build)

1. Double-click "Install Token Widget.command".
   If macOS blocks it (unidentified developer), right-click it and choose
   Open, then Open again. This build is not yet notarized.
2. Follow the prompts; grant Accessibility permission when asked.
3. Keep this folder if you plan to run the uninstaller later; the installed
   app itself is copied to ~/Library/Application Support/Token Meter/.

Privacy: everything is computed locally from your own transcript files.
Nothing leaves your machine unless you turn sharing on in the meter settings.
README

/bin/chmod +x "$STAGE/Install Token Widget.command" "$STAGE/Uninstall Token Widget.command"

# With a Developer ID identity, wrap everything in a signed, notarized
# double-click installer app; plain scripts cannot carry notarization tickets.
if [[ "${TOKEN_METER_CODESIGN_IDENTITY:-}" == "Developer ID"* ]]; then
  APP="$STAGE/Install Token Widget.app"
  /usr/bin/osacompile -o "$APP" -e '
    set cmd to quoted form of (POSIX path of (path to me) & "Contents/Resources/payload/Install Token Widget.command")
    tell application "Terminal"
      activate
      do script "bash " & cmd
    end tell'
  /bin/mkdir -p "$APP/Contents/Resources/payload"
  /bin/mv "$STAGE/token-meter" "$STAGE/Install Token Widget.command" "$STAGE/Uninstall Token Widget.command" "$APP/Contents/Resources/payload/"
  /usr/bin/plutil -replace NSAppleEventsUsageDescription -string "Token Meter opens Terminal to run its installer." "$APP/Contents/Info.plist"
  # Brand the applet with the Token Widget logo (osacompile ships a generic icon).
  /bin/cp "$ROOT/integrations/claude-desktop/native/AppIcon.icns" "$APP/Contents/Resources/applet.icns"
  ENT="$DIST/.entitlements.plist"
  /bin/cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>
PLIST
  /usr/bin/codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$TOKEN_METER_CODESIGN_IDENTITY" "$APP"
  /bin/rm -f "$ENT"
fi

ZIP="$DIST/token-widget-$VERSION-macos.zip"
/bin/rm -f "$ZIP"
(cd "$DIST" && /usr/bin/zip -qry "$ZIP" "TokenWidget")

if [[ "${TOKEN_METER_CODESIGN_IDENTITY:-}" == "Developer ID"* && "${TOKEN_METER_NOTARIZE:-}" == "1" ]]; then
  printf 'Notarizing...\n'
  /usr/bin/xcrun notarytool submit "$ZIP" --keychain-profile token-meter --wait
  /usr/bin/xcrun stapler staple "$STAGE/Install Token Widget.app"
  /bin/rm -f "$ZIP"
  (cd "$DIST" && /usr/bin/zip -qry "$ZIP" "TokenWidget")
fi
/bin/rm -rf "$STAGE"
printf 'Built %s\n' "$ZIP"
