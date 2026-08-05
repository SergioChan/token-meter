#!/bin/bash
set -euo pipefail

APP_PATH="${1:-}"
if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  printf 'Claude application not found at %s\n' "${APP_PATH:-<empty>}" >&2
  exit 1
fi
if [ -L "$APP_PATH" ]; then
  printf 'Refusing a symlinked Claude application bundle.\n' >&2
  exit 1
fi

APP_PARENT="$(cd "$(dirname "$APP_PATH")" && pwd -P)"
CANONICAL_APP_PATH="$APP_PARENT/$(basename "$APP_PATH")"
if [ "$APP_PATH" != "$CANONICAL_APP_PATH" ]; then
  printf 'CLAUDE_APP_PATH must be an absolute canonical path: %s\n' "$CANONICAL_APP_PATH" >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
if [ "$BUNDLE_ID" != "com.anthropic.claudefordesktop" ]; then
  printf 'Refusing an application whose bundle identifier is %s\n' "$BUNDLE_ID" >&2
  exit 1
fi

if ! /usr/bin/codesign --verify --deep --strict "$APP_PATH"; then
  printf 'Claude application signature verification failed.\n' >&2
  exit 1
fi
SIGNATURE_INFO="$(/usr/bin/codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
TEAM_ID="$(printf '%s\n' "$SIGNATURE_INFO" | /usr/bin/awk -F= '$1 == "TeamIdentifier" { print $2; exit }')"
if [ "$TEAM_ID" != "Q6L2SF6YDW" ]; then
  printf 'Refusing a Claude application signed by unexpected Team ID %s\n' "${TEAM_ID:-<missing>}" >&2
  exit 1
fi

EXECUTABLE="$APP_PATH/Contents/MacOS/Claude"
if [ ! -x "$EXECUTABLE" ]; then
  printf 'The verified Claude executable is missing: %s\n' "$EXECUTABLE" >&2
  exit 1
fi

printf '%s\n' "$EXECUTABLE"
