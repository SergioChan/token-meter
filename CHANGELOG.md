# Token Widget changelog

The top entry is the current source version. Binary release metadata appears at
`/api/v1/latest` only after a signed and notarized DMG has actually been
published.

## 0.4.0 — 2026-08-17

- The Token Widget overlay now meters Codex natively. It reads the active thread
  from Codex's local state database and its rollout files, so a frontmost Codex
  window gets a bound face without a CDP debugging port, launch flags, or any
  quit/relaunch of Codex. The overlay installs and runs on machines without
  Claude installed, and the app is now named "Token Widget".
- The widget and **Always Visible** mode are enabled by default. Claude Chat,
  Cowork, Settings, auxiliary windows, and periods when neither Claude nor Codex
  is frontmost now show the machine-wide global face instead of hiding the
  widget. That face has no Session ID, reports `binding.exact = false`, and
  never displays another Session's numbers. Both visibility choices remain
  available from the Token Widget menu-bar menu.
- Deprecated the Codex CDP adapter (`scripts/install-token-meter-macos.sh`). It
  still works but will be removed in a future release; prefer the app.
- Hardened live rollout scanning when Codex prunes a JSONL file between
  discovery and reading, so the native overlay keeps running instead of
  crashing on a transient missing-file race.
- Standardized the packaged runtime and CI on Node.js 22.22, raised the source
  minimum to Node.js 22.13, and added direct `node:sqlite` capability checks and
  minimum-runtime regressions.

## 0.3.1 — 2026-08-15

- Fixed the first aggregate sync for installations whose local Codex history
  contains resume or recomputation events that report only `total_tokens`.
  The confirmed positive remainder is now reconciled into the conservative
  input-side bucket, so the signed v2 breakdown equals the lifetime total and
  the registry no longer rejects an otherwise valid report with HTTP 422.
  This also lets a newly invited Device complete its initial Profile upload
  immediately after joining.

## 0.3.0 — 2026-08-15

- Community handles now belong to a durable Profile instead of one computer.
  Each Mac keeps its own Ed25519 key and Meter ID; an owner can link another
  computer with a hashed, one-use, ten-minute invitation, then list, replace,
  revoke, or promote devices without copying private keys or reclaiming the
  handle. Handle uniqueness remains enforced by the existing primary key.
- Multi-device Profile totals are derived from independently signed Device
  snapshots. The v2 aggregate report adds token breakdowns, fixed hour and
  weekday bins, a fixed Session-size histogram, and active dates so totals,
  streaks, shares, and rhythms can be merged without uploading Session IDs,
  hostnames, or content. Internal merge primitives never appear in public
  Profile responses.
- The server upgrade has a checksummed, advisory-locked, transactional,
  additive migration and a Profile read flag. Reconciliation repairs Meter
  rows and owner handle claims written by late v1 Pods, rebuilds stale
  rollups, and refuses to reactivate revoked devices; verification checks
  every relationship and reconstructed rollup before cutover.
- The local dashboard and CLI can join an existing Profile and manage its
  devices. Switching to **Data stays local** now accurately describes and
  performs a per-computer withdrawal: that Device's contribution is removed,
  while other active computers and the reserved handle remain unchanged.
- The README, sharing specification, Claude installation guide, architecture,
  GKE configuration, and production backup/migration/rollback runbook now use
  the Token Widget product model and staged release procedure.
- Codex now performs its own signed community sync 15 seconds after startup
  and every hour, so public profile aggregates no longer depend on the Claude
  companion being active.
- Claude Desktop cloud Code Sessions using exact `session_<24 chars>` routes
  are measured from their locally cached, paginated `/events` usage records.
  The adapter validates a complete sequence before binding and retains no
  message content; legacy `local_<uuid>` Sessions keep using local transcripts.

## 0.2.5 — 2026-08-14

- The widget updates itself. Clicking the update banner now downloads the
  release, proves it three ways — the registry's published SHA-256, Apple's
  notarization assessment, and the running app's own designated code-signing
  requirement — swaps the bundle in place, and lets launchd relaunch the new
  version seconds later. Any failed check, or an unwritable /Applications,
  falls back to the old verified-DMG-in-Downloads flow. Quitting or updating
  now also shuts down the Node bridge instead of stranding it.
- The registry can publish a release without carrying the bytes:
  `TOKEN_METER_LATEST_*` environment variables describe the version, digest,
  and size, and `/download/token-widget.dmg` redirects to the immutable
  GitHub release asset. `/api/v1/latest` goes live for the first time.
- The DMG opens like a real installer: styled Finder window with background
  art, hidden chrome, and the app and Applications laid out for the drag.
- Share actions on the dashboard and public profiles are now icon buttons
  (X, LinkedIn, copy link, PNG card) with the leaderboard CTA on its own
  row; fixed a CSS bug that kept state-hidden share buttons visible.
- Widget settings polish: "Share with friends" (formerly "Refer friends")
  now copies the tokenwidget.app home page instead of the GitHub repo, and
  the identity block leads with your @handle.
- New homepage: hero, a scroll-tracked feature tour (live telemetry, the
  runaway alarm, identity & community, privacy), and a privacy-first footer.
  The support line now names everything tracked: Claude Code, Codex, Cline.

Versions 0.2.3 and 0.2.4 were internal builds used to test the self-update
pipeline end to end; they were never published.

## 0.2.2 — 2026-08-14

- Share buttons on public profiles and the local dashboard: post to X or
  LinkedIn, copy the profile link, or download a designed PNG stat card —
  every share carries the install link (tokenwidget.app) so recipients can
  get their own widget. Local-only users get the card plus a one-click path
  into the publish wizard; social link previews now ship Open Graph tags.

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
