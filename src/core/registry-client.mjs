import {
  markHandleClaimed,
  setProfileMembership,
  signPayload,
} from "./identity.mjs";
import { communityWebBase, registryBase } from "./registry-config.mjs";
import {
  UsageHistory,
  dateFallsInTrailingWindow,
} from "./usage-history.mjs";
import { SESSION_TOKEN_BUCKET_MAXIMA } from "./usage-merge.mjs";

const FETCH_TIMEOUT_MS = 10_000;

function reconcileTokenBreakdown(tokenBreakdown, lifetimeTokens) {
  const classifiedTokens = Object.values(tokenBreakdown).reduce(
    (total, value) => total + value,
    0,
  );
  const unclassifiedInput = lifetimeTokens - classifiedTokens;
  if (!Number.isSafeInteger(unclassifiedInput) || unclassifiedInput < 0) {
    throw new Error("usage token breakdown exceeds the lifetime total");
  }
  // Some Codex resume/recomputation events report only total_tokens while all
  // category fields are zero. Preserve that confirmed workload and reconcile
  // the unknown positive remainder into the conservative input-side bucket.
  return {
    ...tokenBreakdown,
    input: tokenBreakdown.input + unclassifiedInput,
  };
}

export function registryEnabled() {
  return registryBase() != null;
}

