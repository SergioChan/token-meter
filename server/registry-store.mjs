import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import pg from "pg";
import { aggregateProfileSnapshots } from "./profile-rollup.mjs";

const { Pool } = pg;
const FILE_PROFILE_SCHEMA_VERSION = 1;

export const POSTGRES_SCHEMA_SQL = readFileSync(
  new URL("./migrations/001_legacy_registry.sql", import.meta.url),
  "utf8",
);

function displayName(meterId, handle) {
  return handle ? `@${handle}` : `${meterId.slice(0, 10)}…`;
}

function asNumber(value) {
  return value == null ? null : Number(value);
}

export function registryRowId(meterId) {
  return createHash("sha256").update(meterId).digest("base64url").slice(0, 16);
}

function compareMeters([leftId, left], [rightId, right]) {
  const tokenDelta = (right.weekTokens ?? 0) - (left.weekTokens ?? 0);
  if (tokenDelta !== 0) return tokenDelta;
  const updateDelta = (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0);
  if (updateDelta !== 0) return updateDelta;
  return leftId.localeCompare(rightId);
}

function publicMeterRow(meterId, meter) {
  return {
    rowId: registryRowId(meterId),
    name: displayName(meterId, meter.handle),
    handle: meter.handle ?? null,
    tokens: meter.weekTokens ?? 0,
    lifetimeTokens: meter.stats?.lifetimeTokens ?? 0,
    sessions: meter.stats?.sessionsLast7Days ?? null,
    sessionWindowDays: 7,
    updatedAtMs: meter.updatedAtMs,
  };
}

function publicProfileRow(profileId, profile) {
  return {
    rowId: registryRowId(profileId),
    name: displayName(profileId, profile.handle),
    handle: profile.handle ?? null,
    tokens: profile.weekTokens ?? 0,
    lifetimeTokens: profile.stats?.lifetimeTokens ?? 0,
    sessions: profile.stats?.sessionsLast7Days ?? null,
    sessionWindowDays: 7,
    updatedAtMs: profile.updatedAtMs,
  };
}

export class FileRegistryStore {
  constructor({ dataFile, profileReads = false }) {
    if (!dataFile) throw new TypeError("dataFile is required");
    this.dataFile = dataFile;
    this.profileReads = profileReads;
    try {
      const loaded = JSON.parse(readFileSync(dataFile, "utf8"));
      this.data = {
        schemaVersion: loaded.schemaVersion ?? 0,
        handles: loaded.handles ?? {},
        meters: loaded.meters ?? {},
        browserPairings: loaded.browserPairings ?? {},
        browserSessions: loaded.browserSessions ?? {},
        profiles: loaded.profiles ?? {},
        profileDevices: loaded.profileDevices ?? {},
        deviceInvites: loaded.deviceInvites ?? {},
      };
    } catch {
      this.data = {
        schemaVersion: FILE_PROFILE_SCHEMA_VERSION,
        handles: {},
        meters: {},
        browserPairings: {},
        browserSessions: {},
        profiles: {},
        profileDevices: {},
        deviceInvites: {},
      };
    }
  }

  async init() {
    if (this.#migrateProfileData()) this.#save();
  }

  #migrateProfileData() {
    if (this.data.schemaVersion >= FILE_PROFILE_SCHEMA_VERSION) return false;
    for (const [meterId, meter] of Object.entries(this.data.meters)) {
      const handleEntry = Object.entries(this.data.handles).find(
        ([, value]) => value.meterId === meterId,
      );
      const handle = handleEntry?.[0] ?? null;
      const claimedAtMs = handleEntry?.[1]?.claimedAtMs;
      this.data.profiles[meterId] ??= {
        ownerMeterId: meterId,
        handle,
        days: meter.days ?? [],
        stats: meter.stats ?? {},
        weekTokens: meter.weekTokens ?? 0,
        generatedAtMs: meter.generatedAtMs ?? null,
        updatedAtMs: meter.updatedAtMs ?? claimedAtMs ?? 0,
        createdAtMs: claimedAtMs ?? meter.updatedAtMs ?? 0,
        rollupVersion: 1,
        timeZone: null,
      };
      this.data.profileDevices[meterId] ??= {
        profileId: meterId,
        role: "owner",
        sharingEnabled: meter.generatedAtMs != null,
        joinedAtMs: claimedAtMs ?? meter.updatedAtMs ?? 0,
        lastReportedAtMs: meter.generatedAtMs == null ? null : meter.updatedAtMs,
        revokedAtMs: null,
        replacedByMeterId: null,
        deviceLabel: null,
      };
      if (handleEntry) handleEntry[1].profileId = meterId;
    }
    this.data.schemaVersion = FILE_PROFILE_SCHEMA_VERSION;
    return true;
  }

