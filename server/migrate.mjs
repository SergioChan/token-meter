#!/usr/bin/env node
import pg from "pg";
import {
  applyRegistryMigrations,
  migrationStatus,
  reconcileRegistryProfiles,
  verifyRegistryProfileMigration,
} from "./registry-migrations.mjs";

const { Pool } = pg;
const command = process.argv[2] ?? "status";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required; no database changes were attempted.\n");
  process.exit(2);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
});

try {
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await migrationStatus(pool), null, 2)}\n`);
  } else if (command === "up") {
    const result = await applyRegistryMigrations(pool);
    const reconciliation = await reconcileRegistryProfiles(pool);
    const verification = await verifyRegistryProfileMigration(pool);
    process.stdout.write(`${JSON.stringify({ ...result, reconciliation, verification }, null, 2)}\n`);
    if (!verification.ok) process.exitCode = 1;
  } else if (command === "reconcile") {
    const reconciliation = await reconcileRegistryProfiles(pool);
    const verification = await verifyRegistryProfileMigration(pool);
    process.stdout.write(`${JSON.stringify({ reconciliation, verification }, null, 2)}\n`);
    if (!verification.ok) process.exitCode = 1;
  } else if (command === "verify") {
    const verification = await verifyRegistryProfileMigration(pool);
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    if (!verification.ok) process.exitCode = 1;
  } else {
    process.stderr.write("Usage: node server/migrate.mjs [status|up|reconcile|verify]\n");
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
