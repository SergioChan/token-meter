import { dateFallsInTrailingWindow } from "../src/core/usage-history.mjs";

function safeSum(values, label) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must contain non-negative safe integers`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError(`${label} exceeds safe integer range`);
  }
  return total;
}

function optionalSafeSum(snapshots, read, label) {
  const values = snapshots.map(read);
  return values.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? safeSum(values, label)
    : null;
}

function mergedStreaks(days, nowMs) {
  const active = days.filter((day) => day.total > 0);
  let run = 0;
  let longest = 0;
  let previousMs = null;
  for (const day of active) {
    const dayMs = Date.parse(`${day.date}T12:00:00`);
    run = previousMs != null && dayMs - previousMs <= 86_400_000 * 1.5 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previousMs = dayMs;
  }
  if (active.length === 0) return { current: 0, longest: 0 };
  const lastMs = Date.parse(`${active.at(-1).date}T12:00:00`);
  const current = Number.isFinite(lastMs) && lastMs >= nowMs - 2 * 86_400_000 ? run : 0;
  return { current, longest };
}

function clone(value) {
  return structuredClone(value);
}

export function aggregateProfileSnapshots(snapshots) {
  const active = snapshots.filter((snapshot) => snapshot.generatedAtMs != null);
  if (active.length === 0) {
    return {
      days: [],
      stats: {},
      weekTokens: 0,
      generatedAtMs: null,
      updatedAtMs: snapshots.reduce(
        (latest, snapshot) => Math.max(latest, snapshot.updatedAtMs ?? 0),
        0,
      ),
    };
  }
  if (active.length === 1) {
    const [snapshot] = active;
    return {
      days: clone(snapshot.days ?? []),
      stats: clone(snapshot.stats ?? {}),
      weekTokens: snapshot.weekTokens ?? 0,
      generatedAtMs: snapshot.generatedAtMs,
      updatedAtMs: snapshot.updatedAtMs,
    };
  }

  const generatedAtMs = Math.max(...active.map((snapshot) => snapshot.generatedAtMs));
  const updatedAtMs = Math.max(...active.map((snapshot) => snapshot.updatedAtMs ?? 0));
  const totalsByDate = new Map();
  for (const snapshot of active) {
    for (const day of snapshot.days ?? []) {
      const previous = totalsByDate.get(day.date) ?? 0;
      totalsByDate.set(day.date, safeSum([previous, day.total], "daily tokens"));
    }
  }
  const days = [...totalsByDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, total]) => ({ date, total }))
    .slice(-120);
  const activeDays = days.filter((day) => day.total > 0);
  const peak = activeDays.reduce(
    (largest, day) => day.total > (largest?.total ?? -1) ? day : largest,
    null,
  );
  const recentStreaks = mergedStreaks(days, generatedAtMs);
  const reportedLongest = Math.max(
    0,
    ...active.map((snapshot) => snapshot.stats?.longestStreakDays ?? 0),
  );
  const byPlatform = {};
  for (const platform of ["claudeCode", "codex", "cline"]) {
    byPlatform[platform] = safeSum(
      active.map((snapshot) => snapshot.stats?.byPlatform?.[platform] ?? 0),
      `${platform} tokens`,
    );
  }
  const stats = {
    lifetimeTokens: safeSum(
      active.map((snapshot) => snapshot.stats?.lifetimeTokens ?? 0),
      "lifetime tokens",
    ),
    currentStreakDays: recentStreaks.current,
    longestStreakDays: Math.max(reportedLongest, recentStreaks.longest),
    sessionCount: safeSum(
      active.map((snapshot) => snapshot.stats?.sessionCount ?? 0),
      "session count",
    ),
    sessionsLast7Days: optionalSafeSum(
      active,
      (snapshot) => snapshot.stats?.sessionsLast7Days,
      "recent session count",
    ),
    peakDay: peak ? { date: peak.date, tokens: peak.total } : null,
    byPlatform,
    firstActivityDate: activeDays[0]?.date ?? null,
    largestSessionTokens: Math.max(
      0,
      ...active.map((snapshot) => snapshot.stats?.largestSessionTokens ?? 0),
    ),
    longestSessionMs: Math.max(
      0,
      ...active.map((snapshot) => snapshot.stats?.longestSessionMs ?? 0),
    ),
    topDays: [...activeDays]
      .sort((left, right) => right.total - left.total || left.date.localeCompare(right.date))
      .slice(0, 10)
      .map((day) => ({ date: day.date, tokens: day.total })),
    aggregation: {
      deviceCount: active.length,
      exact: [
        "days",
        "weekTokens",
        "lifetimeTokens",
        "byPlatform",
        "currentStreakDays",
        "peakDay",
      ],
      partial: [
        "longestStreakDays",
        "sessionCount",
        "sessionsLast7Days",
      ],
    },
  };

  const hours = active.map((snapshot) => snapshot.stats?.hours);
  if (hours.every((value) => Array.isArray(value) && value.length === 24)) {
    stats.hours = Array.from({ length: 24 }, (_, index) =>
      safeSum(hours.map((value) => value[index]), `hour ${index}`));
    stats.peakHour = stats.hours.indexOf(Math.max(...stats.hours));
  }
  const platformSessions = active.map((snapshot) => snapshot.stats?.byPlatformSessions);
  if (platformSessions.every((value) => value != null)) {
    stats.byPlatformSessions = {};
    for (const platform of ["claudeCode", "codex", "cline"]) {
      stats.byPlatformSessions[platform] = safeSum(
        platformSessions.map((value) => value[platform]),
        `${platform} session count`,
      );
    }
  }

  const weekTokens = safeSum(
    days
      .filter((day) => dateFallsInTrailingWindow(day.date, generatedAtMs))
      .map((day) => day.total),
    "weekly tokens",
  );
  return { days, stats, weekTokens, generatedAtMs, updatedAtMs };
}
