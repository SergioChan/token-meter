# Sharing, Consent, and the Community Profile

How usage data moves (or deliberately does not move) between a Token Widget
installation and the community registry. This is both the product spec and the
data policy the share wizard references.

## Principles

1. **Local by default.** A fresh install shares nothing. All history is
   computed from local transcripts and stays on the machine.
2. **Consent is an explicit act.** Sharing turns on only through the share
   wizard: pick a handle, read exactly what leaves the machine, tick the
   agreement, press *Publish to leaderboard*. Nothing is optimistic; closing
   the wizard changes nothing.
3. **Aggregates only.** Uploads carry daily token totals and derived
   statistics — never prompts, transcripts, code, file names, or per-session
   content. The registry rejects payloads outside its whitelist.
4. **Reversible with a real deletion.** Switching back to *Data stays local*
   deletes the shared rows from the server (signed `withdraw` request), not
   just hides them. The handle claim survives so the identity remains the
   user's.
5. **The identity signs everything.** Claims, reports, and withdrawals are
   Ed25519-signed by the local key; the meter ID is derived from the public
   key, so a payload for someone else's meter cannot verify.

## User flows

### First run (new install)

The overlay shows a one-time bottom banner: *Pick your @handle* with
**Choose handle** (opens the local dashboard's claim card in the browser —
the native panel never takes keyboard focus, so typing happens in the
browser) and **Later**. Either choice retires the banner permanently
(`handlePromptedAtMs` in the identity file). Reserving a handle is local-only
and does not enable sharing.

### Local → community ("Share with community")

Clicking the settings toggle's *Share with community* side opens the share
wizard (`/share` on the loopback dashboard server) instead of flipping state:

1. **Handle step** — input prefilled from the local reservation; availability
   checked live against the registry (debounced). A taken handle shows up to
   three verified-available suggestions as clickable chips
   (`<handle>-dev`, `<handle>-ai`, `<handle><yy>`, …).
2. **Disclosure step** — the exact upload contents, the "never" list, and an
   agreement checkbox.
3. **Publish** — atomic on the client: claim handle → enable sharing → first
   upload. A lost claim race (409) returns to step 1 with fresh suggestions
   and restores the previous local state. Registry unreachable → 502, nothing
   changes. On success the page redirects to the public profile
   (`/u/<handle>`), where the user sees their row live.

The overlay toggle reflects the new state via the snapshot loop (≤5 s).

### Community → local ("Data stays local")

Clicking *Data stays local* while sharing opens the wizard in withdraw mode,
which states the consequences: server-side deletion now, uploads stop, the
@handle stays reserved, local dashboard unaffected. Confirming sends the
signed withdrawal and disables sharing locally. If the registry is
unreachable the wipe is marked `pendingWithdraw` and the hourly sync worker
retries until the server confirms — sharing is off locally either way.

## Wire protocol

- `POST /api/v1/report` — extended aggregate stats (all optional, so old
  clients keep working): `daysActive`, `daysObserved`, `avgPerActiveDay`,
  `firstActivityDate`, `medianSessionTokens`, `largestSessionTokens`,
  `longestSessionMs`, `cacheReadShare`, `outputShare`, `peakHour`,
  `busiestWeekday`, `hours[24]`, `topDays[≤10]`, `byPlatformSessions`.
  Present-but-malformed extras reject the report (422). Day window is 119
  days (server cap 120).
- `POST /api/v1/withdraw` — signed `{kind: "withdraw", meterId, publicKey,
  generatedAtMs}` with the same 15-minute freshness window as reports.
  Blanks `days/stats/week_tokens/generated_at_ms`, keeps the meter row and
  handle claim. Idempotent; wrong keys 409, forged signatures 401.
- Meters with no shared data (`generated_at_ms IS NULL`) are excluded from
  the leaderboard, viewer ranks, and totals. `GET /api/v1/profile/<handle>`
  returns `{handle, shared: false}` for them, letting the profile page say
  "keeps their data local" instead of "not found".

## Public profile page

`/u/<handle>` mirrors the local dashboard in the site's green palette:
stat strip (lifetime, week, peak day, streaks), 17-week activity calendar,
platform split with sessions, coding patterns (cache hit rate, read:write,
session sizes, peak hour/weekday), activity insights, daily rhythm, top
days, plus a live rank badge from the leaderboard. Every section renders
only when its data exists, so profiles uploaded by older clients degrade
gracefully.

## Test map (`test/sharing-flow.test.mjs` and friends)

- New user shares immediately after install (publish → claim → upload → row).
- Long-time local user shares months of history later (window cap, totals).
- Publish without agreement: 422, zero state change anywhere.
- Taken handle: live suggestions verified available; publish stays atomic on
  a lost race.
- Withdraw: server rows wiped, handle claim kept, re-share restores the row
  (the returning-user toggle cycle).
- Withdraw with registry down: sharing off locally, `pendingWithdraw` set for
  the worker retry.
- Registry level: extended-stat validation bounds, forged/stale withdrawal
  rejection, Postgres (pg-mem) withdraw + leaderboard exclusion parity.

## Deployment notes

Server changes are additive (JSONB stats, one new route) — no migration.
Deploy backend before clients matter: old server + new client silently drops
extras; new server + old client accepts the minimal payload. The overlay and
Swift changes ship with the next source install / app rebuild.
