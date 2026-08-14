# Token Widget changelog

The top entry is the current source version. Binary release metadata appears at
`/api/v1/latest` only after a signed and notarized DMG has actually been
published.

## Unreleased

- Passwordless browser pairing: the local Ed25519 Meter identity creates a
  five-minute, single-use pairing link and a revocable secure browser session.
- The live community Leaderboard now highlights the authenticated Meter as
  **you**, reports its weekly rank, and contains no sample rows.
- Enabling community sharing performs an immediate signed aggregate upload;
  local-only mode remains the default and pairing does not imply consent.
- Source updates now accept a healthy, permission-blocked companion and wait
  quietly for Accessibility instead of misreading the invoking terminal's TCC
  state and restoring the previous build.

## 0.2.0 — 2026-08-13

- Logo and app icon: coin-ring gauge mark on the site (nav + favicons), a
  proper macOS `AppIcon.icns` in the app bundle, and a branded installer applet.
- In-widget update channel (Phase 1): the bridge checks `GET /api/v1/latest`
  hourly and shows an update banner only when the registry has a published
  release. Downloaded DMGs must pass Gatekeeper before the widget opens them.
- Bundle versions are stamped from `package.json` at build time.

## 0.1.0 — 2026-08-12

- Initial internal release: live token gauge overlay for Claude Desktop,
  identity/meter IDs with claimable @handles, usage dashboard and community
  leaderboard, and signed opt-in usage sharing.
