import { signPayload, markHandleClaimed } from "./identity.mjs";
import { registryBase } from "./registry-config.mjs";
import { UsageHistory } from "./usage-history.mjs";

const FETCH_TIMEOUT_MS = 10_000;

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
export async function uploadUsage(identity, usage = null) {
  const collected = usage ?? new UsageHistory().collect();
  const stats = collected.stats;
  const days = collected.days.slice(-90).map((day) => ({
    date: day.date,
    total: day.total,
  }));
  const cutoff = Date.now() - 7 * 86_400_000;
  const signed = signPayload(identity, {
    kind: "usage",
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
      peakDay: stats.peakDay,
      byPlatform: {
        claudeCode: stats.byPlatform.claudeCode.tokens,
        codex: stats.byPlatform.codex.tokens,
        cline: stats.byPlatform.cline.tokens,
      },
    },
    weekTokens: days
      .filter((day) => Date.parse(`${day.date}T12:00:00`) >= cutoff)
      .reduce((sum, day) => sum + day.total, 0),
  });
  return call("/api/v1/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
}
