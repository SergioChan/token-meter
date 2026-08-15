import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import {
  applyRegistryMigrations,
  migrationStatus,
  reconcileRegistryProfiles,
  registryMigrations,
  verifyRegistryProfileMigration,
} from "../server/registry-migrations.mjs";
import {
  FileRegistryStore,
  POSTGRES_SCHEMA_SQL,
} from "../server/registry-store.mjs";

function createPool() {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool();
}

async function seedLegacyRegistry(pool) {
  await pool.query(POSTGRES_SCHEMA_SQL);
  await pool.query(
    `INSERT INTO registry_meters
       (meter_id, public_key, handle, days, stats, week_tokens, generated_at_ms, updated_at_ms)
     VALUES
       ('TM-AAAA-BBBB-CCCC', 'alice-key', 'alice', '[{"date":"2026-08-14","total":50}]',
        '{"lifetimeTokens":75,"sessionCount":2}', 50, 200, 201),
       ('TM-DDDD-EEEE-FFFF', 'bob-key', NULL, '[]', '{}', 0, NULL, 150)`,
  );
  await pool.query(
    `INSERT INTO registry_handles
       (handle, meter_id, public_key, claimed_at_ms)
     VALUES ('alice', 'TM-AAAA-BBBB-CCCC', 'alice-key', 100)`,
  );
}

test("registry migrations backfill one profile and owner device per legacy meter", async () => {
  const pool = createPool();
  try {
    await seedLegacyRegistry(pool);
    assert.deepEqual(
      await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false }),
      { applied: [1, 2] },
    );

    const profiles = await pool.query(
      `SELECT profile_id, owner_meter_id, handle, days, stats, week_tokens,
              generated_at_ms, updated_at_ms, created_at_ms
       FROM registry_profiles
       ORDER BY profile_id`,
    );
    assert.equal(profiles.rowCount, 2);
    assert.deepEqual(profiles.rows[0], {
      profile_id: "TM-AAAA-BBBB-CCCC",
      owner_meter_id: "TM-AAAA-BBBB-CCCC",
      handle: "alice",
      days: [{ date: "2026-08-14", total: 50 }],
      stats: { lifetimeTokens: 75, sessionCount: 2 },
      week_tokens: 50,
      generated_at_ms: 200,
      updated_at_ms: 201,
      created_at_ms: 100,
    });
    assert.equal(profiles.rows[1].handle, null);
    assert.equal(profiles.rows[1].generated_at_ms, null);

    const devices = await pool.query(
      `SELECT profile_id, meter_id, role, sharing_enabled, joined_at_ms,
              last_reported_at_ms, revoked_at_ms
       FROM registry_profile_devices
       ORDER BY meter_id`,
    );
    assert.equal(devices.rowCount, 2);
    assert.deepEqual(devices.rows[0], {
      profile_id: "TM-AAAA-BBBB-CCCC",
      meter_id: "TM-AAAA-BBBB-CCCC",
      role: "owner",
      sharing_enabled: true,
      joined_at_ms: 100,
      last_reported_at_ms: 201,
      revoked_at_ms: null,
    });
    assert.equal(devices.rows[1].sharing_enabled, false);

    const handle = await pool.query(
      "SELECT meter_id, profile_id FROM registry_handles WHERE handle = 'alice'",
    );
    assert.deepEqual(handle.rows[0], {
      meter_id: "TM-AAAA-BBBB-CCCC",
      profile_id: "TM-AAAA-BBBB-CCCC",
    });

    assert.deepEqual(await verifyRegistryProfileMigration(pool), {
      ok: true,
      checks: {
        meters: 2,
        profiles: 2,
        devices: 2,
        handles: 1,
        metersWithoutDevice: 0,
        devicesWithoutProfile: 0,
        profilesWithoutOwnerMembership: 0,
        unexpectedOwnerMemberships: 0,
        deviceSharingStateMismatches: 0,
        handlesWithoutProfile: 0,
        handleProfileMismatches: 0,
        rollupMismatches: 0,
      },
    });
  } finally {
    await pool.end();
  }
});

