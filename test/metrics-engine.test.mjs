import assert from "node:assert/strict";
import test from "node:test";
import { MetricsEngine } from "../src/core/metrics-engine.mjs";

const minute = 60_000;

function usage(
  timestampMs,
  totalTokens,
  { contextTokens = totalTokens, contextWindow = 200000 } = {},
) {
  return {
    kind: "usage",
    timestampMs,
    total: {
      totalTokens,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: contextTokens,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    contextWindow,
  };
}

function rollout({
  id,
  sessionId = id,
  threadSource = "user",
  modifiedMs = 0,
  usageEvents = [],
  userMessages = [],
  turnCompletions = [],
  contextCompactions = [],
}) {
  return {
    path: `/tmp/${id}.jsonl`,
    discoveredId: id,
    modifiedMs,
    meta: {
      id,
      sessionId,
      source: threadSource === "user" ? "vscode" : { subagent: {} },
      threadSource,
      cwd: "/repo",
      timestampMs: 0,
    },
    usage: usageEvents,
    userMessages,
    turnCompletions,
    turnAborts: [],
    contextCompactions,
  };
}

test("snapshot follows the selected session and includes its child agents", () => {
  const rootA = rollout({
    id: "session-a",
    modifiedMs: 10 * minute,
    userMessages: [0, 4 * minute],
    usageEvents: [usage(1 * minute, 100), usage(5 * minute, 500)],
  });
  const childA = rollout({
    id: "child-a",
    sessionId: "session-a",
    threadSource: "subagent",
    modifiedMs: 9 * minute,
    usageEvents: [usage(2 * minute, 50), usage(5.5 * minute, 100)],
  });
  const rootB = rollout({
    id: "session-b",
    modifiedMs: 11 * minute,
    userMessages: [0],
    usageEvents: [usage(5 * minute, 70)],
  });

  const snapshot = new MetricsEngine().snapshot([rootA, childA, rootB], {
    threadId: "session-a",
    nowMs: 6 * minute,
  });

  assert.equal(snapshot.threadId, "session-a");
  assert.equal(snapshot.session.totalTokens, 600);
  assert.equal(snapshot.session.lastHourTokens, 600);
  assert.equal(snapshot.account.lastHourTokens, 670);
  assert.equal(snapshot.turn.tokens, 450);
  assert.equal(snapshot.childAgentCount, 1);
});

test("snapshot does not substitute another session when the UI thread is unknown", () => {
  const file = rollout({ id: "known", usageEvents: [usage(1, 10)] });
  const snapshot = new MetricsEngine().snapshot([file], {
    threadId: "missing",
    nowMs: minute,
  });
  assert.equal(snapshot.status, "unbound");
  assert.equal(snapshot.requestedThreadId, "missing");
});

test("snapshot exposes Codex-reported active context after compaction", () => {
  const file = rollout({
    id: "compacted",
    usageEvents: [
      usage(1, 293_394, { contextTokens: 293_394, contextWindow: 353_400 }),
      usage(2, 293_394, { contextTokens: 26_976, contextWindow: 353_400 }),
      usage(3, 324_098, { contextTokens: 30_704, contextWindow: 353_400 }),
    ],
    contextCompactions: [2],
  });

  const snapshot = new MetricsEngine().snapshot([file], {
    threadId: "compacted",
    nowMs: 3,
  });

  assert.equal(snapshot.session.totalTokens, 324_098);
  assert.equal(snapshot.context.tokens, 30_704);
  assert.equal(snapshot.context.windowTokens, 353_400);
  assert.equal(snapshot.context.compactionCount, 1);
  assert.equal(snapshot.context.lastCompactedAtMs, 2);
  assert.ok(Math.abs(snapshot.context.percent - 8.68817) < 0.0001);
});

test("anomaly warning compares current rate against completed historical turns", () => {
  const historical = Array.from({ length: 6 }, (_, index) =>
    rollout({
      id: `history-${index}`,
      modifiedMs: index,
      userMessages: [0],
      turnCompletions: [minute],
      usageEvents: [usage(minute, 1_000 + index * 10)],
    }),
  );
  const active = rollout({
    id: "active",
    modifiedMs: 100,
    userMessages: [0],
    usageEvents: [usage(30_000, 60_000)],
  });

  const snapshot = new MetricsEngine().snapshot([...historical, active], {
    threadId: "active",
    nowMs: 30_000,
  });
  assert.equal(snapshot.anomaly.level, "critical");
  assert.equal(snapshot.anomaly.baseline.sampleCount, 6);
  assert.ok(snapshot.anomaly.ratio > 50);
});

test("completed turns in the active session contribute to its baseline", () => {
  const active = rollout({
    id: "long-running-session",
    modifiedMs: 100,
    userMessages: [0, 2, 4, 6, 8, 10, 12].map((value) => value * minute),
    turnCompletions: [1, 3, 5, 7, 9, 11].map((value) => value * minute),
    usageEvents: [
      ...[1, 3, 5, 7, 9, 11].map((value, index) =>
        usage(value * minute, (index + 1) * 1_000),
      ),
      usage(12.5 * minute, 66_000),
    ],
  });

  const snapshot = new MetricsEngine().snapshot([active], {
    threadId: active.meta.id,
    nowMs: 12.5 * minute,
  });
  assert.equal(snapshot.anomaly.baseline.sampleCount, 6);
  assert.equal(snapshot.anomaly.level, "critical");
});
