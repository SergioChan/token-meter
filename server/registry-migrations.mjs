import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

async function count(pool, sql) {
  const result = await pool.query(sql);
  return Number(result.rows[0].count);
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
  };
  const errorKeys = [
    "metersWithoutDevice",
    "devicesWithoutProfile",
    "profilesWithoutOwnerMembership",
    "handlesWithoutProfile",
    "handleProfileMismatches",
  ];
  return {
    ok: errorKeys.every((key) => checks[key] === 0),
    checks,
  };
}