test("registry migrations are idempotent and checksummed", async () => {
  const pool = createPool();
  try {
    assert.deepEqual(
      await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false }),
      { applied: [1, 2] },
    );
    assert.deepEqual(
      await applyRegistryMigrations(pool, { nowMs: 2_000, useAdvisoryLock: false }),
      { applied: [] },
    );
    assert.deepEqual(
      (await migrationStatus(pool)).map(({ version, state }) => ({ version, state })),
      [
        { version: 1, state: "applied" },
        { version: 2, state: "applied" },
      ],
    );

    const changed = registryMigrations().map((migration) => ({ ...migration }));
    changed[0].checksum = "0".repeat(64);
    await assert.rejects(
      applyRegistryMigrations(pool, {
        nowMs: 3_000,
        useAdvisoryLock: false,
        migrations: changed,
      }),
      /migration 1 checksum mismatch/,
    );
    const versions = await pool.query(
      "SELECT version, applied_at_ms FROM registry_schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.rows, [
      { version: 1, applied_at_ms: 1_000 },
      { version: 2, applied_at_ms: 1_000 },
    ]);
  } finally {
    await pool.end();
  }
});

test("profile migration verification reports broken handle ownership", async () => {
  const pool = createPool();
  try {
    await seedLegacyRegistry(pool);
    await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false });
    await pool.query("UPDATE registry_profiles SET handle = NULL WHERE handle = 'alice'");
    const verification = await verifyRegistryProfileMigration(pool);
    assert.equal(verification.ok, false);
    assert.equal(verification.checks.handleProfileMismatches, 1);
  } finally {
    await pool.end();
  }
});

test("profile migration verification detects a stale shadow rollup", async () => {
  const pool = createPool();
  try {
    await seedLegacyRegistry(pool);
    await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false });
    await pool.query(
      "UPDATE registry_profiles SET week_tokens = 999 WHERE handle = 'alice'",
    );
    const verification = await verifyRegistryProfileMigration(pool);
    assert.equal(verification.ok, false);
    assert.equal(verification.checks.rollupMismatches, 1);
  } finally {
    await pool.end();
  }
});

test("profile reconciliation catches a meter written by a late v1 server", async () => {
  const pool = createPool();
  try {
    await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false });
    await pool.query(
      `INSERT INTO registry_meters
         (meter_id, public_key, handle, days, stats, week_tokens,
          generated_at_ms, updated_at_ms)
       VALUES
          ('TM-LATE-V111-WRIT', 'late-key', 'late',
           '[{"date":"2026-08-15","total":42}]',
          '{"lifetimeTokens":42,"sessionCount":1}', 42, 2000, 2001)`,
    );
    await pool.query(
      `INSERT INTO registry_handles
         (handle, meter_id, public_key, claimed_at_ms, profile_id)
       VALUES ('late', 'TM-LATE-V111-WRIT', 'late-key', 1500, NULL)`,
    );
    assert.equal((await verifyRegistryProfileMigration(pool)).ok, false);
    assert.deepEqual(
      await reconcileRegistryProfiles(pool, { useAdvisoryLock: false }),
      {
        reconciledProfiles: ["TM-LATE-V111-WRIT"],
        reconciledDevices: [],
        reconciledHandles: [],
        reconciledRollups: [],
      },
    );
    assert.equal((await verifyRegistryProfileMigration(pool)).ok, true);
    assert.deepEqual(
      await reconcileRegistryProfiles(pool, { useAdvisoryLock: false }),
      {
        reconciledProfiles: [],
        reconciledDevices: [],
        reconciledHandles: [],
        reconciledRollups: [],
      },
    );
  } finally {
    await pool.end();
  }
});

