# Changelog

All notable changes to Token Meter are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public project documentation, reproducible screenshots, CI, contribution guidance, and security policy.
- Explicit Codex and Claude Code support matrix.

### Changed

- Corrected the Claude roadmap to target an injected meter in the Claude Desktop Code tab rather than the Claude Code CLI status line.
- Renderer target verification now completes before persistent script registration.
- Codex listener verification now checks the exact bundle path, signature, and signing Team ID.
- Session-tree discovery includes child-Agent rollouts created on later dates.
- Confirmed token increments display a visible delta pulse at high cumulative totals.

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