async function call(path, options = {}) {
  const base = registryBase();
  if (base == null) throw new Error("registry is not configured");
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `registry replied ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function checkHandleAvailable(handle) {
  return call(`/api/v1/handle/${encodeURIComponent(handle)}/available`);
}

export async function createBrowserPairing(identity, nowMs = Date.now()) {
  const signed = signPayload(identity, {
    kind: "browser-pairing",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    generatedAtMs: nowMs,
  });
  const pairing = await call("/api/v1/browser-pairings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  if (!/^[A-Za-z0-9_-]{32}$/.test(pairing.code ?? "")) {
    throw new Error("registry returned an invalid browser pairing");
  }
  return pairing;
}

export async function createLeaderboardUrl(identity, nowMs = Date.now()) {
  const webBase = communityWebBase();
  if (webBase == null) throw new Error("community website is not configured");
  const pairing = await createBrowserPairing(identity, nowMs);
  const url = new URL("/leaderboard", `${webBase}/`);
  url.hash = new URLSearchParams({ pair: pairing.code }).toString();
  return url.toString();
}

// Latest published release: {version, path, sha256, size}. Carries no
// identity and is safe to call regardless of the sharing opt-in.
export function fetchLatestRelease() {
  return call("/api/v1/latest");
}

// True when `candidate` is a strictly newer x.y.z than `installed`.
export function isNewerVersion(candidate, installed) {
  const parse = (value) => String(value).trim().split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(candidate);
  const b = parse(installed);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export async function claimHandle(identity, identityDir = undefined) {
  const signed = signPayload(identity, {
    kind: "claim",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    handle: identity.handle,
    generatedAtMs: Date.now(),
  });
  const result = await call("/api/v1/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  if (result.claimed) {
    markHandleClaimed(...(identityDir ? [identityDir] : []));
  }
  return result;
}

// Uploads aggregate usage only: daily totals and headline stats. Session and
// message content never appear in this payload.
function buildUsagePayload(identity, collected, { version }) {
  const stats = collected.stats;
  const days = collected.days.slice(-119).map((day) => ({
    date: day.date,
    total: day.total,
  }));
  const share = (value) => Math.round((value ?? 0) * 10_000) / 10_000;
  // Optional fields are null, never undefined: canonicalize() must produce
  // the same bytes before signing and after the JSON round-trip.
  const platformSessions = [
    stats.byPlatform.claudeCode.sessions,
    stats.byPlatform.codex.sessions,
    stats.byPlatform.cline.sessions,
  ];
  const payload = {
    kind: version === 2 ? "usage-v2" : "usage",
    ...(version === 2 ? { reportVersion: 2 } : {}),
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    handle: identity.handle ?? null,
    generatedAtMs: collected.generatedAtMs,
    days,
    stats: {
      lifetimeTokens: stats.lifetimeTokens,
      currentStreakDays: stats.currentStreakDays,
      longestStreakDays: stats.longestStreakDays,
      sessionCount: stats.sessionCount,
      sessionsLast7Days: stats.sessionsLast7Days ?? null,
      peakDay: stats.peakDay ?? null,
      byPlatform: {
        claudeCode: stats.byPlatform.claudeCode.tokens,
        codex: stats.byPlatform.codex.tokens,
        cline: stats.byPlatform.cline.tokens,
      },
      // Aggregate-only extras so the community profile can mirror the local
      // dashboard. Servers before v0.3 drop unknown fields on validation.
      daysActive: stats.daysActive ?? null,
      daysObserved: stats.daysObserved ?? null,
      avgPerActiveDay: stats.avgPerActiveDay ?? null,
      firstActivityDate: stats.firstActivityDate ?? null,
      medianSessionTokens: stats.medianSessionTokens ?? null,
      largestSessionTokens: stats.largestSessionTokens ?? null,
      longestSessionMs: stats.longestSessionMs ?? null,
      cacheReadShare: share(stats.cacheReadShare),
      outputShare: share(stats.outputShare),
      peakHour: stats.peakHour ?? null,
      busiestWeekday: stats.busiestWeekday ?? null,
      hours: collected.hours ?? null,
      topDays: stats.topDays ?? null,
      byPlatformSessions: platformSessions.every((value) => value != null)
        ? {
            claudeCode: platformSessions[0],
            codex: platformSessions[1],
            cline: platformSessions[2],
          }
        : null,
    },
    weekTokens: days
      .filter((day) =>
        dateFallsInTrailingWindow(day.date, collected.generatedAtMs),
      )
      .reduce((sum, day) => sum + day.total, 0),
  };
  if (version === 2) {
    const rawTokenBreakdown = collected.days.reduce(
      (totals, day) => ({
        input: totals.input + (day.input ?? 0),
        output: totals.output + (day.output ?? 0),
        cacheRead: totals.cacheRead + (day.cacheRead ?? 0),
        cacheWrite: totals.cacheWrite + (day.cacheWrite ?? 0),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const tokenBreakdown = reconcileTokenBreakdown(
      rawTokenBreakdown,
      stats.lifetimeTokens,
    );
    const weekdayTokens = Array(7).fill(0);
    for (const day of collected.days) {
      const weekday = new Date(`${day.date}T12:00:00`).getDay();
      if (Number.isInteger(weekday)) weekdayTokens[weekday] += day.total ?? 0;
    }
    let histogram = stats.sessionTokenHistogram;
    if (!Array.isArray(histogram) || histogram.length !== SESSION_TOKEN_BUCKET_MAXIMA.length) {
      histogram = Array(SESSION_TOKEN_BUCKET_MAXIMA.length).fill(0);
      const median = stats.medianSessionTokens ?? 0;
      const index = SESSION_TOKEN_BUCKET_MAXIMA.findIndex((maximum) => median <= maximum);
      histogram[index < 0 ? histogram.length - 1 : index] = stats.sessionCount;
    }
    payload.merge = {
      version: 1,
      tokenBreakdown,
      hours: Array.isArray(collected.hours) && collected.hours.length === 24
        ? collected.hours
        : Array(24).fill(0),
      weekdayTokens,
      sessionTokenHistogram: histogram,
      activeDates: collected.days
        .filter((day) => day.total > 0)
        .map((day) => day.date)
        .slice(-3_660),
    };
  }
  return signPayload(identity, payload);
}

export async function uploadUsage(identity, usage = null) {
  const collected = usage ?? new UsageHistory().collect();
  const send = (path, signed) => call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  try {
    return await send("/api/v2/report", buildUsagePayload(identity, collected, { version: 2 }));
  } catch (error) {
    if (error.status !== 404 && error.status !== 405) throw error;
    return send("/api/v1/report", buildUsagePayload(identity, collected, { version: 1 }));
  }
}

export async function createProfileInvite(
  identity,
  { mode = "add", replaceMeterId = null } = {},
  nowMs = Date.now(),
) {
  const signed = signPayload(identity, {
    kind: "profile-invite",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    mode,
    replaceMeterId: mode === "replace" ? replaceMeterId : null,
    generatedAtMs: nowMs,
  });
  return call("/api/v2/profile-invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
}

export async function joinExistingProfile(
  identity,
  { inviteToken, deviceLabel = null },
  identityDir = undefined,
  nowMs = Date.now(),
) {
  const signed = signPayload(identity, {
    kind: "profile-join",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    inviteToken,
    deviceLabel,
    generatedAtMs: nowMs,
  });
  const result = await call("/api/v2/profile-join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  setProfileMembership({
    profileId: result.profileId,
    handle: result.handle,
    role: result.role,
    deviceLabel,
    joinedAtMs: nowMs,
    lastConfirmedAtMs: nowMs,
  }, ...(identityDir ? [identityDir] : []));
  return result;
}

async function signedProfileCall(path, kind, identity, extras = {}, nowMs = Date.now()) {
  const signed = signPayload(identity, {
    kind,
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    ...extras,
    generatedAtMs: nowMs,
  });
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
}

export function fetchProfileMembership(identity, nowMs = Date.now()) {
  return signedProfileCall(
    "/api/v2/profile-membership",
    "profile-membership",
    identity,
    {},
    nowMs,
  );
}

export function fetchProfileDevices(identity, nowMs = Date.now()) {
  return signedProfileCall(
    "/api/v2/profile-devices",
    "profile-devices",
    identity,
    {},
    nowMs,
  );
}

export function revokeProfileDevice(identity, targetMeterId, nowMs = Date.now()) {
  return signedProfileCall(
    "/api/v2/profile-devices/revoke",
    "profile-device-revoke",
    identity,
    { targetMeterId },
    nowMs,
  );
}

export function transferProfileOwner(identity, targetMeterId, nowMs = Date.now()) {
  return signedProfileCall(
    "/api/v2/profile-devices/transfer-owner",
    "profile-owner-transfer",
    identity,
    { targetMeterId },
    nowMs,
  );
}

// Delete this meter's shared aggregates from the registry. The handle claim
// survives — withdrawing data does not surrender the identity.
export async function withdrawUsage(identity, nowMs = Date.now()) {
  const signed = signPayload(identity, {
    kind: "withdraw",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    generatedAtMs: nowMs,
  });
  return call("/api/v1/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
}
