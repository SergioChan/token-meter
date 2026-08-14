# Install Token Widget for Claude Code in Claude Desktop

Token Meter supports the Code surface inside Claude Desktop on macOS through an independent native overlay. The companion follows the focused Claude window, reads the exact selected `local_<uuid>` through macOS Accessibility, maps it to local Claude Code usage, and hides when that identity cannot be proven.

The installer does not quit, relaunch, modify, patch, or re-sign Claude.app.

The Claude integration is source-distributed. Each developer compiles and ad-hoc signs the companion locally; this repository does not publish a prebuilt or notarized application package.

## Requirements

- macOS 13 or newer.
- The official signed Claude Desktop application at `/Applications/Claude.app`.
- Git.
- Node.js 22.12 or newer.
- Xcode Command Line Tools with Swift.
- Permission to enable **Token Widget for Claude** in System Settings > Privacy & Security > Accessibility.

Check all local build prerequisites:

```bash
./scripts/doctor-claude-meter-macos.sh
```

The installer searches compatible Homebrew, PATH, and nvm candidates and skips old Node.js versions. Pass `--node` only when a specific compatible absolute path is required.

## Install

From the repository root:

```bash
./scripts/install-claude-meter-macos.sh
```

Or select Node.js explicitly:

```bash
./scripts/install-claude-meter-macos.sh --node /opt/homebrew/bin/node
```

The installer performs these operations:

1. Verifies the canonical Claude.app path, bundle identifier, Anthropic Team ID, code signature, executable, and packaged model catalog.
2. Builds and signs `Token Widget for Claude.app` as a separate background application. Source builds use ad-hoc signing unless a stable identity is supplied.
3. Copies the numerical collector, shared metrics core, and shared meter runtime into an isolated install root.
4. Writes and loads `com.sergiochan.token-meter.claude-desktop` as a per-user LaunchAgent.
5. Requests Accessibility permission for the companion application itself.

To build only the local app bundle for inspection:

```bash
./integrations/claude-desktop/scripts/build-app.sh \
  --output "$PWD/local-artifacts/Token Widget for Claude.app"
```

That bundle still expects the repository runtime and a compatible local Node.js path. Run the installer for the complete runtime copy and LaunchAgent configuration.

Default paths:

```text
Application: ~/Library/Application Support/Token Meter/Claude Desktop/
State:       ~/Library/Application Support/Token Meter/State/Claude Desktop/
LaunchAgent: ~/Library/LaunchAgents/com.sergiochan.token-meter.claude-desktop.plist
Logs:        ~/Library/Logs/Token Meter/Claude Desktop/
```

## Grant Accessibility permission

If installation reports `Accessibility permission: required`:

1. Open System Settings.
2. Go to **Privacy & Security > Accessibility**.
3. Enable **Token Widget for Claude**.
4. Wait up to two seconds for the already-running companion to observe the new permission.

If the application is not listed, request the system prompt again:

```bash
open -n -a "$HOME/Library/Application Support/Token Meter/Claude Desktop/Token Widget for Claude.app" \
  --args --prompt-accessibility
```

Then return to the Accessibility panel and enable it. Run the prompt command once; the normal LaunchAgent never repeats it.

An ad-hoc signed development build may require renewed permission after an update. If a local code-signing identity is available, use it consistently:

```bash
TOKEN_METER_CODESIGN_IDENTITY="Apple Development: Name (TEAMID)" \
  ./scripts/install-claude-meter-macos.sh
```

List available identities with `security find-identity -v -p codesigning`. If Accessibility contains an entry from an older signature, remove that entry, add the current app from the installation path above, and enable it once.

The installer reads Accessibility state from the newly launched companion's health file. If that LaunchAgent is not trusted yet, installation still succeeds and the companion waits quietly; a permission check from the invoking terminal is not used as a substitute because macOS can evaluate those process contexts differently.

## Verify

