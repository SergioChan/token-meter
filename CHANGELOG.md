# Changelog

All notable changes to Token Meter are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-08-05

### Added

- Public project documentation, reproducible screenshots, CI, contribution guidance, and security policy.
- Explicit Codex and Claude Code support matrix.
- A visible active-Context reading that follows Codex compaction independently from cumulative Session usage.
- A per-user macOS LaunchAgent installer and uninstaller for normal Dock launches and login persistence.
- A native Claude Desktop companion overlay with exact focused-Session binding, active-context enrichment, window following, and persistent drag/collapse state.
- An offline Claude Desktop Session resolver, de-duplicating transcript collector, read-only snapshot command, application identity verifier, persistent snapshot bridge, and content-discarding metrics path.
- Claude Desktop build, install, status, update, and uninstall workflows that do not restart Claude.
- Host-specific integration documentation and an Agent-ready automated installation prompt.
- A self-contained Claude release app with embedded Node.js, dual-architecture assets, Developer ID signing, Hardened Runtime, Apple notarization, and a standalone installer/status/uninstaller.
- Transactional Claude updates, managed-path deletion guards, explicit Accessibility reset, live structured health state, and source-install diagnostics.

### Changed

- Corrected the Claude roadmap to target an injected meter in the Claude Desktop Code tab rather than the Claude Code CLI status line.
- Renderer target verification now completes before persistent script registration.
- Codex listener verification now checks the exact bundle path, signature, and signing Team ID.
- Session-tree discovery includes child-Agent rollouts created on later dates.
- Confirmed token increments display a visible delta pulse at high cumulative totals.
- Codex shutdown waits for the complete application process tree before a relaunch.
- Documentation now distinguishes raw Session workload from backend account-level `/usage` activity.
- Codex and Claude meters can collapse to a compact gauge, move by drag, and persist their layout state.
- Claude support now uses an independent native companion because Claude Desktop's Anthropic-signed CDP authorization gate has no public third-party issuance path.
- A permission-blocked Claude companion now waits quietly in one process instead of exiting into a LaunchAgent retry cycle.
- Codex and Claude source installations now use isolated sibling roots so updating or uninstalling one integration cannot replace the other.
- Claude Accessibility binding now requires one exact Code `AXWebArea`, narrows Context reads to strict button titles, bounds scan work, and rejects ambiguous or lookalike surfaces.
- Claude context-window caching now follows the exact Session model and invalidates when the installed model catalog changes.
- Claude readiness checks now require an exact executable command boundary, and CI syntax-checks integration shell scripts recursively.
- Codex ignores deprecated shared-root environment overrides so stale local configuration cannot target the Claude runtime or saved layout state.
- Claude status now separates process liveness, live Accessibility trust, UI readiness, bridge health, and exact Session binding instead of treating a readiness PID as proof of every layer.
- Claude source installation now skips incompatible Node.js candidates and clearly requires Xcode Command Line Tools with Swift, while public release installation has no external Node.js or toolchain dependency.

## [0.1.0] - 2026-08-05

### Added

- Session-aware Codex Desktop Token Meter.
- Session, rolling-hour, current-turn, and 60-second rate metrics.
- Child-Agent aggregation and exact task switching.
- Robust historical anomaly alerts.
- Four-stage green, yellow, orange, and red rate gauge.
- Safe macOS launch and cleanup scripts.

[Unreleased]: https://github.com/SergioChan/token-meter/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SergioChan/token-meter/releases/tag/v0.2.0
[0.1.0]: https://github.com/SergioChan/token-meter/tree/99b274f
