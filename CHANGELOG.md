# Token Widget changelog

The top entry is the current source version. Binary release metadata appears at
`/api/v1/latest` only after a signed and notarized DMG has actually been
published.

## 0.2.1 — 2026-08-14

- The signed, notarized "Token Widget.app" DMG returns as the primary
  distribution: download, drag to Applications, double-click to self-install.
  Updates ship as new DMGs that overwrite the app; the in-widget auto-update
  channel stays dark until public launch. The command-line source install
  remains available as the secondary path.
- Sharing consent now runs through a browser wizard: pick a handle with live
  availability checks and verified-available suggestions, see exactly what
  leaves the machine, and publish with an explicit button. Nothing uploads
  until the agreement is accepted.
- Switching back to "Data stays local" deletes the shared aggregates from the
  server through a signed withdrawal; the handle claim survives, wiped meters
  leave the leaderboard, and an unreachable registry retries the wipe
  automatically.
- The public profile page (`/u/<handle>`) mirrors the local dashboard: stat
  strip, activity calendar, platform split, coding patterns, activity
  insights, daily rhythm, top days, and a live weekly rank badge.
- Usage reports carry the full aggregate stat set (hour-of-day rhythm, top
  days, session sizes, cache and output shares) — aggregates only, validated
  strictly server-side, additive for older clients and servers.
- The leaderboard name column prefers claimed @handles.
- The widget settings panel shows the installed version (and any available
  update) on its tip line, and a one-time first-run banner offers to reserve
  an @handle.
- Fixed the settings panel truncating when opened while the detail-metrics
  view was up.
- Leaderboard Session totals now use the same rolling seven-day window as the
  ranked Token totals; lifetime Session counts remain profile statistics.
- Passwordless browser pairing: the local Ed25519 Meter identity creates a
  five-minute, single-use pairing link and a revocable secure browser session.
- The live community Leaderboard now highlights the authenticated Meter as
  **you**, reports its weekly rank, and contains no sample rows.
- Enabling community sharing performs an immediate signed aggregate upload;
  local-only mode remains the default and pairing does not imply consent.
- Source updates now accept a healthy, permission-blocked companion and wait
  quietly for Accessibility instead of misreading the invoking terminal's TCC
  state and restoring the previous build.
- Status now reports the verified LaunchAgent's live Accessibility health
  instead of the potentially different result of a terminal-launched check.
- Cross-platform usage history now streams multi-gigabyte Codex and Claude
  JSONL files in bounded chunks and skips oversized content rows, so one
  runaway rollout cannot prevent the combined community report.
- Live Claude snapshots read cached lifetime statistics while community scans
  run in a single background Worker with periodic cache checkpoints; large
  Codex histories no longer freeze the active overlay or restart from zero.

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
