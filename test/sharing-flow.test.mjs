// End-to-end consent flows: a real in-process registry, a real dashboard
// server, and the real signing client between them. Only usage history is
// stubbed. Covers the product scenarios: brand-new users sharing right away,
// long-time local users sharing later, and existing members toggling off
// (server-side wipe) and back on.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryServer } from "../server/registry-server.mjs";
import { DashboardServer, handleCandidates } from "../src/core/dashboard-server.mjs";
import { createIdentity, isValidHandle, loadOrCreateIdentity, signPayload } from "../src/core/identity.mjs";
import { dateFallsInTrailingWindow } from "../src/core/usage-history.mjs";

const DAY_MS = 86_400_000;

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A realistic collect() result: `daysBack` days of history ending today.
function usageFixture(daysBack, perDay = 1_000) {
  const days = [];
  for (let i = daysBack - 1; i >= 0; i -= 1) {
    days.push({ date: localDateKey(Date.now() - i * DAY_MS), total: perDay });
  }
  const total = daysBack * perDay;
  return {
    generatedAtMs: Date.now(),
    days,
    hours: Array.from({ length: 24 }, (_, hour) => (hour === 11 ? total : 0)),
    stats: {
      lifetimeTokens: total,
      daysActive: daysBack,
      daysObserved: daysBack,
      firstActivityDate: days[0].date,
      avgPerActiveDay: perDay,
      peakDay: { date: days.at(-1).date, tokens: perDay },
      currentStreakDays: daysBack,
      longestStreakDays: daysBack,
      sessionCount: daysBack * 2,
      sessionsLast7Days: Math.min(daysBack, 7) * 2,
      medianSessionTokens: Math.round(perDay / 2),
      largestSessionTokens: perDay,
      longestSessionMs: 3_600_000,
      cacheReadShare: 0.95,
      outputShare: 0.004,
      peakHour: 11,
      busiestWeekday: 4,
      topDays: [{ date: days.at(-1).date, tokens: perDay }],
      byPlatform: {
        claudeCode: { tokens: total, sessions: daysBack * 2 },
        codex: { tokens: 0, sessions: 0 },
        cline: { tokens: 0, sessions: 0 },
      },
    },
  };
}

