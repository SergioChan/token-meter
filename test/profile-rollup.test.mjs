import assert from "node:assert/strict";
import test from "node:test";
import { aggregateProfileSnapshots } from "../server/profile-rollup.mjs";

test("one-device profile rollup preserves the legacy snapshot byte-for-byte", () => {
  const snapshot = {
    days: [{ date: "2026-08-14", total: 50 }],
    stats: {
      lifetimeTokens: 75,
      sessionCount: 2,
      cacheReadShare: 0.5,
      byPlatform: { claudeCode: 75, codex: 0, cline: 0 },
    },
    weekTokens: 50,
    generatedAtMs: Date.parse("2026-08-15T12:00:00Z"),
    updatedAtMs: 500,
  };
  assert.deepEqual(aggregateProfileSnapshots([snapshot]), snapshot);
});

test("multi-device profile rollup sums additive fields and marks partial fields", () => {
  const generatedAtMs = Date.parse("2026-08-15T12:00:00Z");
  const rollup = aggregateProfileSnapshots([
    {
      days: [
        { date: "2026-08-13", total: 10 },
        { date: "2026-08-14", total: 20 },
      ],
      stats: {
        lifetimeTokens: 100,
        sessionCount: 2,
        sessionsLast7Days: 2,
        longestStreakDays: 2,
        largestSessionTokens: 70,
        longestSessionMs: 500,
        byPlatform: { claudeCode: 100, codex: 0, cline: 0 },
        hours: Array.from({ length: 24 }, (_, index) => index === 8 ? 10 : 0),
        byPlatformSessions: { claudeCode: 2, codex: 0, cline: 0 },
      },
      weekTokens: 30,
      generatedAtMs,
      updatedAtMs: 600,
    },
    {
      days: [
        { date: "2026-08-14", total: 30 },
        { date: "2026-08-15", total: 40 },
      ],
      stats: {
        lifetimeTokens: 200,
        sessionCount: 3,
        sessionsLast7Days: 1,
        longestStreakDays: 2,
        largestSessionTokens: 90,
        longestSessionMs: 700,
        byPlatform: { claudeCode: 0, codex: 200, cline: 0 },
        hours: Array.from({ length: 24 }, (_, index) => index === 9 ? 20 : 0),
        byPlatformSessions: { claudeCode: 0, codex: 3, cline: 0 },
      },
      weekTokens: 70,
      generatedAtMs,
      updatedAtMs: 700,
    },
  ]);

  assert.deepEqual(rollup.days, [
    { date: "2026-08-13", total: 10 },
    { date: "2026-08-14", total: 50 },
    { date: "2026-08-15", total: 40 },
  ]);
  assert.equal(rollup.weekTokens, 100);
  assert.equal(rollup.stats.lifetimeTokens, 300);
  assert.equal(rollup.stats.sessionCount, 5);
  assert.equal(rollup.stats.sessionsLast7Days, 3);
  assert.equal(rollup.stats.currentStreakDays, 3);
  assert.equal(rollup.stats.longestStreakDays, 3);
  assert.deepEqual(rollup.stats.byPlatform, {
    claudeCode: 100,
    codex: 200,
    cline: 0,
  });
  assert.equal(rollup.stats.largestSessionTokens, 90);
  assert.equal(rollup.stats.longestSessionMs, 700);
  assert.equal(rollup.stats.peakHour, 9);
  assert.deepEqual(rollup.stats.byPlatformSessions, {
    claudeCode: 2,
    codex: 3,
    cline: 0,
  });
  assert.deepEqual(rollup.stats.aggregation, {
    deviceCount: 2,
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
  });
});

test("profile rollup rejects unsafe aggregate overflow", () => {
  const snapshot = (total) => ({
    days: [{ date: "2026-08-15", total }],
    stats: {
      lifetimeTokens: total,
      sessionCount: 1,
      byPlatform: { claudeCode: total, codex: 0, cline: 0 },
    },
    weekTokens: total,
    generatedAtMs: Date.parse("2026-08-15T12:00:00Z"),
    updatedAtMs: 1,
  });
  assert.throws(
    () => aggregateProfileSnapshots([
      snapshot(Number.MAX_SAFE_INTEGER),
      snapshot(1),
    ]),
    /safe integer range/,
  );
});
