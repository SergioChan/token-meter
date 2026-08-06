# Install Token Meter for Claude Code in Claude Desktop

Token Meter supports the Code surface inside Claude Desktop on macOS through an independent native overlay. The companion follows the focused Claude window, reads the exact selected `local_<uuid>` through macOS Accessibility, maps it to local Claude Code usage, and hides when that identity cannot be proven.

The installer does not quit, relaunch, modify, patch, or re-sign Claude.app.

## Recommended: signed release

Requirements:

- macOS 13 or newer.
- The official signed Claude Desktop application at `/Applications/Claude.app`.
- Permission to enable **Token Meter for Claude** in System Settings > Privacy & Security > Accessibility.

Download the standalone release manager and install the latest release:

```bash
curl -fLO https://github.com/SergioChan/token-meter/releases/latest/download/token-meter-claude
chmod +x token-meter-claude
./token-meter-claude install
```

The manager downloads the asset matching the Mac's architecture and verifies all of the following before installation:

1. The ZIP's SHA-256 value against the release checksum manifest.
2. The app bundle identifier.
3. The complete code-signature seal.
4. The T54 Labs signing Team ID and `Developer ID Application` authority.
5. Apple's Gatekeeper assessment and notarization result.
6. The embedded Node.js runtime and exact architecture.

The previous application and LaunchAgent are retained until the new process has written live health state. A failed launch or initialized-but-broken UI causes an automatic rollback.

The release is self-contained. It does not require Node.js, Git, Swift, Xcode, administrator privileges, or changes to Claude.app.

Release paths:

```text
Application: ~/Applications/Token Meter/Token Meter for Claude.app
Manager:     ~/Library/Application Support/Token Meter/bin/token-meter-claude
State:       ~/Library/Application Support/Token Meter/State/Claude Desktop/
LaunchAgent: ~/Library/LaunchAgents/com.sergiochan.token-meter.claude-desktop.plist
Logs:        ~/Library/Logs/Token Meter/Claude Desktop/
```

## Source installation for contributors

Source installation additionally requires:

- Git.
- Node.js 22.12 or newer.
- Xcode Command Line Tools with Swift.

Check the complete source-build environment:

```bash
./scripts/doctor-claude-meter-macos.sh
```

From the repository root:

```bash
./scripts/install-claude-meter-macos.sh
```

The installer checks common Homebrew, PATH, and nvm locations and skips incompatible Node.js versions. To force one absolute path:

```bash
./scripts/install-claude-meter-macos.sh --node /opt/homebrew/bin/node
```

The source installer performs these operations:

1. Verifies the canonical Claude.app path, bundle identifier, Anthropic Team ID, code signature, executable, and packaged model catalog.
2. Builds and signs `Token Meter for Claude.app` as a separate background application. Source builds use ad-hoc signing unless a stable identity is supplied.
3. Copies the numerical collector, shared metrics core, and shared meter runtime into an isolated install root.
4. Writes and loads `com.sergiochan.token-meter.claude-desktop` as a per-user LaunchAgent.
5. Requests Accessibility permission for the companion application itself.

Source-install paths:

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
3. Enable **Token Meter for Claude**.
4. Wait up to two seconds for the already-running companion to observe the new permission.

If the release application is not listed, request the system prompt again:

```bash
open -n -a "$HOME/Applications/Token Meter/Token Meter for Claude.app" \
  --args --prompt-accessibility
```

For a source build, use its application path instead:

```bash
open -n -a "$HOME/Library/Application Support/Token Meter/Claude Desktop/Token Meter for Claude.app" \
  --args --prompt-accessibility
```

Then return to the Accessibility panel and enable it. Run the prompt command once; the normal LaunchAgent never repeats it.

The public release has one stable Developer ID identity, so normal updates preserve its TCC identity. An ad-hoc signed source build may require renewed permission after a rebuild. Contributors can use a stable local identity consistently:

```bash
TOKEN_METER_CODESIGN_IDENTITY="Apple Development: Name (TEAMID)" \
  ./scripts/install-claude-meter-macos.sh
```

List available identities with `security find-identity -v -p codesigning`. If Accessibility contains an entry from an older signature, remove that entry, add the current app from the installation path above, and enable it once.

## Verify

Signed release:

```bash
"$HOME/Library/Application Support/Token Meter/bin/token-meter-claude" status --json
```

Source build:

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

`running`, `accessibilityGranted`, and `overlayReady` describe installation health independently. `bridgeHealthy` and `sessionBound` become `true` only while Claude is frontmost on a resolvable local Code Session; they are expected to be `false` while Claude is in the background or on Chat, Cowork, or Settings.

No Claude restart is required. Bring Claude Desktop to the foreground and select a local Code Session. The overlay appears only when it can prove the exact selected Session.

## Use the overlay

- Click `−` to collapse the Meter to its gauge and live token rate.
- Click `+` to expand it.
- Drag the header while expanded.
- Drag the gauge while collapsed.
- Switching Claude Code Sessions atomically switches every displayed metric.
- The overlay hides when Claude is not frontmost, when the Code surface is not selected, or when Session identity is unavailable.

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
"$HOME/Library/Application Support/Token Meter/bin/token-meter-claude" status --json
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

Signed release:

```bash
"$HOME/Library/Application Support/Token Meter/bin/token-meter-claude" install
```

Source build:

```bash
git pull --ff-only
./scripts/install-claude-meter-macos.sh
```

Claude remains running. Reuse the same `TOKEN_METER_CODESIGN_IDENTITY` value for every update when stable local signing is desired. If an ad-hoc rebuild invalidates the prior Accessibility entry, enable the new build again.

## Uninstall

Remove a signed release, LaunchAgent, and logs while retaining its saved layout:

```bash
"$HOME/Library/Application Support/Token Meter/bin/token-meter-claude" uninstall
```

Remove its state and explicitly revoke the Accessibility grant too:

```bash
"$HOME/Library/Application Support/Token Meter/bin/token-meter-claude" uninstall \
  --purge-state --reset-accessibility
```

For a source build:

```bash
./scripts/uninstall-claude-meter-macos.sh
```

Remove saved position and collapsed state too:

```bash
./scripts/uninstall-claude-meter-macos.sh --purge-state
```

Add `--reset-accessibility` when the source build's TCC entry should also be removed. Without that option, macOS retains the user's Accessibility decision even after application files are deleted.

Uninstallation does not quit, relaunch, or modify Claude Desktop.
