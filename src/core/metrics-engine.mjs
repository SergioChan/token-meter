import {
  mean,
  median,
  medianAbsoluteDeviation,
  percentile,
} from "./statistics.mjs";
import { isRootUserRollout } from "./rollout-store.mjs";
import { buildRateScale } from "./rate-scale.mjs";

function latestTotal(file) {
  return file.usage.at(-1)?.total.totalTokens ?? 0;
}

function totalBefore(file, timestampMs) {
  let total = 0;
  for (const event of file.usage) {
    if (event.timestampMs >= timestampMs) break;
    total = event.total.totalTokens;
  }
  return total;
}

function deltaBetween(file, startMs, endMs = Number.POSITIVE_INFINITY) {
  let previous = totalBefore(file, startMs);
  let total = 0;
  for (const event of file.usage) {
    if (event.timestampMs < startMs) continue;
    if (event.timestampMs > endMs) break;
    const current = event.total.totalTokens;
    total += current >= previous ? current - previous : current;
    previous = current;
  }
  return total;
}

function groupBySession(files) {
  const sessions = new Map();
  for (const file of files) {
    const sessionId = file.meta?.sessionId;
    if (!sessionId) continue;
    const group = sessions.get(sessionId) ?? [];
    group.push(file);
    sessions.set(sessionId, group);
  }
  return sessions;
}

function pickRoot(files, requestedThreadId) {
  const roots = files.filter(isRootUserRollout);
  if (requestedThreadId) {
    const exact = roots.find(
      (file) =>
        file.meta?.id === requestedThreadId || file.discoveredId === requestedThreadId,
    );
    if (exact) return exact;
    const sessionMatch = roots.find(
      (file) => file.meta?.sessionId === requestedThreadId,
    );
    if (sessionMatch) return sessionMatch;
    return null;
  }
  return roots.sort((left, right) => right.modifiedMs - left.modifiedMs)[0] ?? null;
}

function completedTurnRates(files) {
  const sessions = groupBySession(files);
  const rates = [];
  for (const root of files.filter(isRootUserRollout)) {
    const group = sessions.get(root.meta?.sessionId) ?? [root];
    const boundaries = root.userMessages;
    for (let index = 0; index < boundaries.length; index += 1) {
      const start = boundaries[index];
      const nextMessage = boundaries[index + 1] ?? Number.POSITIVE_INFINITY;
      const terminal = [...root.turnCompletions, ...root.turnAborts]
        .filter((timestamp) => timestamp >= start && timestamp < nextMessage)
        .sort((left, right) => left - right)[0];
      if (terminal == null || terminal <= start) continue;
      const tokens = group.reduce(
        (sum, file) => sum + deltaBetween(file, start, terminal),
        0,
      );
      const durationMinutes = (terminal - start) / 60_000;
      if (tokens > 0 && durationMinutes >= 1 / 60) {
        rates.push(tokens / durationMinutes);
      }
    }
  }
  return rates.slice(-200);
}

function classifyAnomaly({
  currentRate,
  currentTurnTokens,
  currentTurnDurationMs,
  historicalRates,
}) {
  const center = median(historicalRates);
  const deviation = medianAbsoluteDeviation(historicalRates, center);
  const average = mean(historicalRates);
  const p95 = percentile(historicalRates, 0.95);
  const baseline = {
    sampleCount: historicalRates.length,
    medianTokensPerMinute: center,
    averageTokensPerMinute: average,
    p95TokensPerMinute: p95,
    madTokensPerMinute: deviation,
  };

  if (
    historicalRates.length < 5 ||
    center == null ||
    currentTurnDurationMs < 20_000 ||
    currentTurnTokens < 10_000
  ) {
    return { level: "learning", ratio: null, threshold: null, baseline };
  }

  const noiseFloor = Math.max(deviation ?? 0, center * 0.1, 1);
  const threshold = Math.max(center * 2.5, center + 3 * noiseFloor);
  const ratio = currentRate / Math.max(center, 1);
  if (currentRate >= threshold * 1.6 && currentTurnTokens >= 50_000) {
    return { level: "critical", ratio, threshold, baseline };
  }
  if (currentRate >= threshold) {
    return { level: "warning", ratio, threshold, baseline };
  }
  return { level: "normal", ratio, threshold, baseline };
}

