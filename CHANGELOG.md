# Token Widget changelog

The top entry is always the latest released version — the one served at
`/download/token-widget.dmg` and reported by `/api/v1/latest`.

## 0.2.0 — 2026-08-13

- Logo and app icon: coin-ring gauge mark on the site (nav + favicons), a
  proper macOS `AppIcon.icns` in the app bundle, and a branded installer applet.
- In-widget update channel (Phase 1): the registry publishes
  `GET /api/v1/latest`; the bridge checks hourly and the widget shows an
  update banner. One click downloads the notarized DMG (Gatekeeper-verified)
  and opens it on the drag-to-install window. Accessibility survives updates.
- Bundle versions are stamped from `package.json` at build time.

## 0.1.0 — 2026-08-12

- Initial internal release: live token gauge overlay for Claude Desktop,
  identity/meter IDs with claimable @handles, usage dashboard and community
  leaderboard, signed opt-in usage sharing, notarized DMG + installer zip.