async function startWorld({ usage = usageFixture(30) } = {}) {
  const registryDir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(registryDir, "index.html"), "<!doctype html><title>home</title>");
  const registry = new RegistryServer({
    dataFile: join(registryDir, "data.json"),
    webDir: registryDir,
  });
  await registry.start(0);
  const registryBase = `http://127.0.0.1:${registry.port}`;
  process.env.TOKEN_METER_REGISTRY_URL = registryBase;

  const webDir = mkdtempSync(join(tmpdir(), "token-meter-web-"));
  writeFileSync(join(webDir, "dashboard.html"), "<!doctype html><title>dash</title>");
  writeFileSync(join(webDir, "share.html"), "<!doctype html><title>share</title>");
  const identityDir = mkdtempSync(join(tmpdir(), "token-meter-identity-"));
  const dashboard = new DashboardServer({
    webDir,
    identityDir,
    usageHistory: { collect: () => usage },
  });
  await dashboard.start();

  const token = new URL(dashboard.url()).searchParams.get("token");
  const dashboardBase = `http://127.0.0.1:${dashboard.port}`;
  return {
    registry,
    registryBase,
    dashboard,
    identityDir,
    api: {
      get: (path) => fetch(`${dashboardBase}${path}${path.includes("?") ? "&" : "?"}token=${token}`),
      post: (path, body) =>
        fetch(`${dashboardBase}${path}?token=${token}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
    },
    async stop() {
      await dashboard.stop();
      await registry.stop();
      delete process.env.TOKEN_METER_REGISTRY_URL;
    },
  };
}

test("new user shares immediately: publish claims the handle, uploads, and lands on the leaderboard", async () => {
  const world = await startWorld();
  try {
    const check = await (await world.api.get("/api/share/handle-check?handle=newbie")).json();
    assert.deepEqual(check, { valid: true, available: true });

    const publish = await world.api.post("/api/share/publish", { handle: "newbie", agree: true });
    const body = await publish.json();
    assert.equal(publish.status, 200);
    assert.equal(body.handle, "newbie");
    assert.equal(body.handleClaimed, true);
    assert.equal(body.sharing.enabled, true);
    assert.equal(body.sync, "ok");
    assert.match(body.profileUrl, /\/u\/newbie$/);
    assert.equal(body.privateKeyPem, undefined);

    const { rows } = await (await fetch(`${world.registryBase}/api/v1/leaderboard`)).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handle, "newbie");
    assert.equal(rows[0].name, "@newbie");
    assert.ok(rows[0].tokens > 0);

    const profile = await (await fetch(`${world.registryBase}/api/v1/profile/newbie`)).json();
    assert.equal(profile.shared, true);
    assert.equal(profile.stats.cacheReadShare, 0.95);
    assert.equal(profile.stats.hours.length, 24);
    assert.equal(profile.stats.byPlatformSessions.claudeCode, 60);
  } finally {
    await world.stop();
  }
});

test("long-time local user shares later: months of history upload in one publish", async () => {
  const world = await startWorld({ usage: usageFixture(150, 2_000) });
  try {
    const publish = await world.api.post("/api/share/publish", { handle: "veteran", agree: true });
    assert.equal(publish.status, 200);

    const profile = await (await fetch(`${world.registryBase}/api/v1/profile/veteran`)).json();
    assert.equal(profile.days.length, 119); // capped upload window
    assert.equal(profile.stats.lifetimeTokens, 300_000);
    assert.equal(profile.stats.firstActivityDate, usageFixture(150).stats.firstActivityDate);
    const expectedWeek = usageFixture(150, 2_000)
      .days.slice(-119)
      .filter((day) => dateFallsInTrailingWindow(day.date, Date.now()))
      .reduce((sum, day) => sum + day.total, 0);
    assert.equal(profile.weekTokens, expectedWeek);
  } finally {
    await world.stop();
  }
});

test("publish without the privacy agreement changes nothing anywhere", async () => {
  const world = await startWorld();
  try {
    const publish = await world.api.post("/api/share/publish", { handle: "eager", agree: false });
    assert.equal(publish.status, 422);
    const identity = loadOrCreateIdentity(world.identityDir);
    assert.equal(identity.handle, null);
    assert.equal(identity.sharing.enabled, false);
    const { rows } = await (await fetch(`${world.registryBase}/api/v1/leaderboard`)).json();
    assert.equal(rows.length, 0);
  } finally {
    await world.stop();
  }
});

test("taken handle: live check and publish both offer available suggestions, and publish stays atomic", async () => {
  const world = await startWorld();
  try {
    const rival = { ...createIdentity(), handle: "popular" };
    const claim = signPayload(rival, {
      kind: "claim",
      meterId: rival.meterId,
      publicKey: rival.publicKey,
      handle: "popular",
      generatedAtMs: Date.now(),
    });
    const claimed = await fetch(`${world.registryBase}/api/v1/claim`, {
      method: "POST",
      body: JSON.stringify(claim),
    });
    assert.equal(claimed.status, 200);

    const check = await (await world.api.get("/api/share/handle-check?handle=popular")).json();
    assert.equal(check.available, false);
    assert.ok(check.suggestions.length > 0);
    for (const suggestion of check.suggestions) {
      const { available } = await (
        await fetch(`${world.registryBase}/api/v1/handle/${suggestion}/available`)
      ).json();
      assert.equal(available, true, suggestion);
    }

    const publish = await world.api.post("/api/share/publish", { handle: "popular", agree: true });
    assert.equal(publish.status, 409);
    assert.ok((await publish.json()).suggestions.length > 0);
    const identity = loadOrCreateIdentity(world.identityDir);
    assert.equal(identity.handle, null); // restored — nothing half-published
    assert.equal(identity.sharing.enabled, false);
  } finally {
    await world.stop();
  }
});

test("withdraw wipes server data now, keeps the handle claim, and re-sharing restores the row", async () => {
  const world = await startWorld();
  try {
    await world.api.post("/api/share/publish", { handle: "cycler", agree: true });

    const noConfirm = await world.api.post("/api/share/withdraw", { confirm: false });
    assert.equal(noConfirm.status, 422);

    const withdraw = await world.api.post("/api/share/withdraw", { confirm: true });
    const body = await withdraw.json();
    assert.equal(withdraw.status, 200);
    assert.equal(body.wiped, true);
    assert.equal(body.sharing.enabled, false);

    const { rows } = await (await fetch(`${world.registryBase}/api/v1/leaderboard`)).json();
    assert.equal(rows.length, 0);
    const profile = await (await fetch(`${world.registryBase}/api/v1/profile/cycler`)).json();
    assert.deepEqual(profile, { handle: "cycler", shared: false });
    const { available } = await (
      await fetch(`${world.registryBase}/api/v1/handle/cycler/available`)
    ).json();
    assert.equal(available, false); // the claim survives the wipe

    const identity = loadOrCreateIdentity(world.identityDir);
    assert.equal(identity.handle, "cycler");
    assert.equal(identity.handleClaimed, true);

    // The classic "老用户" toggle: share again and the row comes back.
    const republish = await world.api.post("/api/share/publish", { handle: "cycler", agree: true });
    assert.equal(republish.status, 200);
    const back = await (await fetch(`${world.registryBase}/api/v1/leaderboard`)).json();
    assert.equal(back.rows.length, 1);
    assert.equal(back.rows[0].handle, "cycler");
  } finally {
    await world.stop();
  }
});

test("withdraw with the registry down still disables sharing and marks the wipe as pending", async () => {
  const world = await startWorld();
  try {
    await world.api.post("/api/share/publish", { handle: "offline", agree: true });
    await world.registry.stop();

    const withdraw = await world.api.post("/api/share/withdraw", { confirm: true });
    const body = await withdraw.json();
    assert.equal(withdraw.status, 200);
    assert.equal(body.wiped, false);
    assert.equal(body.pendingWithdraw, true);
    const identity = loadOrCreateIdentity(world.identityDir);
    assert.equal(identity.sharing.enabled, false);
    assert.equal(identity.sharing.pendingWithdraw, true); // the sync worker retries this
  } finally {
    await world.dashboard.stop();
    delete process.env.TOKEN_METER_REGISTRY_URL;
  }
});

test("handle suggestions are valid handles and never repeat the base", () => {
  for (const base of ["chandler", "a", "very-long-handle-near-the-cap-x"]) {
    for (const candidate of handleCandidates(base)) {
      assert.ok(isValidHandle(candidate), candidate);
      assert.notEqual(candidate, base);
    }
  }
  assert.ok(handleCandidates("chandler").length >= 4);
});
