# Claude Code in Claude Desktop Integration

This integration displays the shared Token Widget runtime as an independent native macOS overlay attached to the Code surface inside Claude Desktop.

It does **not** inject JavaScript into Claude, patch `app.asar`, re-sign Claude.app, or restart Claude. Production Claude Desktop rejects public CDP debugging without an Anthropic-signed authorization value, so the supported integration uses a native companion instead.

The release DMG contains a self-contained Developer ID-signed and notarized app with an embedded runtime and Node.js. Developers can also build and install the companion from source; source builds are ad-hoc signed unless a stable signing identity is supplied.

## Interface

```bash
./scripts/doctor-claude-meter-macos.sh
./scripts/install-claude-meter-macos.sh
./scripts/status-claude-meter-macos.sh --json
./scripts/uninstall-claude-meter-macos.sh
```

See [the complete installation guide](../../docs/install-claude-desktop.md).

## Implementation

- `native/ClaudeAccessibility.swift` owns exact `AXWebArea` route resolution and the narrow Context-button probe.
- `native/ClaudeModelCatalog.swift` owns model-to-window resolution and catalog cache invalidation.
- `native/TokenMeterClaudeOverlay.swift` owns the non-activating panel, window following, persistent snapshot bridge, drag/collapse behavior, and permission lifecycle.
- `src/desktop-session-store.mjs` maps one exact legacy Desktop
  `local_<uuid>` to one Claude Code transcript identity.
- `src/simple-cache.mjs` reads Chromium Simple Cache entries (header, plaintext
  key, wire-encoded body, streaming state) and keeps an incremental,
  persistable key index over Claude's cache directory.
- `src/cloud-events.mjs` recognizes one cloud Session under every identifier
  prefix and request shape and extracts `sequence_num` events from JSON pages,
  SSE streams, and wrapper responses.
- `src/cloud-session-store.mjs` merges every cached source for a
  `session_<24 chars>` route, reports sequence coverage, and falls back to URL
  probes in each observed shape when the cache directory cannot be listed.
- `src/transcript-store.mjs` incrementally reads numerical usage while discarding prompt, tool, reasoning, and response content.
- `src/snapshot-runtime.mjs` is the deep measurement module used by both CLI inspection and the overlay.
- `src/overlay-bridge.mjs` keeps one Node process alive and serves newline-delimited numerical snapshots to the native host.
- The same bridge creates signed, single-use Leaderboard pairing URLs; the native host opens only the fixed production HTTPS origin and path.
- `scripts/` builds the background `.app` and manages its isolated LaunchAgent.

## Invariants

- Bind only the exact `local_<uuid>` or mixed-case `session_<24 chars>`
  exposed by the focused Claude Code window.
- Hide the overlay when Claude is not frontmost or the selected Session cannot be proven.
- Never substitute the most recently active process, transcript, or metadata file.
- Read local content only to extract identifiers, timestamps, event types, and numerical usage; do not retain message content.
- Require macOS Accessibility permission for the companion itself and fail closed until it is granted.
- Never read static text, values, descriptions, or conversation bodies while resolving a Session or Context window.
- Match cloud Session cache entries by Session identity, never by a fixed URL, and report partial coverage as a flagged lower bound rather than hiding it or borrowing another Session's data.
- Never treat browser pairing as usage-sharing consent; sharing remains an explicit local opt-in.
- Never quit, relaunch, modify, patch, or re-sign Claude.app.
