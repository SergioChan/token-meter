import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { aggregateProfileSnapshots } from "./profile-rollup.mjs";

const MIGRATION_LOCK_KEY = 1_938_410_327;

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS registry_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at_ms BIGINT NOT NULL
);
`;

const migrationFiles = [
  [1, "legacy-registry", "./migrations/001_legacy_registry.sql"],
  [2, "profiles-and-devices", "./migrations/002_profiles_and_devices.sql"],
];

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

export function registryMigrations() {
  return migrationFiles.map(([version, name, relativePath]) => {
    const sql = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    return { version, name, sql, checksum: checksum(sql) };
  });
}

async function appliedMigrations(client) {
  const result = await client.query(
    `SELECT version, name, checksum, applied_at_ms
     FROM registry_schema_migrations
     ORDER BY version ASC`,
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: String(row.checksum).trim(),
    appliedAtMs: Number(row.applied_at_ms),
  }));
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS count
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return Number(result.rows[0].count) === 1;
}

async function ensureMigrationTable(client) {
  if (!await tableExists(client, "registry_schema_migrations")) {
    await client.query(MIGRATION_TABLE_SQL);
  }
}

async function legacySchemaExists(client) {
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'registry_meters',
         'registry_handles',
         'registry_browser_pairings',
         'registry_browser_sessions'
       )`,
  );
  return Number(result.rows[0].count) === 4;
}

async function executeMigrationSql(client, sql) {
  for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
    await client.query(statement);
  }
}

export async function migrationStatus(pool, { createTable = false } = {}) {
  const client = await pool.connect();
  try {
    if (createTable) await ensureMigrationTable(client);
    let applied = [];
    try {
      applied = await appliedMigrations(client);
    } catch (error) {
      if (!/registry_schema_migrations/i.test(String(error?.message))) throw error;
    }
    const byVersion = new Map(applied.map((migration) => [migration.version, migration]));
    return registryMigrations().map((migration) => {
      const existing = byVersion.get(migration.version) ?? null;
      return {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        state: existing == null
          ? "pending"
          : existing.checksum === migration.checksum
            ? "applied"
            : "checksum-mismatch",
        appliedAtMs: existing?.appliedAtMs ?? null,
      };
    });
  } finally {
    client.release();
  }
}

