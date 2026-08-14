import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { PostgresRegistryStore } from "../server/registry-store.mjs";

function createStore() {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new PostgresRegistryStore({ pool: new adapter.Pool() });
}

const alice = {
  meterId: "TM-AAAA-BBBB-CCCC",
  publicKey: "alice-key",
};
const bob = {
  meterId: "TM-DDDD-EEEE-FFFF",
  publicKey: "bob-key",
};

test("Postgres store persists an idempotent first-come handle claim", async () => {
  const store = createStore();
  await store.init();
  try {
    const [first, second] = await Promise.all([
      store.claim({ ...alice, handle: "alex", nowMs: 100 }),
      store.claim({ ...bob, handle: "alex", nowMs: 101 }),
    ]);
    assert.equal([first, second].filter((result) => result.claimed).length, 1);
    assert.equal(await store.handleAvailable("alex"), false);

    const winner = first.claimed ? alice : bob;
    assert.deepEqual(
      await store.claim({ ...winner, handle: "alex", nowMs: 102 }),
      { claimed: true },
    );
  } finally {
    await store.close();
  }
});

test("Postgres store keeps the newest signed usage snapshot", async () => {
  const store = createStore();
  await store.init();
  try {
    assert.deepEqual(
      await store.claim({ ...alice, handle: "casey", nowMs: 100 }),
      { claimed: true },
    );
    const base = {
      ...alice,
      handle: "casey",
      days: [{ date: "2026-08-13", total: 5_000_000 }],
      stats: { lifetimeTokens: 9_000_000, sessionCount: 4, sessionsLast7Days: 2 },
      weekTokens: 5_000_000,
    };
    assert.deepEqual(
      await store.report({ ...base, generatedAtMs: 200, nowMs: 201 }),
      { accepted: true, ignored: false },
    );
    assert.deepEqual(
      await store.report({
        ...base,
        days: [{ date: "2026-08-13", total: 1 }],
        stats: { lifetimeTokens: 1, sessionCount: 1 },
        weekTokens: 1,
        generatedAtMs: 150,
        nowMs: 202,
      }),
      { accepted: true, ignored: true },
    );
    assert.deepEqual(
      await store.report({
        ...base,
        stats: { lifetimeTokens: 10_000_000, sessionCount: 5 },
        weekTokens: 6_000_000,
        generatedAtMs: 300,
        nowMs: 301,
      }),
      { accepted: true, ignored: false },
    );

    const profile = await store.profile("casey");
    assert.equal(profile.weekTokens, 6_000_000);
    assert.equal(profile.stats.lifetimeTokens, 10_000_000);
    assert.equal(profile.stats.sessionsLast7Days, 2);
    const row = (await store.leaderboard())[0];
    assert.equal(row.name, "@casey");
    assert.equal(row.sessions, 2);
    assert.equal(row.sessionWindowDays, 7);
    assert.deepEqual(await store.health(), { meters: 1 });
  } finally {
    await store.close();
  }
});

test("Postgres store hashes one-time pairings and resolves authenticated rank", async () => {
  const store = createStore();
  await store.init();
  try {
    const codeHash = "a".repeat(64);
    const sessionTokenHash = "b".repeat(64);
    assert.deepEqual(
      await store.createBrowserPairing({
        ...alice,
        codeHash,
        nowMs: 100,
        expiresAtMs: 400,
      }),
      { created: true },
    );
    const persisted = await store.pool.query(
      "SELECT code_hash, meter_id FROM registry_browser_pairings",
    );
    assert.equal(persisted.rows[0].code_hash.trim(), codeHash);
    assert.equal(persisted.rows[0].meter_id, alice.meterId);
    assert.deepEqual(
      await store.exchangeBrowserPairing({
        codeHash,
        sessionTokenHash,
        nowMs: 200,
        sessionExpiresAtMs: 1_000,
      }),
      { exchanged: true, meterId: alice.meterId, expiresAtMs: 1_000 },
    );
    assert.equal(
      (await store.exchangeBrowserPairing({
        codeHash,
        sessionTokenHash: "c".repeat(64),
        nowMs: 201,
        sessionExpiresAtMs: 1_000,
      })).exchanged,
      false,
    );
    const beforeSharing = await store.viewerForBrowserSession({
      sessionTokenHash,
      nowMs: 300,
    });
    assert.equal(beforeSharing.rank, null);
    assert.equal(beforeSharing.sharingReported, false);

    const base = {
      handle: null,
      days: [{ date: "2026-08-13", total: 1 }],
      stats: { lifetimeTokens: 1, sessionCount: 1, sessionsLast7Days: 1 },
      generatedAtMs: 500,
      nowMs: 501,
    };
    await store.report({ ...base, ...bob, weekTokens: 20_000 });
    await store.report({ ...base, ...alice, weekTokens: 10_000 });
    const viewer = await store.viewerForBrowserSession({
      sessionTokenHash,
      nowMs: 600,
    });
    assert.equal(viewer.rank, 2);
    assert.equal(viewer.totalMeters, 2);
    assert.equal(viewer.tokens, 10_000);
    assert.equal(viewer.sessions, 1);
    assert.equal(viewer.sessionWindowDays, 7);
    assert.equal(viewer.rowId, (await store.leaderboard())[1].rowId);
    assert.equal(await store.revokeBrowserSession(sessionTokenHash), true);
    assert.equal(
      await store.viewerForBrowserSession({ sessionTokenHash, nowMs: 601 }),
      null,
    );
  } finally {
    await store.close();
  }
});

test("Postgres store withdraw wipes usage, keeps the claim, and re-reporting restores the row", async () => {
  const store = createStore();
  await store.init();
  try {
    await store.claim({ ...alice, handle: "drew", nowMs: 100 });
    await store.report({
      ...alice,
      handle: "drew",
      days: [{ date: "2026-08-13", total: 500 }],
      stats: { lifetimeTokens: 500, sessionCount: 1 },
      weekTokens: 500,
      generatedAtMs: 200,
      nowMs: 201,
    });
    assert.equal((await store.leaderboard()).length, 1);

    // Wrong key never wipes someone else's data.
    assert.deepEqual(
      await store.withdraw({ meterId: alice.meterId, publicKey: bob.publicKey, nowMs: 300 }),
      { wiped: false, reason: "identity-collision" },
    );

    assert.deepEqual(
      await store.withdraw({ ...alice, nowMs: 301 }),
      { wiped: true },
    );
    assert.deepEqual(await store.leaderboard(), []);
    assert.deepEqual(await store.profile("drew"), { handle: "drew", shared: false });
    assert.equal(await store.handleAvailable("drew"), false);

    // Idempotent: nothing left to wipe.
    assert.deepEqual(await store.withdraw({ ...alice, nowMs: 302 }), { wiped: false });

    // Re-sharing works even with an older generatedAtMs than the wiped one.
    await store.report({
      ...alice,
      handle: "drew",
      days: [{ date: "2026-08-14", total: 900 }],
      stats: { lifetimeTokens: 900, sessionCount: 2 },
      weekTokens: 900,
      generatedAtMs: 150,
      nowMs: 400,
    });
    const rows = await store.leaderboard();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].handle, "drew");
    assert.equal(rows[0].tokens, 900);
  } finally {
    await store.close();
  }
});