test("profile reconciliation repairs late v1 reports, withdrawals, and owner handle claims", async () => {
  const pool = createPool();
  try {
    await seedLegacyRegistry(pool);
    await applyRegistryMigrations(pool, { nowMs: 1_000, useAdvisoryLock: false });

    // Alice was already sharing when migration 2 ran. A warm v1 instance then
    // accepts a newer report but knows nothing about the Profile shadow row.
    await pool.query(
      `UPDATE registry_meters
       SET days = '[{"date":"2026-08-15","total":90}]'::jsonb,
           stats = '{"lifetimeTokens":90,"sessionCount":3}'::jsonb,
           week_tokens = 90,
           generated_at_ms = 3000,
           updated_at_ms = 3001
       WHERE meter_id = 'TM-AAAA-BBBB-CCCC'`,
    );

    // Bob was local-only during migration. A late v1 claim + report must attach
    // to Bob's existing owner Profile without creating or stealing a handle.
    await pool.query(
      `UPDATE registry_meters
       SET handle = 'bob',
           days = '[{"date":"2026-08-15","total":25}]'::jsonb,
           stats = '{"lifetimeTokens":25,"sessionCount":1}'::jsonb,
           week_tokens = 25,
           generated_at_ms = 4000,
           updated_at_ms = 4001
       WHERE meter_id = 'TM-DDDD-EEEE-FFFF'`,
    );
    await pool.query(
      `INSERT INTO registry_handles
         (handle, meter_id, public_key, claimed_at_ms, profile_id)
       VALUES ('bob', 'TM-DDDD-EEEE-FFFF', 'bob-key', 3999, NULL)`,
    );

    assert.equal((await verifyRegistryProfileMigration(pool)).ok, false);
    assert.deepEqual(
      await reconcileRegistryProfiles(pool, { useAdvisoryLock: false }),
      {
        reconciledProfiles: [],
        reconciledDevices: ["TM-AAAA-BBBB-CCCC", "TM-DDDD-EEEE-FFFF"],
        reconciledHandles: ["bob"],
        reconciledRollups: ["TM-AAAA-BBBB-CCCC", "TM-DDDD-EEEE-FFFF"],
      },
    );
    assert.equal((await verifyRegistryProfileMigration(pool)).ok, true);

    const bob = await pool.query(
      `SELECT p.handle, p.week_tokens, d.sharing_enabled, h.profile_id
       FROM registry_profiles AS p
       JOIN registry_profile_devices AS d ON d.profile_id = p.profile_id
       JOIN registry_handles AS h ON h.profile_id = p.profile_id
       WHERE p.profile_id = 'TM-DDDD-EEEE-FFFF'`,
    );
    assert.deepEqual(bob.rows[0], {
      handle: "bob",
      week_tokens: 25,
      sharing_enabled: true,
      profile_id: "TM-DDDD-EEEE-FFFF",
    });

    // A late v1 withdrawal also converges: it hides the device contribution
    // and therefore the single-device Profile without releasing the handle.
    await pool.query(
      `UPDATE registry_meters
       SET days = '[]'::jsonb,
           stats = '{}'::jsonb,
           week_tokens = 0,
           generated_at_ms = NULL,
           updated_at_ms = 5001
       WHERE meter_id = 'TM-DDDD-EEEE-FFFF'`,
    );
    const withdrawal = await reconcileRegistryProfiles(pool, { useAdvisoryLock: false });
    assert.deepEqual(withdrawal.reconciledDevices, ["TM-DDDD-EEEE-FFFF"]);
    assert.deepEqual(withdrawal.reconciledRollups, ["TM-DDDD-EEEE-FFFF"]);
    assert.equal((await verifyRegistryProfileMigration(pool)).ok, true);
  } finally {
    await pool.end();
  }
});

test("file registry migration backfills profiles atomically without changing legacy records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-widget-file-migration-"));
  const dataFile = join(directory, "registry.json");
  const legacy = {
    handles: {
      alice: {
        meterId: "TM-AAAA-BBBB-CCCC",
        publicKey: "alice-key",
        claimedAtMs: 100,
      },
    },
    meters: {
      "TM-AAAA-BBBB-CCCC": {
        publicKey: "alice-key",
        handle: "alice",
        days: [{ date: "2026-08-14", total: 50 }],
        stats: { lifetimeTokens: 75 },
        weekTokens: 50,
        generatedAtMs: 200,
        updatedAtMs: 201,
      },
    },
    browserPairings: {},
    browserSessions: {},
  };
  writeFileSync(dataFile, JSON.stringify(legacy));
  const store = new FileRegistryStore({ dataFile });
  await store.init();
  await store.close();

  const migrated = JSON.parse(readFileSync(dataFile, "utf8"));
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.meters, legacy.meters);
  assert.equal(migrated.handles.alice.profileId, "TM-AAAA-BBBB-CCCC");
  assert.deepEqual(migrated.profiles["TM-AAAA-BBBB-CCCC"], {
    ownerMeterId: "TM-AAAA-BBBB-CCCC",
    handle: "alice",
    days: [{ date: "2026-08-14", total: 50 }],
    stats: { lifetimeTokens: 75 },
    weekTokens: 50,
    generatedAtMs: 200,
    updatedAtMs: 201,
    createdAtMs: 100,
    rollupVersion: 1,
    timeZone: null,
  });
  assert.equal(migrated.profileDevices["TM-AAAA-BBBB-CCCC"].role, "owner");
  assert.equal(migrated.profileDevices["TM-AAAA-BBBB-CCCC"].sharingEnabled, true);

  const secondLoad = new FileRegistryStore({ dataFile });
  await secondLoad.init();
  assert.deepEqual(JSON.parse(readFileSync(dataFile, "utf8")), migrated);
});
