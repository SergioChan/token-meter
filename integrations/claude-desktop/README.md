# Claude Code in Claude Desktop Integration

This integration displays the shared Token Meter as an independent native macOS overlay attached to the Code surface inside Claude Desktop.

It does **not** inject JavaScript into Claude, patch `app.asar`, re-sign Claude.app, or restart Claude. Production Claude Desktop rejects public CDP debugging without an Anthropic-signed authorization value, so the supported integration uses a native companion instead.

## Interface

```bash
./scripts/install-claude-meter-macos.sh
./scripts/status-claude-meter-macos.sh --json
./scripts/uninstall-claude-meter-macos.sh
```

See [the complete installation guide](../../docs/install-claude-desktop.md).

## Implementation

- `native/ClaudeAccessibility.swift` owns exact `AXWebArea` route resolution and the narrow Context-button probe.
- `native/ClaudeModelCatalog.swift` owns model-to-window resolution and catalog cache invalidation.
- `native/TokenMeterClaudeOverlay.swift` owns the non-activating panel, window following, persistent snapshot bridge, drag/collapse behavior, and permission lifecycle.
- `src/desktop-session-store.mjs` maps one exact Desktop `local_<uuid>` to one Claude Code transcript identity.
- `src/transcript-store.mjs` incrementally reads numerical usage while discarding prompt, tool, reasoning, and response content.
- `src/snapshot-runtime.mjs` is the deep measurement module used by both CLI inspection and the overlay.
- `src/overlay-bridge.mjs` keeps one Node process alive and serves newline-delimited numerical snapshots to the native host.
- `scripts/` builds the background `.app` and manages its isolated LaunchAgent.

## Invariants

- Bind only the exact `local_<uuid>` exposed by the focused Claude Code window.
- Hide the overlay when Claude is not frontmost or the selected Session cannot be proven.
- Never substitute the most recently active process, transcript, or metadata file.
- Read local content only to extract identifiers, timestamps, event types, and numerical usage; do not retain message content.
- Require macOS Accessibility permission for the companion itself and fail closed until it is granted.
- Never read static text, values, descriptions, or conversation bodies while resolving a Session or Context window.
- Never quit, relaunch, modify, patch, or re-sign Claude.app.
