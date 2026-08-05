# Changelog

All notable changes to Token Meter are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public project documentation, reproducible screenshots, CI, contribution guidance, and security policy.
- Explicit Codex and Claude Code support matrix.
- A visible active-Context reading that follows Codex compaction independently from cumulative Session usage.
- A per-user macOS LaunchAgent installer and uninstaller for normal Dock launches and login persistence.
- An offline Claude Desktop Session resolver, de-duplicating transcript collector, read-only snapshot command, and application identity verifier.
- A fail-closed Claude Desktop Code renderer probe and injector adapter, pending restart-approved live validation.

### Changed

- Corrected the Claude roadmap to target an injected meter in the Claude Desktop Code tab rather than the Claude Code CLI status line.
- Renderer target verification now completes before persistent script registration.
- Codex listener verification now checks the exact bundle path, signature, and signing Team ID.
- Session-tree discovery includes child-Agent rollouts created on later dates.
- Confirmed token increments display a visible delta pulse at high cumulative totals.
- Codex shutdown waits for the complete application process tree before a relaunch.
- Documentation now distinguishes raw Session workload from backend account-level `/usage` activity.

## [0.1.0] - 2026-08-05

### Added

- Session-aware Codex Desktop Token Meter.
- Session, rolling-hour, current-turn, and 60-second rate metrics.
- Child-Agent aggregation and exact task switching.
- Robust historical anomaly alerts.
- Four-stage green, yellow, orange, and red rate gauge.
- Safe macOS launch and cleanup scripts.

[Unreleased]: https://github.com/SergioChan/token-meter/compare/99b274f...HEAD
[0.1.0]: https://github.com/SergioChan/token-meter/tree/99b274f