  #ensureProfileForMeter(meterId, nowMs) {
    const existingDevice = this.data.profileDevices[meterId];
    if (existingDevice) return existingDevice.profileId;
    const meter = this.data.meters[meterId];
    if (!meter) throw new Error(`cannot create profile for unknown meter ${meterId}`);
    const handleEntry = Object.entries(this.data.handles).find(
      ([, value]) => value.meterId === meterId,
    );
    const handle = handleEntry?.[0] ?? null;
    const profileId = handleEntry?.[1]?.profileId ?? meterId;
    const joinedAtMs = handleEntry?.[1]?.claimedAtMs ?? meter.updatedAtMs ?? nowMs;
    this.data.profiles[profileId] ??= {
      ownerMeterId: meterId,
      handle,
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: meter.weekTokens ?? 0,
      generatedAtMs: meter.generatedAtMs ?? null,
      updatedAtMs: meter.updatedAtMs ?? nowMs,
      createdAtMs: joinedAtMs,
      rollupVersion: 1,
      timeZone: null,
    };
    this.data.profileDevices[meterId] = {
      profileId,
      role: "owner",
      sharingEnabled: meter.generatedAtMs != null,
      joinedAtMs,
      lastReportedAtMs: meter.generatedAtMs == null ? null : meter.updatedAtMs,
      revokedAtMs: null,
      replacedByMeterId: null,
      deviceLabel: null,
    };
    if (handleEntry) handleEntry[1].profileId = profileId;
    return profileId;
  }

  #recomputeProfile(profileId, nowMs) {
    const profile = this.data.profiles[profileId];
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    const snapshots = Object.entries(this.data.profileDevices)
      .filter(([, device]) =>
        device.profileId === profileId &&
        device.revokedAtMs == null &&
        device.sharingEnabled)
      .map(([meterId]) => this.data.meters[meterId])
      .filter(Boolean);
    const rollup = aggregateProfileSnapshots(snapshots);
    profile.days = rollup.days;
    profile.stats = rollup.stats;
    profile.weekTokens = rollup.weekTokens;
    profile.generatedAtMs = rollup.generatedAtMs;
    profile.updatedAtMs = Math.max(rollup.updatedAtMs ?? 0, nowMs);
    profile.rollupVersion = 1;
  }

  #sortedProfiles() {
    return Object.entries(this.data.profiles)
      .filter(([, profile]) => profile.generatedAtMs != null)
      .sort(compareMeters);
  }

  #save() {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const temporaryFile = `${this.dataFile}.writing`;
    writeFileSync(temporaryFile, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporaryFile, this.dataFile);
  }

  #pruneBrowserAuth(nowMs) {
    let changed = false;
    for (const [codeHash, pairing] of Object.entries(this.data.browserPairings)) {
      if (pairing.expiresAtMs <= nowMs || pairing.consumedAtMs != null) {
        delete this.data.browserPairings[codeHash];
        changed = true;
      }
    }
    for (const [tokenHash, session] of Object.entries(this.data.browserSessions)) {
      if (session.expiresAtMs <= nowMs) {
        delete this.data.browserSessions[tokenHash];
        changed = true;
      }
    }
    return changed;
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
    const profileId = this.#ensureProfileForMeter(meterId, nowMs);
    this.data.handles[handle].profileId = profileId;
    this.data.profiles[profileId].handle = handle;
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
    meter.stats = {
      ...stats,
      sessionsLast7Days:
        stats.sessionsLast7Days ?? meter.stats?.sessionsLast7Days ?? null,
    };
    meter.weekTokens = weekTokens;
    meter.generatedAtMs = generatedAtMs;
    if (handle && this.data.handles[handle]?.meterId === meterId) {
      meter.handle = handle;
    }
    const profileId = this.#ensureProfileForMeter(meterId, nowMs);
    const device = this.data.profileDevices[meterId];
    device.sharingEnabled = true;
    device.lastReportedAtMs = nowMs;
    this.#recomputeProfile(profileId, nowMs);
    meter.updatedAtMs = nowMs;
    this.#save();
    return { accepted: true, ignored: false };
  }

  async createBrowserPairing({ codeHash, meterId, publicKey, nowMs, expiresAtMs }) {
    this.#pruneBrowserAuth(nowMs);
    const meter = this.data.meters[meterId];
    if (meter?.publicKey && meter.publicKey !== publicKey) {
      return { created: false, reason: "identity-collision" };
    }
    if (this.data.browserPairings[codeHash]) {
      return { created: false, reason: "code-collision" };
    }
    this.data.browserPairings[codeHash] = {
      meterId,
      publicKey,
      createdAtMs: nowMs,
      expiresAtMs,
      consumedAtMs: null,
    };
    this.#save();
    return { created: true };
  }

  async exchangeBrowserPairing({
    codeHash,
    sessionTokenHash,
    nowMs,
    sessionExpiresAtMs,
  }) {
    const pairing = this.data.browserPairings[codeHash];
    if (!pairing || pairing.consumedAtMs != null || pairing.expiresAtMs <= nowMs) {
      if (pairing) {
        delete this.data.browserPairings[codeHash];
        this.#save();
      }
      return { exchanged: false, reason: "invalid-or-expired" };
    }
    pairing.consumedAtMs = nowMs;
    this.data.browserSessions[sessionTokenHash] = {
      meterId: pairing.meterId,
      publicKey: pairing.publicKey,
      createdAtMs: nowMs,
      expiresAtMs: sessionExpiresAtMs,
    };
    this.#save();
    return {
      exchanged: true,
      meterId: pairing.meterId,
      expiresAtMs: sessionExpiresAtMs,
    };
  }

  async viewerForBrowserSession({ sessionTokenHash, nowMs }) {
    const pruned = this.#pruneBrowserAuth(nowMs);
    const session = this.data.browserSessions[sessionTokenHash];
    if (pruned) this.#save();
    if (!session) return null;
    const meter = this.data.meters[session.meterId] ?? null;
    if (meter?.publicKey && meter.publicKey !== session.publicKey) return null;
    if (this.profileReads) {
      const device = this.data.profileDevices[session.meterId];
      const profile = device ? this.data.profiles[device.profileId] : null;
      const sorted = this.#sortedProfiles();
      const index = sorted.findIndex(([profileId]) => profileId === device?.profileId);
      return {
        meterId: session.meterId,
        profileId: device?.profileId ?? null,
        rowId: registryRowId(device?.profileId ?? session.meterId),
        name: displayName(device?.profileId ?? session.meterId, profile?.handle),
        handle: profile?.handle ?? null,
        rank: index >= 0 ? index + 1 : null,
        totalMeters: sorted.length,
        tokens: profile?.weekTokens ?? 0,
        sessions: profile?.stats?.sessionsLast7Days ?? null,
        sessionWindowDays: 7,
        sharingReported: profile?.generatedAtMs != null,
        expiresAtMs: session.expiresAtMs,
      };
    }
    // Rank and totals only count meters with shared data — a withdrawn
    // meter keeps its handle but disappears from the board.
    const sorted = Object.entries(this.data.meters)
      .filter(([, value]) => value.generatedAtMs != null)
      .sort(compareMeters);
    const index = sorted.findIndex(([meterId]) => meterId === session.meterId);
    return {
      meterId: session.meterId,
      rowId: registryRowId(session.meterId),
      name: displayName(session.meterId, meter?.handle),
      handle: meter?.handle ?? null,
      rank: index >= 0 ? index + 1 : null,
      totalMeters: sorted.length,
      tokens: meter?.weekTokens ?? 0,
      sessions: meter?.stats?.sessionsLast7Days ?? null,
      sessionWindowDays: 7,
      sharingReported: meter?.generatedAtMs != null,
      expiresAtMs: session.expiresAtMs,
    };
  }

  async revokeBrowserSession(sessionTokenHash) {
    if (!this.data.browserSessions[sessionTokenHash]) return false;
    delete this.data.browserSessions[sessionTokenHash];
    this.#save();
    return true;
  }

  async withdraw({ meterId, publicKey, nowMs }) {
    const meter = this.data.meters[meterId];
    if (!meter || meter.generatedAtMs == null) return { wiped: false };
    if (meter.publicKey && meter.publicKey !== publicKey) {
      return { wiped: false, reason: "identity-collision" };
    }
    // The handle claim survives a withdrawal: identity is the user's to keep,
    // only the shared usage aggregates are deleted.
    delete meter.days;
    delete meter.stats;
    delete meter.weekTokens;
    delete meter.generatedAtMs;
    meter.updatedAtMs = nowMs;
    const device = this.data.profileDevices[meterId];
    if (device) {
      device.sharingEnabled = false;
      device.lastReportedAtMs = nowMs;
      this.#recomputeProfile(device.profileId, nowMs);
    }
    this.#save();
    return { wiped: true };
  }

  async leaderboard(limit = 100) {
    if (this.profileReads) {
      return this.#sortedProfiles()
        .map(([profileId, profile]) => publicProfileRow(profileId, profile))
        .slice(0, limit);
    }
    return Object.entries(this.data.meters)
      .filter(([, meter]) => meter.generatedAtMs != null)
      .sort(compareMeters)
      .map(([meterId, meter]) => publicMeterRow(meterId, meter))
      .slice(0, limit);
  }

  async profile(handle) {
    if (this.profileReads) {
      const profileId = this.data.handles[handle]?.profileId;
      const profile = profileId ? this.data.profiles[profileId] : null;
      if (!profile) return null;
      if (profile.generatedAtMs == null) return { handle, shared: false };
      return {
        handle,
        shared: true,
        days: profile.days ?? [],
        stats: profile.stats ?? {},
        weekTokens: profile.weekTokens ?? 0,
        updatedAtMs: profile.updatedAtMs,
      };
    }
    const meterId = this.data.handles[handle]?.meterId;
    const meter = meterId ? this.data.meters[meterId] : null;
    if (!meter) return null;
    if (meter.generatedAtMs == null) return { handle, shared: false };
    return {
      handle,
      shared: true,
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: meter.weekTokens ?? 0,
      updatedAtMs: meter.updatedAtMs,
    };
  }

  async close() {}
}

