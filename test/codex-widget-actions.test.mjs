import assert from "node:assert/strict";
import test from "node:test";
import { CodexWidgetActions } from "../integrations/codex-desktop/src/widget-actions.mjs";

const identity = {
  meterId: "TM-TEST-FAKE-9WFD",
  handle: "sergio",
  sharing: { enabled: true },
};

function harness(overrides = {}) {
  const opened = [];
  const copied = [];
  const dashboard = {
    async start() {},
    url: () => "http://127.0.0.1:4567/?token=0123456789abcdef0123456789abcdef",
    async stop() {},
  };
  return {
    opened,
    copied,
    actions: new CodexWidgetActions({
      identityLoader: () => identity,
      sharingSetter: (enabled) => ({
        ...identity,
        sharing: { enabled },
      }),
      usageHistory: {
        collectCached: () => ({
          stats: { lifetimeTokens: 42, currentStreakDays: 3 },
        }),
      },
      dashboardFactory: () => dashboard,
      leaderboardUrlFactory: async () =>
        "https://www.tokenwidget.app/leaderboard#pair=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      opener: async (url) => opened.push(url),
      clipboardWriter: async (text) => copied.push(text),
      registryChecker: () => false,
      ...overrides,
    }),
  };
}

test("Codex widget actions decorate snapshots and open trusted pages", async () => {
  const { actions, opened } = harness();
  const snapshot = actions.decorateSnapshot({});
  assert.equal(snapshot.meterId, identity.meterId);
  assert.equal(snapshot.meterHandle, "sergio");
  assert.equal(snapshot.sharingEnabled, true);
  assert.deepEqual(snapshot.meterStats, {
    lifetimeTokens: 42,
    currentStreakDays: 3,
  });

  assert.equal(await actions.handle({ type: "open-dashboard" }), true);
  assert.equal(await actions.handle({ type: "open-leaderboard" }), true);
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:/);
  assert.match(opened[1], /^https:\/\/www\.tokenwidget\.app\/leaderboard#pair=/);
  await actions.stop();
});

test("Codex widget actions validate state and renderer-provided data", async () => {
  const { actions, copied } = harness();
  assert.equal(await actions.handle({ type: "set-sharing", enabled: false }), true);
  assert.equal(actions.decorateSnapshot({}).sharingEnabled, false);
  assert.equal(await actions.handle({ type: "copy-text", text: "Token Widget" }), true);
  assert.deepEqual(copied, ["Token Widget"]);
  await assert.rejects(
    actions.handle({ type: "set-sharing", enabled: "false" }),
    /must be a boolean/,
  );
  await assert.rejects(
    actions.handle({ type: "copy-text", text: "x".repeat(501) }),
    /clipboard text is invalid/,
  );
});

test("Codex widget actions reject URLs outside the trusted surfaces", async () => {
  const { actions } = harness({
    leaderboardUrlFactory: async () => "https://attacker.example/leaderboard#pair=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  await assert.rejects(
    actions.handle({ type: "open-leaderboard" }),
    /unsafe URL/,
  );
});

test("Codex widget actions schedule independent community sync", async () => {
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const syncReasons = [];
  const logs = [];
  const timer = (collection) => (callback, delay) => {
    const value = { callback, delay, unref() {} };
    collection.push(value);
    return value;
  };
  const { actions } = harness({
    registryChecker: () => true,
    communitySyncRunner: async (reason) => {
      syncReasons.push(reason);
      return { ok: true };
    },
    timeoutScheduler: timer(timeouts),
    intervalScheduler: timer(intervals),
    timeoutClearer: (value) => clearedTimeouts.push(value),
    intervalClearer: (value) => clearedIntervals.push(value),
    logger: (message) => logs.push(message),
  });

  actions.start();
  actions.start();
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 15_000);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 3_600_000);

  await timeouts[0].callback();
  await actions.syncCommunity("manual");
  assert.deepEqual(syncReasons, ["startup", "manual"]);
  assert.deepEqual(logs, [
    "community sync ok (startup)",
    "community sync ok (manual)",
  ]);

  await actions.stop();
  assert.deepEqual(clearedTimeouts, []);
  assert.deepEqual(clearedIntervals, [intervals[0]]);
});