export async function applyRegistryMigrations(
  pool,
  {
    nowMs = Date.now(),
    useAdvisoryLock = true,
    migrations = registryMigrations(),
  } = {},
) {
  const client = await pool.connect();
  let locked = false;
  try {
    if (useAdvisoryLock) {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      locked = true;
    }
    await client.query("BEGIN");
    await ensureMigrationTable(client);
    const applied = new Map(
      (await appliedMigrations(client)).map((migration) => [migration.version, migration]),
    );
    const newlyApplied = [];
    for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `migration ${migration.version} checksum mismatch: database=${existing.checksum} source=${migration.checksum}`,
          );
        }
        continue;
      }
      const baselineExistingSchema =
        migration.version === 1 && await legacySchemaExists(client);
      if (!baselineExistingSchema) await executeMigrationSql(client, migration.sql);
      await client.query(
        `INSERT INTO registry_schema_migrations
           (version, name, checksum, applied_at_ms)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, nowMs],
      );
      newlyApplied.push(migration.version);
    }
    await client.query("COMMIT");
    return { applied: newlyApplied };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

export async function reconcileRegistryProfiles(
  pool,
  { useAdvisoryLock = true } = {},
) {
  const client = await pool.connect();
  let locked = false;
  try {
    if (useAdvisoryLock) {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      locked = true;
    }
    await client.query("BEGIN");
    const missing = await client.query(
      `SELECT m.meter_id, m.days, m.stats, m.week_tokens, m.generated_at_ms,
              m.updated_at_ms, h.handle, h.claimed_at_ms
       FROM registry_meters AS m
       LEFT JOIN registry_profile_devices AS d ON d.meter_id = m.meter_id
       LEFT JOIN registry_handles AS h ON h.meter_id = m.meter_id
       WHERE d.meter_id IS NULL
       ORDER BY m.meter_id`,
    );
    const reconciledProfiles = [];
    for (const candidate of missing.rows) {
      await client.query(
        "SELECT meter_id FROM registry_meters WHERE meter_id = $1 FOR UPDATE",
        [candidate.meter_id],
      );
      const membership = await client.query(
        "SELECT profile_id FROM registry_profile_devices WHERE meter_id = $1",
        [candidate.meter_id],
      );
      if (membership.rowCount > 0) continue;
      const current = await client.query(
        `SELECT m.meter_id, m.days, m.stats, m.week_tokens, m.generated_at_ms,
                m.updated_at_ms, h.handle, h.claimed_at_ms
         FROM registry_meters AS m
         LEFT JOIN registry_handles AS h ON h.meter_id = m.meter_id
         WHERE m.meter_id = $1`,
        [candidate.meter_id],
      );
      const meter = current.rows[0];
      const profileId = meter.meter_id;
      const createdAtMs = Number(meter.claimed_at_ms ?? meter.updated_at_ms);
      await client.query(
        `INSERT INTO registry_profiles
           (profile_id, owner_meter_id, handle, days, stats, week_tokens,
            generated_at_ms, updated_at_ms, created_at_ms)
         VALUES ($1, $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
         ON CONFLICT (profile_id) DO NOTHING`,
        [
          profileId,
          meter.handle ?? null,
          JSON.stringify(meter.days ?? []),
          JSON.stringify(meter.stats ?? {}),
          Number(meter.week_tokens) || 0,
          meter.generated_at_ms == null ? null : Number(meter.generated_at_ms),
          Number(meter.updated_at_ms),
          createdAtMs,
        ],
      );
      const owner = await client.query(
        "SELECT owner_meter_id FROM registry_profiles WHERE profile_id = $1",
        [profileId],
      );
      if (owner.rows[0]?.owner_meter_id !== meter.meter_id) {
        throw new Error(`profile collision while reconciling ${meter.meter_id}`);
      }
      await client.query(
        `INSERT INTO registry_profile_devices
           (profile_id, meter_id, role, sharing_enabled, joined_at_ms, last_reported_at_ms)
         VALUES ($1, $1, 'owner', $2, $3, $4)
         ON CONFLICT (meter_id) DO NOTHING`,
        [
          profileId,
          meter.generated_at_ms != null,
          createdAtMs,
          meter.generated_at_ms == null ? null : Number(meter.updated_at_ms),
        ],
      );
      if (meter.handle) {
        await client.query(
          "UPDATE registry_handles SET profile_id = $2 WHERE handle = $1",
          [meter.handle, profileId],
        );
      }
      reconciledProfiles.push(profileId);
    }
    await client.query("COMMIT");
    return { reconciledProfiles };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

async function count(pool, sql) {
  const result = await pool.query(sql);
  return Number(result.rows[0].count);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

async function countRollupMismatches(pool) {
  const profiles = await pool.query(
    `SELECT profile_id, days, stats, week_tokens, generated_at_ms
     FROM registry_profiles`,
  );
  const devices = await pool.query(
    `SELECT d.profile_id, m.days, m.stats, m.week_tokens,
            m.generated_at_ms, m.updated_at_ms
     FROM registry_profile_devices AS d
     JOIN registry_meters AS m ON m.meter_id = d.meter_id
     WHERE d.revoked_at_ms IS NULL
       AND d.sharing_enabled = TRUE
       AND m.generated_at_ms IS NOT NULL`,
  );
  const snapshotsByProfile = new Map();
  for (const meter of devices.rows) {
    const snapshots = snapshotsByProfile.get(meter.profile_id) ?? [];
    snapshots.push({
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: Number(meter.week_tokens) || 0,
      generatedAtMs: meter.generated_at_ms == null ? null : Number(meter.generated_at_ms),
      updatedAtMs: meter.updated_at_ms == null ? 0 : Number(meter.updated_at_ms),
    });
    snapshotsByProfile.set(meter.profile_id, snapshots);
  }
  let mismatches = 0;
  for (const profile of profiles.rows) {
    const expected = aggregateProfileSnapshots(
      snapshotsByProfile.get(profile.profile_id) ?? [],
    );
    const actualComparable = canonical({
      days: profile.days ?? [],
      stats: profile.stats ?? {},
      weekTokens: Number(profile.week_tokens) || 0,
      generatedAtMs:
        profile.generated_at_ms == null ? null : Number(profile.generated_at_ms),
    });
    const expectedComparable = canonical({
      days: expected.days,
      stats: expected.stats,
      weekTokens: expected.weekTokens,
      generatedAtMs: expected.generatedAtMs,
    });
    if (JSON.stringify(actualComparable) !== JSON.stringify(expectedComparable)) {
      mismatches += 1;
    }
  }
  return mismatches;
}

export async function verifyRegistryProfileMigration(pool) {
  const checks = {
    meters: await count(pool, "SELECT COUNT(*)::bigint AS count FROM registry_meters"),
    profiles: await count(pool, "SELECT COUNT(*)::bigint AS count FROM registry_profiles"),
    devices: await count(pool, "SELECT COUNT(*)::bigint AS count FROM registry_profile_devices"),
    handles: await count(pool, "SELECT COUNT(*)::bigint AS count FROM registry_handles"),
    metersWithoutDevice: await count(
      pool,
      `SELECT COUNT(*)::bigint AS count
       FROM registry_meters AS m
       LEFT JOIN registry_profile_devices AS d ON d.meter_id = m.meter_id
       WHERE d.meter_id IS NULL`,
    ),
    devicesWithoutProfile: await count(
      pool,
      `SELECT COUNT(*)::bigint AS count
       FROM registry_profile_devices AS d
       LEFT JOIN registry_profiles AS p ON p.profile_id = d.profile_id
       WHERE p.profile_id IS NULL`,
    ),
    profilesWithoutOwnerMembership: await count(
      pool,
      `SELECT COUNT(*)::bigint AS count
       FROM registry_profiles AS p
       LEFT JOIN registry_profile_devices AS d
         ON d.profile_id = p.profile_id
        AND d.meter_id = p.owner_meter_id
        AND d.role = 'owner'
       WHERE d.meter_id IS NULL`,
    ),
    handlesWithoutProfile: await count(
      pool,
      `SELECT COUNT(*)::bigint AS count
       FROM registry_handles
       WHERE profile_id IS NULL`,
    ),
    handleProfileMismatches: await count(
      pool,
      `SELECT COUNT(*)::bigint AS count
       FROM registry_handles AS h
       JOIN registry_profiles AS p ON p.profile_id = h.profile_id
       WHERE COALESCE(p.handle, '') <> h.handle
          OR p.owner_meter_id <> h.meter_id`,
    ),
    rollupMismatches: await countRollupMismatches(pool),
  };
  const errorKeys = [
    "metersWithoutDevice",
    "devicesWithoutProfile",
    "profilesWithoutOwnerMembership",
    "handlesWithoutProfile",
    "handleProfileMismatches",
    "rollupMismatches",
  ];
  return {
    ok: errorKeys.every((key) => checks[key] === 0),
    checks,
  };
}
