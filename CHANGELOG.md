# Token Widget changelog

The top entry is the current source version. Binary release metadata appears at
`/api/v1/latest` only after a signed and notarized DMG has actually been
published.

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