export class MetricsEngine {
  constructor({ rateWindowMs = 60_000, hourWindowMs = 3_600_000 } = {}) {
    this.rateWindowMs = rateWindowMs;
    this.hourWindowMs = hourWindowMs;
  }

  snapshot(
    files,
    { threadId = null, nowMs = Date.now(), hostName = "Codex" } = {},
  ) {
    const root = pickRoot(files, threadId);
    if (root == null) {
      return {
        status: "unbound",
        requestedThreadId: threadId,
        reason: threadId
          ? `The selected ${hostName} session is not present in the loaded telemetry index.`
          : `No ${hostName} user session is available.`,
      };
    }

    const sessionId = root.meta.sessionId;
    const sessionFiles = files.filter((file) => file.meta?.sessionId === sessionId);
    const latestRootUsage = root.usage.at(-1) ?? null;
    const latestCompactedAtMs = root.contextCompactions?.at(-1) ?? null;
    const hasFreshContextUsage =
      latestRootUsage != null &&
      (latestCompactedAtMs == null ||
        latestRootUsage.timestampMs > latestCompactedAtMs);
    const contextTokens =
      hasFreshContextUsage
        ? (latestRootUsage.contextTokens ?? latestRootUsage.last?.totalTokens ?? null)
        : null;
    const contextWindowTokens = latestRootUsage?.contextWindow ?? null;
    const sessionStartedAtMs = Math.min(
      ...sessionFiles.map((file) => file.meta?.timestampMs ?? Number.POSITIVE_INFINITY),
    );
    const lastMessageAtMs = root.userMessages.at(-1) ?? sessionStartedAtMs;
    const turnStartedAtMs = Number.isFinite(lastMessageAtMs)
      ? lastMessageAtMs
      : nowMs;
    const currentTurnTokens = sessionFiles.reduce(
      (sum, file) => sum + deltaBetween(file, turnStartedAtMs, nowMs),
      0,
    );
    const sessionTotalTokens = sessionFiles.reduce(
      (sum, file) => sum + latestTotal(file),
      0,
    );
    const sessionHourTokens = sessionFiles.reduce(
      (sum, file) => sum + deltaBetween(file, nowMs - this.hourWindowMs, nowMs),
      0,
    );
    const allHourTokens = files.reduce(
      (sum, file) => sum + deltaBetween(file, nowMs - this.hourWindowMs, nowMs),
      0,
    );
    const recentTokens = sessionFiles.reduce(
      (sum, file) => sum + deltaBetween(file, nowMs - this.rateWindowMs, nowMs),
      0,
    );
    const tokensPerMinute =
      recentTokens * (60_000 / Math.max(this.rateWindowMs, 1));
    const historicalRates = completedTurnRates(files);
    const anomaly = classifyAnomaly({
      currentRate: tokensPerMinute,
      currentTurnTokens,
      currentTurnDurationMs: Math.max(0, nowMs - turnStartedAtMs),
      historicalRates,
    });
    const rateScale = buildRateScale({
      tokensPerMinute,
      medianTokensPerMinute: anomaly.baseline.medianTokensPerMinute,
      p95TokensPerMinute: anomaly.baseline.p95TokensPerMinute,
    });

    return {
      status: "bound",
      generatedAtMs: nowMs,
      threadId: root.meta.id,
      sessionId,
      cwd: root.meta.cwd,
      childAgentCount: Math.max(0, sessionFiles.length - 1),
      session: {
        totalTokens: sessionTotalTokens,
        lastHourTokens: sessionHourTokens,
        startedAtMs: Number.isFinite(sessionStartedAtMs)
          ? sessionStartedAtMs
          : null,
      },
      turn: {
        tokens: currentTurnTokens,
        startedAtMs: turnStartedAtMs,
      },
      context: {
        tokens: contextTokens,
        windowTokens: contextWindowTokens,
        percent:
          contextTokens != null && contextWindowTokens != null
            ? Math.min(100, Math.max(0, (contextTokens / contextWindowTokens) * 100))
            : null,
        compactionCount: root.contextCompactions?.length ?? 0,
        lastCompactedAtMs: root.contextCompactions?.at(-1) ?? null,
      },
      account: {
        lastHourTokens: allHourTokens,
      },
      rate: {
        tokensPerMinute,
        windowMs: this.rateWindowMs,
        ...rateScale,
      },
      anomaly,
    };
  }
}
