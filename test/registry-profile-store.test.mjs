import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import { applyRegistryMigrations } from "../server/registry-migrations.mjs";
import {
  FileRegistryStore,
  PostgresRegistryStore,
} from "../server/registry-store.mjs";

const alice = {
  meterId: "TM-AAAA-BBBB-CCCC",
  publicKey: "alice-key",
};
const bob = {
  meterId: "TM-DDDD-EEEE-FFFF",
  publicKey: "bob-key",
};

async function createProfileStore({ profileReads = true } = {}) {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  await applyRegistryMigrations(pool, { nowMs: 10, useAdvisoryLock: false });
  const store = new PostgresRegistryStore({ pool, profileReads });
  await store.init();
  return store;
}

function snapshot(identity, {
  handle = null,
  total,
  platform = "codex",
  generatedAtMs,
  nowMs,
}) {
  return {
    ...identity,
    handle,
    days: [{ date: "2026-08-15", total }],
    stats: {
      lifetimeTokens: total,
      sessionCount: 1,
      sessionsLast7Days: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
      peakDay: { date: "2026-08-15", tokens: total },
      byPlatform: {
        claudeCode: platform === "claudeCode" ? total : 0,
        codex: platform === "codex" ? total : 0,
        cline: 0,
      },
    },
    weekTokens: total,
    generatedAtMs,
    nowMs,
  };
}

test("profile reads fail closed until the additive migration exists", async () => {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const store = new PostgresRegistryStore({ pool: new adapter.Pool(), profileReads: true });
  await assert.rejects(store.init(), /profile migrations were applied/);
  await store.close();
});

test("v1 claim and report dual-write an identical one-device profile", async () => {
  const store = await createProfileStore();
  try {
    assert.deepEqual(
      await store.claim({ ...alice, handle: "alice", nowMs: 100 }),
      { claimed: true },
    );
    await store.report(snapshot(alice, {
      handle: "alice",
      total: 100,
      generatedAtMs: 200,
      nowMs: 201,
    }));

    const legacy = await store.pool.query(
      `SELECT days, stats, week_tokens, generated_at_ms
       FROM registry_meters WHERE meter_id = $1`,
      [alice.meterId],
    );
    const profile = await store.pool.query(
      `SELECT profile_id, owner_meter_id, handle, days, stats, week_tokens, generated_at_ms
       FROM registry_profiles WHERE profile_id = $1`,
      [alice.meterId],
    );
    assert.equal(profile.rows[0].profile_id, alice.meterId);
    assert.equal(profile.rows[0].owner_meter_id, alice.meterId);
    assert.equal(profile.rows[0].handle, "alice");
    assert.deepEqual(profile.rows[0].days, legacy.rows[0].days);
    assert.deepEqual(profile.rows[0].stats, legacy.rows[0].stats);
    assert.equal(profile.rows[0].week_tokens, legacy.rows[0].week_tokens);
    assert.equal(profile.rows[0].generated_at_ms, legacy.rows[0].generated_at_ms);

    assert.deepEqual(await store.profile("alice"), {
      handle: "alice",
      shared: true,
      days: [{ date: "2026-08-15", total: 100 }],
      stats: legacy.rows[0].stats,
      weekTokens: 100,
      updatedAtMs: 201,
    });
    const board = await store.leaderboard();
    assert.equal(board.length, 1);
    assert.equal(board[0].handle, "alice");
    assert.equal(board[0].tokens, 100);
  } finally {
    await store.close();
  }
});

test("profile rollup merges member snapshots while every meter remains isolated", async () => {
  const store = await createProfileStore();
  try {
    await store.claim({ ...alice, handle: "sergio", nowMs: 100 });
    await store.report(snapshot(alice, {
      handle: "sergio",
      total: 100,
      platform: "codex",
      generatedAtMs: 200,
      nowMs: 201,
    }));
    await store.pool.query(
      `INSERT INTO registry_meters (meter_id, public_key, updated_at_ms)
       VALUES ($1, $2, $3)`,
      [bob.meterId, bob.publicKey, 250],
    );
    await store.pool.query(
      `INSERT INTO registry_profile_devices
         (profile_id, meter_id, role, sharing_enabled, joined_at_ms)
       VALUES ($1, $2, 'member', FALSE, $3)`,
      [alice.meterId, bob.meterId, 250],
    );
    await store.report(snapshot(bob, {
      total: 250,
      platform: "claudeCode",
      generatedAtMs: 300,
      nowMs: 301,
    }));

    const profile = await store.profile("sergio");
    assert.equal(profile.weekTokens, 350);
    assert.equal(profile.stats.lifetimeTokens, 350);
    assert.equal(profile.stats.aggregation.deviceCount, 2);
    assert.deepEqual(profile.stats.byPlatform, {
      claudeCode: 250,
      codex: 100,
      cline: 0,
    });
    assert.equal((await store.leaderboard()).length, 1);

    const meters = await store.pool.query(
      "SELECT meter_id, week_tokens FROM registry_meters ORDER BY meter_id",
    );
    assert.deepEqual(meters.rows, [
      { meter_id: alice.meterId, week_tokens: 100 },
      { meter_id: bob.meterId, week_tokens: 250 },
    ]);

    await store.createBrowserPairing({
      ...bob,
      codeHash: "a".repeat(64),
      nowMs: 310,
      expiresAtMs: 500,
    });
    await store.exchangeBrowserPairing({
      codeHash: "a".repeat(64),
      sessionTokenHash: "b".repeat(64),
      nowMs: 320,
      sessionExpiresAtMs: 1_000,
    });
    const viewer = await store.viewerForBrowserSession({
      sessionTokenHash: "b".repeat(64),
      nowMs: 330,
    });
    assert.equal(viewer.meterId, bob.meterId);
    assert.equal(viewer.profileId, alice.meterId);
    assert.equal(viewer.handle, "sergio");
    assert.equal(viewer.rank, 1);
    assert.equal(viewer.totalMeters, 1);
    assert.equal(viewer.tokens, 350);

    assert.deepEqual(await store.withdraw({ ...bob, nowMs: 400 }), { wiped: true });
    const afterWithdraw = await store.profile("sergio");
    assert.equal(afterWithdraw.weekTokens, 100);
    assert.equal(afterWithdraw.stats.lifetimeTokens, 100);
  } finally {
    await store.close();
  }
});

test("file registry dual-writes and reads the same one-device profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-widget-profile-store-"));
  const store = new FileRegistryStore({
    dataFile: join(directory, "registry.json"),
    profileReads: true,
  });
  await store.init();
  await store.claim({ ...alice, handle: "alice", nowMs: 100 });
  await store.report(snapshot(alice, {
    handle: "alice",
    total: 100,
    generatedAtMs: 200,
    nowMs: 201,
  }));
  assert.equal((await store.leaderboard()).length, 1);
  assert.deepEqual(await store.profile("alice"), {
    handle: "alice",
    shared: true,
    days: [{ date: "2026-08-15", total: 100 }],
    stats: {
      lifetimeTokens: 100,
      sessionCount: 1,
      sessionsLast7Days: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
      peakDay: { date: "2026-08-15", tokens: 100 },
      byPlatform: { claudeCode: 0, codex: 100, cline: 0 },
    },
    weekTokens: 100,
    updatedAtMs: 201,
  });
});
