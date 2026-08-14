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
