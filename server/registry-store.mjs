import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

const { Pool } = pg;

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registry_meters (
  meter_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  handle TEXT UNIQUE,
  days JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  week_tokens BIGINT NOT NULL DEFAULT 0,
  generated_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS registry_handles (
  handle VARCHAR(30) PRIMARY KEY,
  meter_id TEXT NOT NULL UNIQUE REFERENCES registry_meters(meter_id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  claimed_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS registry_meters_week_tokens_idx
  ON registry_meters (week_tokens DESC, updated_at_ms DESC);
`;

function displayName(meterId, handle) {
  return handle ? `@${handle}` : `${meterId.slice(0, 10)}…`;
}

function asNumber(value) {
  return value == null ? null : Number(value);
}

export class FileRegistryStore {
  constructor({ dataFile }) {
    if (!dataFile) throw new TypeError("dataFile is required");
    this.dataFile = dataFile;
    try {
      this.data = JSON.parse(readFileSync(dataFile, "utf8"));
    } catch {
      this.data = { handles: {}, meters: {} };
    }
  }

  async init() {}

  #save() {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const temporaryFile = `${this.dataFile}.writing`;
    writeFileSync(temporaryFile, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporaryFile, this.dataFile);
  }

  async health() {
    return { meters: Object.keys(this.data.meters).length };
  }

  async handleAvailable(handle) {
    return this.data.handles[handle] == null;
  }

  async claim({ handle, meterId, publicKey, nowMs }) {
    const existingHandle = this.data.handles[handle];
    if (existingHandle && existingHandle.meterId !== meterId) {
      return { claimed: false, reason: "handle-taken" };
    }
    const existingMeter = this.data.meters[meterId];
    if (existingMeter?.publicKey && existingMeter.publicKey !== publicKey) {
      return { claimed: false, reason: "identity-collision" };
    }
    const meterHandle = Object.entries(this.data.handles).find(
      ([, value]) => value.meterId === meterId,
    )?.[0];
    if (meterHandle && meterHandle !== handle) {
      return { claimed: false, reason: "meter-already-claimed" };
    }
    this.data.handles[handle] = existingHandle ?? {
      meterId,
      publicKey,
      claimedAtMs: nowMs,
    };
    const meter = (this.data.meters[meterId] ??= {});
    meter.handle = handle;
    meter.publicKey = publicKey;
    meter.updatedAtMs = nowMs;
    this.#save();
    return { claimed: true };
  }

  async report({
    meterId,
    publicKey,
    handle,
    days,
    stats,
    weekTokens,
    generatedAtMs,
    nowMs,
  }) {
    const meter = (this.data.meters[meterId] ??= {});
    if (meter.publicKey && meter.publicKey !== publicKey) {
      return { accepted: false, reason: "identity-collision" };
    }
    if (
      Number.isSafeInteger(meter.generatedAtMs) &&
      generatedAtMs < meter.generatedAtMs
    ) {
      return { accepted: true, ignored: true };
    }
    meter.publicKey = publicKey;
    meter.days = days;
    meter.stats = stats;
    meter.weekTokens = weekTokens;
    meter.generatedAtMs = generatedAtMs;
    if (handle && this.data.handles[handle]?.meterId === meterId) {
      meter.handle = handle;
    }
    meter.updatedAtMs = nowMs;
    this.#save();
    return { accepted: true, ignored: false };
  }

  async leaderboard(limit = 100) {
    return Object.entries(this.data.meters)
      .map(([meterId, meter]) => ({
        name: displayName(meterId, meter.handle),
        handle: meter.handle ?? null,
        tokens: meter.weekTokens ?? 0,
        lifetimeTokens: meter.stats?.lifetimeTokens ?? 0,
        sessions: meter.stats?.sessionCount ?? 0,
        updatedAtMs: meter.updatedAtMs,
      }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, limit);
  }

  async profile(handle) {
    const meterId = this.data.handles[handle]?.meterId;
    const meter = meterId ? this.data.meters[meterId] : null;
    if (!meter) return null;
    return {
      handle,
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: meter.weekTokens ?? 0,
      updatedAtMs: meter.updatedAtMs,
    };
  }

  async close() {}
}

export class PostgresRegistryStore {
  constructor({ databaseUrl, pool = null }) {
    if (!databaseUrl && !pool) {
      throw new TypeError("databaseUrl or pool is required");
    }
    this.pool = pool ?? new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.ownsPool = pool == null;
  }

  async init() {
    await this.pool.query(POSTGRES_SCHEMA_SQL);
  }

  async health() {
    const result = await this.pool.query(
      "SELECT COUNT(*)::bigint AS meters FROM registry_meters",
    );
    return { meters: Number(result.rows[0].meters) };
  }

  async handleAvailable(handle) {
    const result = await this.pool.query(
      "SELECT 1 FROM registry_handles WHERE handle = $1",
      [handle],
    );
    return result.rowCount === 0;
  }

  async claim({ handle, meterId, publicKey, nowMs }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO registry_meters (meter_id, public_key, updated_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (meter_id) DO NOTHING`,
        [meterId, publicKey, nowMs],
      );
      const meter = await client.query(
        "SELECT public_key FROM registry_meters WHERE meter_id = $1 FOR UPDATE",
        [meterId],
      );
      if (meter.rows[0]?.public_key !== publicKey) {
        await client.query("ROLLBACK");
        return { claimed: false, reason: "identity-collision" };
      }
      await client.query(
        `INSERT INTO registry_handles (handle, meter_id, public_key, claimed_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [handle, meterId, publicKey, nowMs],
      );
      const owner = await client.query(
        "SELECT meter_id FROM registry_handles WHERE handle = $1",
        [handle],
      );
      if (owner.rows[0]?.meter_id !== meterId) {
        await client.query("ROLLBACK");
        return { claimed: false, reason: "handle-taken" };
      }
      const existingHandle = await client.query(
        "SELECT handle FROM registry_handles WHERE meter_id = $1",
        [meterId],
      );
      if (existingHandle.rows[0]?.handle !== handle) {
        await client.query("ROLLBACK");
        return { claimed: false, reason: "meter-already-claimed" };
      }
      await client.query(
        `UPDATE registry_meters
         SET handle = $2, updated_at_ms = $3
         WHERE meter_id = $1`,
        [meterId, handle, nowMs],
      );
      await client.query("COMMIT");
      return { claimed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async report({
    meterId,
    publicKey,
    handle,
    days,
    stats,
    weekTokens,
    generatedAtMs,
    nowMs,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO registry_meters (meter_id, public_key, updated_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (meter_id) DO NOTHING`,
        [meterId, publicKey, nowMs],
      );
      const current = await client.query(
        `SELECT public_key, generated_at_ms
         FROM registry_meters
         WHERE meter_id = $1
         FOR UPDATE`,
        [meterId],
      );
      const meter = current.rows[0];
      if (meter?.public_key !== publicKey) {
        await client.query("ROLLBACK");
        return { accepted: false, reason: "identity-collision" };
      }
      if (
        meter.generated_at_ms != null &&
        generatedAtMs < Number(meter.generated_at_ms)
      ) {
        await client.query("COMMIT");
        return { accepted: true, ignored: true };
      }
      let claimedHandle = null;
      if (handle) {
        const claim = await client.query(
          `SELECT handle FROM registry_handles
           WHERE handle = $1 AND meter_id = $2`,
          [handle, meterId],
        );
        claimedHandle = claim.rows[0]?.handle ?? null;
      }
      await client.query(
        `UPDATE registry_meters
         SET public_key = $2,
             handle = COALESCE($3, handle),
             days = $4::jsonb,
             stats = $5::jsonb,
             week_tokens = $6,
             generated_at_ms = $7,
             updated_at_ms = $8
         WHERE meter_id = $1`,
        [
          meterId,
          publicKey,
          claimedHandle,
          JSON.stringify(days),
          JSON.stringify(stats),
          weekTokens,
          generatedAtMs,
          nowMs,
        ],
      );
      await client.query("COMMIT");
      return { accepted: true, ignored: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async leaderboard(limit = 100) {
    const result = await this.pool.query(
      `SELECT meter_id, handle, week_tokens, stats, updated_at_ms
       FROM registry_meters
       ORDER BY week_tokens DESC, updated_at_ms DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((meter) => ({
      name: displayName(meter.meter_id, meter.handle),
      handle: meter.handle ?? null,
      tokens: asNumber(meter.week_tokens) ?? 0,
      lifetimeTokens: meter.stats?.lifetimeTokens ?? 0,
      sessions: meter.stats?.sessionCount ?? 0,
      updatedAtMs: asNumber(meter.updated_at_ms),
    }));
  }

  async profile(handle) {
    const result = await this.pool.query(
      `SELECT m.days, m.stats, m.week_tokens, m.updated_at_ms
       FROM registry_handles AS h
       JOIN registry_meters AS m ON m.meter_id = h.meter_id
       WHERE h.handle = $1`,
      [handle],
    );
    const meter = result.rows[0];
    if (!meter) return null;
    return {
      handle,
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: asNumber(meter.week_tokens) ?? 0,
      updatedAtMs: asNumber(meter.updated_at_ms),
    };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export function createRegistryStore({ databaseUrl, dataFile }) {
  return databaseUrl
    ? new PostgresRegistryStore({ databaseUrl })
    : new FileRegistryStore({ dataFile });
}
