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

  #pruneDeviceInvites(nowMs) {
    let changed = false;
    for (const [tokenHash, invite] of Object.entries(this.data.deviceInvites)) {
      if (invite.expiresAtMs <= nowMs || invite.consumedAtMs != null) {
        delete this.data.deviceInvites[tokenHash];
        changed = true;
      }
    }
    return changed;
  }

  #activeMembership(meterId, publicKey) {
    const meter = this.data.meters[meterId];
    if (!meter || meter.publicKey !== publicKey) return null;
    const device = this.data.profileDevices[meterId];
    return device && device.revokedAtMs == null ? device : null;
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
    const existingDevice = this.data.profileDevices[meterId];
    if (existingDevice?.revokedAtMs != null) {
      return { accepted: false, reason: "device-revoked" };
    }
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
    if (this.data.profileDevices[meterId]?.revokedAtMs != null) {
      return { created: false, reason: "device-revoked" };
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

  async createDeviceInvite({
    tokenHash,
    meterId,
    publicKey,
    mode,
    replaceMeterId,
    nowMs,
    expiresAtMs,
  }) {
    const pruned = this.#pruneDeviceInvites(nowMs);
    const membership = this.#activeMembership(meterId, publicKey);
    if (!membership) {
      if (pruned) this.#save();
      return { created: false, reason: "not-a-member" };
    }
    const profile = this.data.profiles[membership.profileId];
    if (membership.role !== "owner" || profile?.ownerMeterId !== meterId) {
      if (pruned) this.#save();
      return { created: false, reason: "not-owner" };
    }
    if (this.data.deviceInvites[tokenHash]) {
      return { created: false, reason: "token-collision" };
    }
    if (mode === "replace") {
      const target = this.data.profileDevices[replaceMeterId];
      if (
        !target ||
        target.profileId !== membership.profileId ||
        target.revokedAtMs != null ||
        target.role === "owner"
      ) {
        return { created: false, reason: "invalid-replacement-target" };
      }
    }
    this.data.deviceInvites[tokenHash] = {
      profileId: membership.profileId,
      createdByMeterId: meterId,
      mode,
      replaceMeterId: mode === "replace" ? replaceMeterId : null,
      createdAtMs: nowMs,
      expiresAtMs,
      consumedAtMs: null,
      joinedMeterId: null,
    };
    this.#save();
    return {
      created: true,
      profileId: membership.profileId,
      handle: profile.handle ?? null,
      expiresAtMs,
    };
  }

  async joinProfile({ tokenHash, meterId, publicKey, deviceLabel, nowMs }) {
    const invite = this.data.deviceInvites[tokenHash];
    if (!invite || invite.consumedAtMs != null || invite.expiresAtMs <= nowMs) {
      if (invite) {
        delete this.data.deviceInvites[tokenHash];
        this.#save();
      }
      return { joined: false, reason: "invalid-or-expired" };
    }
    const profile = this.data.profiles[invite.profileId];
    const creator = this.data.profileDevices[invite.createdByMeterId];
    if (
      !profile ||
      profile.ownerMeterId !== invite.createdByMeterId ||
      creator?.role !== "owner" ||
      creator.revokedAtMs != null
    ) {
      return { joined: false, reason: "invite-no-longer-authorized" };
    }
    const meter = (this.data.meters[meterId] ??= {});
    if (meter.publicKey && meter.publicKey !== publicKey) {
      return { joined: false, reason: "identity-collision" };
    }
    const existing = this.data.profileDevices[meterId];
    if (existing && existing.profileId !== invite.profileId) {
      return { joined: false, reason: "device-already-linked" };
    }
    if (invite.mode === "replace") {
      const target = this.data.profileDevices[invite.replaceMeterId];
      if (
        !target ||
        target.profileId !== invite.profileId ||
        target.revokedAtMs != null ||
        target.role === "owner"
      ) {
        return { joined: false, reason: "invalid-replacement-target" };
      }
      target.revokedAtMs = nowMs;
      target.sharingEnabled = false;
      target.replacedByMeterId = meterId;
    }
    meter.publicKey = publicKey;
    meter.updatedAtMs = nowMs;
    this.data.profileDevices[meterId] = {
      profileId: invite.profileId,
      role: existing?.role === "owner" ? "owner" : "member",
      sharingEnabled: existing?.sharingEnabled ?? false,
      joinedAtMs: existing?.joinedAtMs ?? nowMs,
      lastReportedAtMs: existing?.lastReportedAtMs ?? null,
      revokedAtMs: null,
      replacedByMeterId: null,
      deviceLabel,
    };
    invite.consumedAtMs = nowMs;
    invite.joinedMeterId = meterId;
    if (invite.mode === "replace") this.#recomputeProfile(invite.profileId, nowMs);
    const deviceCount = Object.values(this.data.profileDevices).filter(
      (device) => device.profileId === invite.profileId && device.revokedAtMs == null,
    ).length;
    this.#save();
    return {
      joined: true,
      profileId: invite.profileId,
      handle: profile.handle ?? null,
      role: this.data.profileDevices[meterId].role,
      deviceCount,
    };
  }

  async profileMembership({ meterId, publicKey }) {
    const membership = this.#activeMembership(meterId, publicKey);
    if (!membership) return null;
    const profile = this.data.profiles[membership.profileId];
    return {
      profileId: membership.profileId,
      handle: profile?.handle ?? null,
      role: membership.role,
      sharingEnabled: membership.sharingEnabled,
      deviceLabel: membership.deviceLabel,
      joinedAtMs: membership.joinedAtMs,
      lastReportedAtMs: membership.lastReportedAtMs,
    };
  }

  async listProfileDevices({ meterId, publicKey }) {
    const membership = this.#activeMembership(meterId, publicKey);
    const profile = membership ? this.data.profiles[membership.profileId] : null;
    if (!membership || membership.role !== "owner" || profile?.ownerMeterId !== meterId) {
      return { authorized: false, reason: "not-owner" };
    }
    const devices = Object.entries(this.data.profileDevices)
      .filter(([, device]) => device.profileId === membership.profileId)
      .map(([deviceMeterId, device]) => ({
        meterId: deviceMeterId,
        role: device.role,
        sharingEnabled: device.sharingEnabled,
        joinedAtMs: device.joinedAtMs,
        lastReportedAtMs: device.lastReportedAtMs,
        revokedAtMs: device.revokedAtMs,
        replacedByMeterId: device.replacedByMeterId,
        deviceLabel: device.deviceLabel,
      }))
      .sort((left, right) => left.joinedAtMs - right.joinedAtMs || left.meterId.localeCompare(right.meterId));
    return { authorized: true, profileId: membership.profileId, devices };
  }

  async revokeProfileDevice({ meterId, publicKey, targetMeterId, nowMs }) {
    const membership = this.#activeMembership(meterId, publicKey);
    const profile = membership ? this.data.profiles[membership.profileId] : null;
    if (!membership || membership.role !== "owner" || profile?.ownerMeterId !== meterId) {
      return { revoked: false, reason: "not-owner" };
    }
    if (targetMeterId === meterId) return { revoked: false, reason: "cannot-revoke-owner" };
    const target = this.data.profileDevices[targetMeterId];
    if (!target || target.profileId !== membership.profileId) {
      return { revoked: false, reason: "unknown-device" };
    }
    if (target.revokedAtMs != null) return { revoked: true, alreadyRevoked: true };
    target.revokedAtMs = nowMs;
    target.sharingEnabled = false;
    this.#recomputeProfile(membership.profileId, nowMs);
    this.#save();
    return { revoked: true, alreadyRevoked: false };
  }

  async transferProfileOwner({ meterId, publicKey, targetMeterId, nowMs }) {
    const membership = this.#activeMembership(meterId, publicKey);
    const profile = membership ? this.data.profiles[membership.profileId] : null;
    if (!membership || membership.role !== "owner" || profile?.ownerMeterId !== meterId) {
      return { transferred: false, reason: "not-owner" };
    }
    const target = this.data.profileDevices[targetMeterId];
    const targetMeter = this.data.meters[targetMeterId];
    if (
      !target ||
      !targetMeter ||
      target.profileId !== membership.profileId ||
      target.revokedAtMs != null ||
      targetMeterId === meterId
    ) {
      return { transferred: false, reason: "invalid-target" };
    }
    membership.role = "member";
    target.role = "owner";
    profile.ownerMeterId = targetMeterId;
    const handle = profile.handle;
    if (handle) {
      this.data.handles[handle].meterId = targetMeterId;
      this.data.handles[handle].publicKey = targetMeter.publicKey;
      delete this.data.meters[meterId].handle;
      targetMeter.handle = handle;
    }
    profile.updatedAtMs = Math.max(profile.updatedAtMs ?? 0, nowMs);
    this.#save();
    return { transferred: true, profileId: membership.profileId, ownerMeterId: targetMeterId };
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
      if (this.profileSchemaAvailable) {
        const membership = await client.query(
          "SELECT revoked_at_ms FROM registry_profile_devices WHERE meter_id = $1",
          [meterId],
        );
        if (membership.rows[0]?.revoked_at_ms != null) {
          await client.query("ROLLBACK");
          return { accepted: false, reason: "device-revoked" };
        }
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
      if (this.profileSchemaAvailable) {
        const membership = await client.query(
          "SELECT revoked_at_ms FROM registry_profile_devices WHERE meter_id = $1",
          [meterId],
        );
        if (membership.rows[0]?.revoked_at_ms != null) {
          await client.query("ROLLBACK");
          return { created: false, reason: "device-revoked" };
        }
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

  async createDeviceInvite({
    tokenHash,
    meterId,
    publicKey,
    mode,
    replaceMeterId,
    nowMs,
    expiresAtMs,
  }) {
    if (!this.profileSchemaAvailable) {
      return { created: false, reason: "feature-unavailable" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM registry_device_invites WHERE expires_at_ms <= $1 OR consumed_at_ms IS NOT NULL",
        [nowMs],
      );
      const meter = await client.query(
        "SELECT public_key FROM registry_meters WHERE meter_id = $1 FOR UPDATE",
        [meterId],
      );
      if (meter.rows[0]?.public_key !== publicKey) {
        await client.query("ROLLBACK");
        return { created: false, reason: "not-a-member" };
      }
      const membership = await client.query(
        `SELECT profile_id, role
         FROM registry_profile_devices
         WHERE meter_id = $1 AND revoked_at_ms IS NULL`,
        [meterId],
      );
      if (membership.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { created: false, reason: "not-a-member" };
      }
      const profile = await client.query(
        `SELECT owner_meter_id, handle
         FROM registry_profiles
         WHERE profile_id = $1
         FOR UPDATE`,
        [membership.rows[0].profile_id],
      );
      if (
        membership.rows[0].role !== "owner" ||
        profile.rows[0]?.owner_meter_id !== meterId
      ) {
        await client.query("ROLLBACK");
        return { created: false, reason: "not-owner" };
      }
      if (mode === "replace") {
        const target = await client.query(
          `SELECT role
           FROM registry_profile_devices
           WHERE profile_id = $1 AND meter_id = $2 AND revoked_at_ms IS NULL`,
          [membership.rows[0].profile_id, replaceMeterId],
        );
        if (target.rowCount !== 1 || target.rows[0].role === "owner") {
          await client.query("ROLLBACK");
          return { created: false, reason: "invalid-replacement-target" };
        }
      }
      const created = await client.query(
        `INSERT INTO registry_device_invites
           (token_hash, profile_id, created_by_meter_id, mode, replace_meter_id,
            created_at_ms, expires_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (token_hash) DO NOTHING`,
        [
          tokenHash,
          membership.rows[0].profile_id,
          meterId,
          mode,
          mode === "replace" ? replaceMeterId : null,
          nowMs,
          expiresAtMs,
        ],
      );
      if (created.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { created: false, reason: "token-collision" };
      }
      await client.query("COMMIT");
      return {
        created: true,
        profileId: membership.rows[0].profile_id,
        handle: profile.rows[0].handle ?? null,
        expiresAtMs,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async joinProfile({ tokenHash, meterId, publicKey, deviceLabel, nowMs }) {
    if (!this.profileSchemaAvailable) {
      return { joined: false, reason: "feature-unavailable" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inviteResult = await client.query(
        `SELECT profile_id, created_by_meter_id, mode, replace_meter_id,
                expires_at_ms, consumed_at_ms
         FROM registry_device_invites
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );
      const invite = inviteResult.rows[0];
      if (
        !invite ||
        invite.consumed_at_ms != null ||
        Number(invite.expires_at_ms) <= nowMs
      ) {
        if (invite) {
          await client.query("DELETE FROM registry_device_invites WHERE token_hash = $1", [tokenHash]);
        }
        await client.query("COMMIT");
        return { joined: false, reason: "invalid-or-expired" };
      }
      const profileResult = await client.query(
        `SELECT owner_meter_id, handle
         FROM registry_profiles
         WHERE profile_id = $1
         FOR UPDATE`,
        [invite.profile_id],
      );
      const profile = profileResult.rows[0];
      const creator = await client.query(
        `SELECT role
         FROM registry_profile_devices
         WHERE profile_id = $1 AND meter_id = $2 AND revoked_at_ms IS NULL`,
        [invite.profile_id, invite.created_by_meter_id],
      );
      if (
        !profile ||
        profile.owner_meter_id !== invite.created_by_meter_id ||
        creator.rows[0]?.role !== "owner"
      ) {
        await client.query("ROLLBACK");
        return { joined: false, reason: "invite-no-longer-authorized" };
      }
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
        return { joined: false, reason: "identity-collision" };
      }
      const existing = await client.query(
        `SELECT profile_id, role, sharing_enabled, joined_at_ms, last_reported_at_ms
         FROM registry_profile_devices
         WHERE meter_id = $1`,
        [meterId],
      );
      if (existing.rowCount > 0 && existing.rows[0].profile_id !== invite.profile_id) {
        await client.query("ROLLBACK");
        return { joined: false, reason: "device-already-linked" };
      }
      if (invite.mode === "replace") {
        const target = await client.query(
          `SELECT role
           FROM registry_profile_devices
           WHERE profile_id = $1 AND meter_id = $2 AND revoked_at_ms IS NULL
           FOR UPDATE`,
          [invite.profile_id, invite.replace_meter_id],
        );
        if (target.rowCount !== 1 || target.rows[0].role === "owner") {
          await client.query("ROLLBACK");
          return { joined: false, reason: "invalid-replacement-target" };
        }
        await client.query(
          `UPDATE registry_profile_devices
           SET revoked_at_ms = $3,
               sharing_enabled = FALSE,
               replaced_by_meter_id = $2
           WHERE profile_id = $1 AND meter_id = $4`,
          [invite.profile_id, meterId, nowMs, invite.replace_meter_id],
        );
      }
      if (existing.rowCount === 0) {
        await client.query(
          `INSERT INTO registry_profile_devices
             (profile_id, meter_id, role, sharing_enabled, joined_at_ms, device_label)
           VALUES ($1, $2, 'member', FALSE, $3, $4)`,
          [invite.profile_id, meterId, nowMs, deviceLabel],
        );
      } else {
        await client.query(
          `UPDATE registry_profile_devices
           SET revoked_at_ms = NULL,
               replaced_by_meter_id = NULL,
               device_label = $2
           WHERE meter_id = $1`,
          [meterId, deviceLabel],
        );
      }
      await client.query(
        `UPDATE registry_device_invites
         SET consumed_at_ms = $2, joined_meter_id = $3
         WHERE token_hash = $1`,
        [tokenHash, nowMs, meterId],
      );
      if (invite.mode === "replace") {
        await this.#recomputeProfile(client, invite.profile_id, nowMs);
      }
      const count = await client.query(
        `SELECT COUNT(*)::bigint AS count
         FROM registry_profile_devices
         WHERE profile_id = $1 AND revoked_at_ms IS NULL`,
        [invite.profile_id],
      );
      await client.query("COMMIT");
      return {
        joined: true,
        profileId: invite.profile_id,
        handle: profile.handle ?? null,
        role: existing.rows[0]?.role === "owner" ? "owner" : "member",
        deviceCount: Number(count.rows[0].count),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async profileMembership({ meterId, publicKey }) {
    if (!this.profileSchemaAvailable) return null;
    const result = await this.pool.query(
      `SELECT d.profile_id, d.role, d.sharing_enabled, d.device_label,
              d.joined_at_ms, d.last_reported_at_ms, p.handle
       FROM registry_profile_devices AS d
       JOIN registry_profiles AS p ON p.profile_id = d.profile_id
       JOIN registry_meters AS m ON m.meter_id = d.meter_id
       WHERE d.meter_id = $1 AND m.public_key = $2 AND d.revoked_at_ms IS NULL`,
      [meterId, publicKey],
    );
    const membership = result.rows[0];
    return membership ? {
      profileId: membership.profile_id,
      handle: membership.handle ?? null,
      role: membership.role,
      sharingEnabled: membership.sharing_enabled,
      deviceLabel: membership.device_label ?? null,
      joinedAtMs: Number(membership.joined_at_ms),
      lastReportedAtMs:
        membership.last_reported_at_ms == null ? null : Number(membership.last_reported_at_ms),
    } : null;
  }

  async listProfileDevices({ meterId, publicKey }) {
    const membership = await this.profileMembership({ meterId, publicKey });
    if (!membership || membership.role !== "owner") {
      return { authorized: false, reason: "not-owner" };
    }
    const profile = await this.pool.query(
      "SELECT owner_meter_id FROM registry_profiles WHERE profile_id = $1",
      [membership.profileId],
    );
    if (profile.rows[0]?.owner_meter_id !== meterId) {
      return { authorized: false, reason: "not-owner" };
    }
    const result = await this.pool.query(
      `SELECT meter_id, role, sharing_enabled, joined_at_ms, last_reported_at_ms,
              revoked_at_ms, replaced_by_meter_id, device_label
       FROM registry_profile_devices
       WHERE profile_id = $1
       ORDER BY joined_at_ms ASC, meter_id ASC`,
      [membership.profileId],
    );
    return {
      authorized: true,
      profileId: membership.profileId,
      devices: result.rows.map((device) => ({
        meterId: device.meter_id,
        role: device.role,
        sharingEnabled: device.sharing_enabled,
        joinedAtMs: Number(device.joined_at_ms),
        lastReportedAtMs:
          device.last_reported_at_ms == null ? null : Number(device.last_reported_at_ms),
        revokedAtMs: device.revoked_at_ms == null ? null : Number(device.revoked_at_ms),
        replacedByMeterId: device.replaced_by_meter_id ?? null,
        deviceLabel: device.device_label ?? null,
      })),
    };
  }

  async revokeProfileDevice({ meterId, publicKey, targetMeterId, nowMs }) {
    if (!this.profileSchemaAvailable) {
      return { revoked: false, reason: "feature-unavailable" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const meter = await client.query(
        "SELECT public_key FROM registry_meters WHERE meter_id = $1 FOR UPDATE",
        [meterId],
      );
      const membership = await client.query(
        `SELECT d.profile_id, d.role, p.owner_meter_id
         FROM registry_profile_devices AS d
         JOIN registry_profiles AS p ON p.profile_id = d.profile_id
         WHERE d.meter_id = $1 AND d.revoked_at_ms IS NULL`,
        [meterId],
      );
      if (
        meter.rows[0]?.public_key !== publicKey ||
        membership.rows[0]?.role !== "owner" ||
        membership.rows[0]?.owner_meter_id !== meterId
      ) {
        await client.query("ROLLBACK");
        return { revoked: false, reason: "not-owner" };
      }
      if (targetMeterId === meterId) {
        await client.query("ROLLBACK");
        return { revoked: false, reason: "cannot-revoke-owner" };
      }
      const target = await client.query(
        `SELECT revoked_at_ms
         FROM registry_profile_devices
         WHERE profile_id = $1 AND meter_id = $2
         FOR UPDATE`,
        [membership.rows[0].profile_id, targetMeterId],
      );
      if (target.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { revoked: false, reason: "unknown-device" };
      }
      if (target.rows[0].revoked_at_ms != null) {
        await client.query("COMMIT");
        return { revoked: true, alreadyRevoked: true };
      }
      await client.query(
        `UPDATE registry_profile_devices
         SET revoked_at_ms = $3, sharing_enabled = FALSE
         WHERE profile_id = $1 AND meter_id = $2`,
        [membership.rows[0].profile_id, targetMeterId, nowMs],
      );
      await this.#recomputeProfile(client, membership.rows[0].profile_id, nowMs);
      await client.query("COMMIT");
      return { revoked: true, alreadyRevoked: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async transferProfileOwner({ meterId, publicKey, targetMeterId, nowMs }) {
    if (!this.profileSchemaAvailable) {
      return { transferred: false, reason: "feature-unavailable" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ownerMeter = await client.query(
        "SELECT public_key FROM registry_meters WHERE meter_id = $1 FOR UPDATE",
        [meterId],
      );
      const membership = await client.query(
        `SELECT d.profile_id, d.role, p.owner_meter_id, p.handle
         FROM registry_profile_devices AS d
         JOIN registry_profiles AS p ON p.profile_id = d.profile_id
         WHERE d.meter_id = $1 AND d.revoked_at_ms IS NULL
         FOR UPDATE`,
        [meterId],
      );
      if (
        ownerMeter.rows[0]?.public_key !== publicKey ||
        membership.rows[0]?.role !== "owner" ||
        membership.rows[0]?.owner_meter_id !== meterId
      ) {
        await client.query("ROLLBACK");
        return { transferred: false, reason: "not-owner" };
      }
      const target = await client.query(
        `SELECT d.role, m.public_key
         FROM registry_profile_devices AS d
         JOIN registry_meters AS m ON m.meter_id = d.meter_id
         WHERE d.profile_id = $1 AND d.meter_id = $2 AND d.revoked_at_ms IS NULL
         FOR UPDATE`,
        [membership.rows[0].profile_id, targetMeterId],
      );
      if (target.rowCount !== 1 || targetMeterId === meterId) {
        await client.query("ROLLBACK");
        return { transferred: false, reason: "invalid-target" };
      }
      await client.query(
        `UPDATE registry_profile_devices
         SET role = CASE WHEN meter_id = $2 THEN 'owner' ELSE 'member' END
         WHERE profile_id = $1 AND meter_id IN ($2, $3)`,
        [membership.rows[0].profile_id, targetMeterId, meterId],
      );
      await client.query(
        `UPDATE registry_profiles
         SET owner_meter_id = $2,
             updated_at_ms = CASE WHEN updated_at_ms > $3 THEN updated_at_ms ELSE $3 END
         WHERE profile_id = $1`,
        [membership.rows[0].profile_id, targetMeterId, nowMs],
      );
      if (membership.rows[0].handle) {
        await client.query("UPDATE registry_meters SET handle = NULL WHERE meter_id = $1", [meterId]);
        await client.query(
          "UPDATE registry_meters SET handle = $2 WHERE meter_id = $1",
          [targetMeterId, membership.rows[0].handle],
        );
        await client.query(
          `UPDATE registry_handles
           SET meter_id = $2, public_key = $3
           WHERE handle = $1`,
          [membership.rows[0].handle, targetMeterId, target.rows[0].public_key],
        );
      }
      await client.query("COMMIT");
      return {
        transferred: true,
        profileId: membership.rows[0].profile_id,
        ownerMeterId: targetMeterId,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