```bash
./scripts/status-claude-meter-macos.sh --json
```

A ready installation returns:

```json
{
  "installed": true,
  "launchAgentInstalled": true,
  "launchAgentLoaded": true,
  "running": true,
  "accessibilityGranted": true,
  "overlayReady": true,
  "bridgeHealthy": true,
  "sessionBound": true,
  "statePresent": true,
  "claudeRestartRequired": false
}
```

`running`, `accessibilityGranted`, and `overlayReady` describe installation health independently. `bridgeHealthy` and `sessionBound` are expected to be `false` while Claude is in the background or is not showing a resolvable local Code Session.

No Claude restart is required. Bring Claude Desktop to the foreground and select a local Code Session. The overlay appears only when it can prove the exact selected Session.

## Use the overlay

- Click `−` to collapse the Meter to its gauge and live token rate.
- Click `+` to expand it.
- Drag the header while expanded.
- Drag the gauge while collapsed.
- Switching Claude Code Sessions atomically switches every displayed metric.
- The overlay hides when Claude is not frontmost, when the Code surface is not selected, or when Session identity is unavailable.
- **Check your ranking** opens a five-minute, single-use link that pairs the browser to this Mac's Meter identity. No email or password is required.
- The Leaderboard labels the matching row **you** after **Share with community** is enabled. Browser pairing alone never enables sharing.

Position and collapsed state survive companion restarts and updates.

## Measurement details

`SESSION`, `1H SESSION`, `CURRENT TURN`, and rate are raw local workload readings. Each unique assistant response contributes:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
```

`ACTIVE CONTEXT` uses only the latest root response's input side:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
```

Output is excluded from active-context occupancy. The context-window denominator comes from a strict Context-window button ratio inside the same exact Code web area when available, otherwise from the current installed Claude model catalog matched to the exact Session model. Token Meter does not scan static text or conversation content for this value. These are private local compatibility surfaces and may change between Claude Desktop releases.

The reading is useful for Agent workload intensity and Session health. It is not Claude subscription billing and does not claim to reproduce undisclosed backend plan accounting.

## Troubleshooting

### Installed but not running

Run:

```bash
./scripts/status-claude-meter-macos.sh --json
tail -n 100 "$HOME/Library/Logs/Token Meter/Claude Desktop/overlay-error.log"
```

If `accessibilityGranted` is `false`, enable the application in Accessibility settings. The loaded companion waits quietly and detects the permission without restarting itself or Claude.

### No overlay while the companion is running

Confirm all of the following:

- Claude Desktop is frontmost.
- The focused window is showing a local Code Session rather than Chat, Cowork, Settings, or an auxiliary window.
- The selected Session has local metadata under `~/Library/Application Support/Claude/claude-code-sessions/`.
- Its mapped transcript exists under `~/.claude/projects/`.

The integration deliberately shows nothing rather than guessing another Session.

### Update

```bash
git pull --ff-only
./scripts/install-claude-meter-macos.sh
```

Claude remains running. The installer retains the previous app and LaunchAgent until the replacement process has produced matching live health state; bootstrap, process, and trusted-UI failures restore the previous installation. Reuse the same `TOKEN_METER_CODESIGN_IDENTITY` value for every update when stable local signing is desired. If an ad-hoc rebuild invalidates the prior Accessibility entry, enable the new build again.

## Uninstall

Remove the companion, LaunchAgent, and logs while retaining its saved layout:

```bash
./scripts/uninstall-claude-meter-macos.sh
```

Remove saved position and collapsed state too:

```bash
./scripts/uninstall-claude-meter-macos.sh --purge-state
```

Remove the saved state and reset the app's macOS Accessibility decision too:

```bash
./scripts/uninstall-claude-meter-macos.sh --purge-state --reset-accessibility
```

Without `--reset-accessibility`, macOS retains the user's TCC decision after the application files are removed.

Uninstallation does not quit, relaunch, or modify Claude Desktop.