export class PostgresRegistryStore {
  constructor({ databaseUrl, pool = null, profileReads = false }) {
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
    this.profileReadsRequested = profileReads;
    this.profileSchemaAvailable = false;
  }

  async init() {
    if (!await this.#tableExists("registry_meters")) {
      await this.pool.query(POSTGRES_SCHEMA_SQL);
    }
    const profileTables = await Promise.all([
      this.#tableExists("registry_profiles"),
      this.#tableExists("registry_profile_devices"),
      this.#tableExists("registry_device_invites"),
    ]);
    this.profileSchemaAvailable = profileTables.every(Boolean);
    if (this.profileReadsRequested && !this.profileSchemaAvailable) {
      throw new Error(
        "profile reads were requested before registry profile migrations were applied",
      );
    }
  }

  async #tableExists(tableName) {
    const result = await this.pool.query(
      `SELECT COUNT(*)::bigint AS count
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [tableName],
    );
    return Number(result.rows[0].count) === 1;
  }

  async #ensureProfileForMeter(client, { meterId, nowMs }) {
    const existing = await client.query(
      "SELECT profile_id FROM registry_profile_devices WHERE meter_id = $1",
      [meterId],
    );
    if (existing.rowCount > 0) return existing.rows[0].profile_id;
    const meterResult = await client.query(
      `SELECT days, stats, week_tokens, generated_at_ms, updated_at_ms
       FROM registry_meters
       WHERE meter_id = $1`,
      [meterId],
    );
    const meter = meterResult.rows[0];
    if (!meter) throw new Error(`cannot create profile for unknown meter ${meterId}`);
    const handleResult = await client.query(
      `SELECT handle, profile_id, claimed_at_ms
       FROM registry_handles
       WHERE meter_id = $1`,
      [meterId],
    );
    const handle = handleResult.rows[0] ?? null;
    const profileId = handle?.profile_id ?? meterId;
    const joinedAtMs = asNumber(handle?.claimed_at_ms) ?? asNumber(meter.updated_at_ms) ?? nowMs;
    await client.query(
      `INSERT INTO registry_profiles
         (profile_id, owner_meter_id, handle, days, stats, week_tokens,
          generated_at_ms, updated_at_ms, created_at_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (profile_id) DO NOTHING`,
      [
        profileId,
        meterId,
        handle?.handle ?? null,
        JSON.stringify(meter.days ?? []),
        JSON.stringify(meter.stats ?? {}),
        asNumber(meter.week_tokens) ?? 0,
        asNumber(meter.generated_at_ms),
        asNumber(meter.updated_at_ms) ?? nowMs,
        joinedAtMs,
      ],
    );
    await client.query(
      `INSERT INTO registry_profile_devices
         (profile_id, meter_id, role, sharing_enabled, joined_at_ms, last_reported_at_ms)
       VALUES ($1, $2, 'owner', $3, $4, $5)
       ON CONFLICT (meter_id) DO NOTHING`,
      [
        profileId,
        meterId,
        meter.generated_at_ms != null,
        joinedAtMs,
        meter.generated_at_ms == null ? null : asNumber(meter.updated_at_ms),
      ],
    );
    if (handle) {
      await client.query(
        "UPDATE registry_handles SET profile_id = $2 WHERE handle = $1",
        [handle.handle, profileId],
      );
      await client.query(
        "UPDATE registry_profiles SET handle = $2 WHERE profile_id = $1",
        [profileId, handle.handle],
      );
    }
    const membership = await client.query(
      "SELECT profile_id FROM registry_profile_devices WHERE meter_id = $1",
      [meterId],
    );
    return membership.rows[0].profile_id;
  }

  async #recomputeProfile(client, profileId, nowMs) {
    const profile = await client.query(
      "SELECT profile_id FROM registry_profiles WHERE profile_id = $1 FOR UPDATE",
      [profileId],
    );
    if (profile.rowCount !== 1) throw new Error(`unknown profile ${profileId}`);
    const result = await client.query(
      `SELECT m.days, m.stats, m.week_tokens, m.generated_at_ms, m.updated_at_ms
       FROM registry_profile_devices AS d
       JOIN registry_meters AS m ON m.meter_id = d.meter_id
       WHERE d.profile_id = $1
         AND d.revoked_at_ms IS NULL
         AND d.sharing_enabled = TRUE
         AND m.generated_at_ms IS NOT NULL`,
      [profileId],
    );
    const snapshots = result.rows.map((meter) => ({
      days: meter.days ?? [],
      stats: meter.stats ?? {},
      weekTokens: asNumber(meter.week_tokens) ?? 0,
      generatedAtMs: asNumber(meter.generated_at_ms),
      updatedAtMs: asNumber(meter.updated_at_ms) ?? 0,
    }));
    const rollup = aggregateProfileSnapshots(snapshots);
    await client.query(
      `UPDATE registry_profiles
       SET days = $2::jsonb,
           stats = $3::jsonb,
           week_tokens = $4,
           generated_at_ms = $5,
           updated_at_ms = $6,
           rollup_version = 1
       WHERE profile_id = $1`,
      [
        profileId,
        JSON.stringify(rollup.days),
        JSON.stringify(rollup.stats),
        rollup.weekTokens,
        rollup.generatedAtMs,
        Math.max(rollup.updatedAtMs ?? 0, nowMs),
      ],
    );
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
      if (this.profileSchemaAvailable) {
        const profileId = await this.#ensureProfileForMeter(client, { meterId, nowMs });
        await client.query(
          "UPDATE registry_handles SET profile_id = $2 WHERE handle = $1",
          [handle, profileId],
        );
        await client.query(
          "UPDATE registry_profiles SET handle = $2 WHERE profile_id = $1",
          [profileId, handle],
        );
      }
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
        `SELECT public_key, generated_at_ms, stats
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
      const normalizedStats = {
        ...stats,
        sessionsLast7Days:
          stats.sessionsLast7Days ?? meter.stats?.sessionsLast7Days ?? null,
      };
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
          JSON.stringify(normalizedStats),
          weekTokens,
          generatedAtMs,
          nowMs,
        ],
      );
      if (this.profileSchemaAvailable) {
        const profileId = await this.#ensureProfileForMeter(client, { meterId, nowMs });
        await client.query(
          `UPDATE registry_profile_devices
           SET sharing_enabled = TRUE, last_reported_at_ms = $2
           WHERE meter_id = $1 AND revoked_at_ms IS NULL`,
          [meterId, nowMs],
        );
        await this.#recomputeProfile(client, profileId, nowMs);
      }
      await client.query("COMMIT");
      return { accepted: true, ignored: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createBrowserPairing({ codeHash, meterId, publicKey, nowMs, expiresAtMs }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const meter = await client.query(
        "SELECT public_key FROM registry_meters WHERE meter_id = $1",
        [meterId],
      );
      if (meter.rows[0]?.public_key && meter.rows[0].public_key !== publicKey) {
        await client.query("ROLLBACK");
        return { created: false, reason: "identity-collision" };
      }
      await client.query(
        "DELETE FROM registry_browser_pairings WHERE expires_at_ms <= $1 OR consumed_at_ms IS NOT NULL",
        [nowMs],
      );
      await client.query(
        "DELETE FROM registry_browser_sessions WHERE expires_at_ms <= $1",
        [nowMs],
      );
      const created = await client.query(
        `INSERT INTO registry_browser_pairings
           (code_hash, meter_id, public_key, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code_hash) DO NOTHING`,
        [codeHash, meterId, publicKey, nowMs, expiresAtMs],
      );
      if (created.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { created: false, reason: "code-collision" };
      }
      await client.query("COMMIT");
      return { created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async exchangeBrowserPairing({
    codeHash,
    sessionTokenHash,
    nowMs,
    sessionExpiresAtMs,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pairingResult = await client.query(
        `SELECT meter_id, public_key, expires_at_ms, consumed_at_ms
         FROM registry_browser_pairings
         WHERE code_hash = $1
         FOR UPDATE`,
        [codeHash],
      );
      const pairing = pairingResult.rows[0];
      if (
        !pairing ||
        pairing.consumed_at_ms != null ||
        Number(pairing.expires_at_ms) <= nowMs
      ) {
        if (pairing) {
          await client.query(
            "DELETE FROM registry_browser_pairings WHERE code_hash = $1",
            [codeHash],
          );
        }
        await client.query("COMMIT");
        return { exchanged: false, reason: "invalid-or-expired" };
      }
      await client.query(
        "UPDATE registry_browser_pairings SET consumed_at_ms = $2 WHERE code_hash = $1",
        [codeHash, nowMs],
      );
      await client.query(
        `INSERT INTO registry_browser_sessions
           (token_hash, meter_id, public_key, created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sessionTokenHash,
          pairing.meter_id,
          pairing.public_key,
          nowMs,
          sessionExpiresAtMs,
        ],
      );
      await client.query("COMMIT");
      return {
        exchanged: true,
        meterId: pairing.meter_id,
        expiresAtMs: sessionExpiresAtMs,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async viewerForBrowserSession({ sessionTokenHash, nowMs }) {
    const sessionResult = await this.pool.query(
      `SELECT meter_id, public_key, expires_at_ms
       FROM registry_browser_sessions
       WHERE token_hash = $1 AND expires_at_ms > $2`,
      [sessionTokenHash, nowMs],
    );
    const session = sessionResult.rows[0];
    if (!session) {
      await this.pool.query(
        "DELETE FROM registry_browser_sessions WHERE token_hash = $1",
        [sessionTokenHash],
      );
      return null;
    }
    if (this.profileReadsRequested) {
      const profileResult = await this.pool.query(
        `SELECT d.profile_id, p.handle, p.week_tokens, p.stats,
                p.generated_at_ms, p.updated_at_ms
         FROM registry_profile_devices AS d
         JOIN registry_profiles AS p ON p.profile_id = d.profile_id
         JOIN registry_meters AS m ON m.meter_id = d.meter_id
         WHERE d.meter_id = $1
           AND d.revoked_at_ms IS NULL
           AND m.public_key = $2`,
        [session.meter_id, session.public_key],
      );
      const profile = profileResult.rows[0];
      if (!profile) return null;
      const totalResult = await this.pool.query(
        "SELECT COUNT(*)::bigint AS total FROM registry_profiles WHERE generated_at_ms IS NOT NULL",
      );
      let rank = null;
      if (profile.generated_at_ms != null) {
        const rankResult = await this.pool.query(
          `SELECT COUNT(*)::bigint AS ahead
           FROM registry_profiles
           WHERE generated_at_ms IS NOT NULL
             AND (week_tokens > $1
              OR (week_tokens = $1 AND updated_at_ms > $2)
              OR (week_tokens = $1 AND updated_at_ms = $2 AND profile_id < $3))`,
          [profile.week_tokens, profile.updated_at_ms, profile.profile_id],
        );
        rank = Number(rankResult.rows[0].ahead) + 1;
      }
      return {
        meterId: session.meter_id,
        profileId: profile.profile_id,
        rowId: registryRowId(profile.profile_id),
        name: displayName(profile.profile_id, profile.handle),
        handle: profile.handle ?? null,
        rank,
        totalMeters: Number(totalResult.rows[0].total),
        tokens: asNumber(profile.week_tokens) ?? 0,
        sessions: profile.stats?.sessionsLast7Days ?? null,
        sessionWindowDays: 7,
        sharingReported: profile.generated_at_ms != null,
        expiresAtMs: Number(session.expires_at_ms),
      };
    }
    const totalResult = await this.pool.query(
      "SELECT COUNT(*)::bigint AS total FROM registry_meters WHERE generated_at_ms IS NOT NULL",
    );
    const meterResult = await this.pool.query(
      `SELECT meter_id, public_key, handle, week_tokens, stats, generated_at_ms, updated_at_ms
       FROM registry_meters
       WHERE meter_id = $1 AND public_key = $2`,
      [session.meter_id, session.public_key],
    );
    const meter = meterResult.rows[0];
    let rank = null;
    if (meter && meter.generated_at_ms != null) {
      const rankResult = await this.pool.query(
        `SELECT COUNT(*)::bigint AS ahead
         FROM registry_meters
         WHERE generated_at_ms IS NOT NULL
           AND (week_tokens > $1
            OR (week_tokens = $1 AND updated_at_ms > $2)
            OR (week_tokens = $1 AND updated_at_ms = $2 AND meter_id < $3))`,
        [meter.week_tokens, meter.updated_at_ms, meter.meter_id],
      );
      rank = Number(rankResult.rows[0].ahead) + 1;
    }
    return {
      meterId: session.meter_id,
      rowId: registryRowId(session.meter_id),
      name: displayName(session.meter_id, meter?.handle),
      handle: meter?.handle ?? null,
      rank,
      totalMeters: Number(totalResult.rows[0].total),
      tokens: asNumber(meter?.week_tokens) ?? 0,
      sessions: meter?.stats?.sessionsLast7Days ?? null,
      sessionWindowDays: 7,
      sharingReported: meter?.generated_at_ms != null,
      expiresAtMs: Number(session.expires_at_ms),
    };
  }

  async revokeBrowserSession(sessionTokenHash) {
    const result = await this.pool.query(
      "DELETE FROM registry_browser_sessions WHERE token_hash = $1",
      [sessionTokenHash],
    );
    return result.rowCount > 0;
  }

  async withdraw({ meterId, publicKey, nowMs }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE registry_meters
         SET days = '[]'::jsonb,
             stats = '{}'::jsonb,
             week_tokens = 0,
             generated_at_ms = NULL,
             updated_at_ms = $3
         WHERE meter_id = $1 AND public_key = $2 AND generated_at_ms IS NOT NULL`,
        [meterId, publicKey, nowMs],
      );
      if (result.rowCount > 0 && this.profileSchemaAvailable) {
        const membership = await client.query(
          "SELECT profile_id FROM registry_profile_devices WHERE meter_id = $1",
          [meterId],
        );
        if (membership.rowCount > 0) {
          await client.query(
            `UPDATE registry_profile_devices
             SET sharing_enabled = FALSE, last_reported_at_ms = $2
             WHERE meter_id = $1`,
            [meterId, nowMs],
          );
          await this.#recomputeProfile(client, membership.rows[0].profile_id, nowMs);
        }
      }
      if (result.rowCount > 0) {
        await client.query("COMMIT");
        return { wiped: true };
      }
      const collision = await client.query(
        "SELECT 1 FROM registry_meters WHERE meter_id = $1 AND public_key <> $2",
        [meterId, publicKey],
      );
      await client.query("COMMIT");
      if (collision.rowCount > 0) {
        return { wiped: false, reason: "identity-collision" };
      }
      return { wiped: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async leaderboard(limit = 100) {
    if (this.profileReadsRequested) {
      const result = await this.pool.query(
        `SELECT profile_id, handle, week_tokens, stats, updated_at_ms
         FROM registry_profiles
         WHERE generated_at_ms IS NOT NULL
         ORDER BY week_tokens DESC, updated_at_ms DESC, profile_id ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((profile) => ({
        rowId: registryRowId(profile.profile_id),
        name: displayName(profile.profile_id, profile.handle),
        handle: profile.handle ?? null,
        tokens: asNumber(profile.week_tokens) ?? 0,
        lifetimeTokens: profile.stats?.lifetimeTokens ?? 0,
        sessions: profile.stats?.sessionsLast7Days ?? null,
        sessionWindowDays: 7,
        updatedAtMs: asNumber(profile.updated_at_ms),
      }));
    }
    const result = await this.pool.query(
      `SELECT meter_id, handle, week_tokens, stats, updated_at_ms
       FROM registry_meters
       WHERE generated_at_ms IS NOT NULL
       ORDER BY week_tokens DESC, updated_at_ms DESC, meter_id ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((meter) => ({
      rowId: registryRowId(meter.meter_id),
      name: displayName(meter.meter_id, meter.handle),
      handle: meter.handle ?? null,
      tokens: asNumber(meter.week_tokens) ?? 0,
      lifetimeTokens: meter.stats?.lifetimeTokens ?? 0,
      sessions: meter.stats?.sessionsLast7Days ?? null,
      sessionWindowDays: 7,
      updatedAtMs: asNumber(meter.updated_at_ms),
    }));
  }

  async profile(handle) {
    if (this.profileReadsRequested) {
      const result = await this.pool.query(
        `SELECT p.days, p.stats, p.week_tokens, p.generated_at_ms, p.updated_at_ms
         FROM registry_handles AS h
         JOIN registry_profiles AS p ON p.profile_id = h.profile_id
         WHERE h.handle = $1`,
        [handle],
      );
      const profile = result.rows[0];
      if (!profile) return null;
      if (profile.generated_at_ms == null) return { handle, shared: false };
      return {
        handle,
        shared: true,
        days: profile.days ?? [],
        stats: profile.stats ?? {},
        weekTokens: asNumber(profile.week_tokens) ?? 0,
        updatedAtMs: asNumber(profile.updated_at_ms),
      };
    }
    const result = await this.pool.query(
      `SELECT m.days, m.stats, m.week_tokens, m.generated_at_ms, m.updated_at_ms
       FROM registry_handles AS h
       JOIN registry_meters AS m ON m.meter_id = h.meter_id
       WHERE h.handle = $1`,
      [handle],
    );
    const meter = result.rows[0];
    if (!meter) return null;
    if (meter.generated_at_ms == null) return { handle, shared: false };
    return {
      handle,
      shared: true,
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

export function createRegistryStore({ databaseUrl, dataFile, profileReads = false }) {
  return databaseUrl
    ? new PostgresRegistryStore({ databaseUrl, profileReads })
    : new FileRegistryStore({ dataFile, profileReads });
}
