#!/bin/bash
# Token Widget source installer. It builds the local companion on the user's
# Mac and does not modify or restart Claude Desktop.
set -euo pipefail

REPOSITORY="https://github.com/SergioChan/token-meter.git"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n%s\n' "$1" "${2:-}"; exit 1; }

bold "Token Widget installer"

sw_vers -productVersion | awk -F. '{ exit ($1 < 13) }' \
  || fail "macOS 13 or newer is required." "You are on $(sw_vers -productVersion)."
xcode-select -p >/dev/null 2>&1 \
  || fail "Xcode Command Line Tools are required." "Run:  xcode-select --install   then re-run this installer."
command -v node >/dev/null 2>&1 \
  || fail "Node.js 22.12+ is required." "Install with:  brew install node   (or https://nodejs.org) then re-run."
command -v git >/dev/null 2>&1 \
  || fail "Git is required." "Install the Xcode Command Line Tools, then re-run this installer."
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 12) ? 0 : 1)' \
  || fail "Node.js 22.12+ is required (found $(node --version))." "Upgrade with:  brew upgrade node   or via nvm."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading the Token Widget source..."
git clone --depth 1 "$REPOSITORY" "$TMP/token-meter"
cd "$TMP/token-meter"
echo "Building and installing — about a minute..."
npm run claude:install

echo
bold "Installed."
echo "One-time step: System Settings > Privacy & Security > Accessibility"
echo "  -> enable 'Token Widget'."
echo "Then focus a Claude Code session and the meter appears."
