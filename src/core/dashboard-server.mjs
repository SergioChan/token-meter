import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultIdentityDir,
  isValidHandle,
  loadOrCreateIdentity,
  markHandleClaimed,
  setProfileMembership,
  setHandle,
  setPendingWithdraw,
  setSharingEnabled,
} from "./identity.mjs";
import { UsageHistory } from "./usage-history.mjs";
import {
  registryEnabled,
  checkHandleAvailable,
  claimHandle,
  createLeaderboardUrl,
  createProfileInvite,
  fetchProfileDevices,
  fetchProfileMembership,
  joinExistingProfile,
  revokeProfileDevice,
  transferProfileOwner,
  uploadUsage,
  withdrawUsage,
} from "./registry-client.mjs";
import { communityWebBase } from "./registry-config.mjs";

// Candidate handles offered when the wanted one is taken. Kept short and
// human — the kind of alternative a person would actually pick.
export function handleCandidates(base, nowMs = Date.now()) {
  const trimmed = String(base).slice(0, 24);
  const year = String(new Date(nowMs).getFullYear());
  return [
    `${trimmed}-dev`,
    `${trimmed}-ai`,
    `${trimmed}${year.slice(-2)}`,
    `${trimmed}-codes`,
    `real-${trimmed}`,
    `${trimmed}-io`,
  ].filter((candidate) => isValidHandle(candidate) && candidate !== base);
}

const MAX_BODY_BYTES = 4096;
const USAGE_TTL_MS = 60_000;

// Loopback-only profile and community-action server for the dashboard page.
// Every request must carry the per-instance nonce; the browser page reads it
// from its own URL. Registry calls remain signed by the local identity.
export class DashboardServer {
  constructor({
    webDir,
    identityDir = defaultIdentityDir(),
    usageHistory = null,
    leaderboardUrlFactory = createLeaderboardUrl,
    usageUploader = uploadUsage,
    usageWithdrawer = withdrawUsage,
    handleChecker = checkHandleAvailable,
    handleClaimer = claimHandle,
    profileInviteCreator = createProfileInvite,
    profileJoiner = joinExistingProfile,
    profileMembershipFetcher = fetchProfileMembership,
    profileDevicesFetcher = fetchProfileDevices,
    profileDeviceRevoker = revokeProfileDevice,
    profileOwnerTransferer = transferProfileOwner,
  }) {
    if (!webDir) throw new TypeError("webDir is required");
    this.webDir = webDir;
    this.identityDir = identityDir;
    this.usageHistory = usageHistory ?? new UsageHistory();
    this.leaderboardUrlFactory = leaderboardUrlFactory;
    this.usageUploader = usageUploader;
    this.usageWithdrawer = usageWithdrawer;
    this.handleChecker = handleChecker;
    this.handleClaimer = handleClaimer;
    this.profileInviteCreator = profileInviteCreator;
    this.profileJoiner = profileJoiner;
    this.profileMembershipFetcher = profileMembershipFetcher;
    this.profileDevicesFetcher = profileDevicesFetcher;
    this.profileDeviceRevoker = profileDeviceRevoker;
    this.profileOwnerTransferer = profileOwnerTransferer;
    this.usageMemo = null;
    this.nonce = randomBytes(16).toString("hex");
    this.server = null;
    this.port = null;
  }

  #usage() {
    if (this.usageMemo && Date.now() - this.usageMemo.atMs < USAGE_TTL_MS) {
      return this.usageMemo.result;
    }
    const result = this.usageHistory.collect();
    this.usageMemo = { atMs: Date.now(), result };
    return result;
  }

  #authorized(requestUrl) {
    const token = requestUrl.searchParams.get("token") ?? "";
    const expected = Buffer.from(this.nonce);
    const provided = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(expected, provided);
  }

  #publicIdentity() {
    const { privateKeyPem, ...publicFields } = loadOrCreateIdentity(this.identityDir);
    return publicFields;
  }

  async #readBody(request) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        const error = new Error("body too large");
        error.status = 413;
        throw error;
      }
    }
    return raw;
  }

  // Up to three candidates that are actually free right now. Registry
  // hiccups just shorten the list — suggestions are best-effort.
  async #availableCandidates(base) {
    const checks = await Promise.all(
      handleCandidates(base).map(async (candidate) => {
        try {
          const { available } = await this.handleChecker(candidate);
          return available ? candidate : null;
        } catch {
          return null;
        }
      }),
    );
    return checks.filter(Boolean).slice(0, 3);
  }

  async #handle(request, response) {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${this.port}`);
    const reply = (status, type, body) => {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(body);
    };
    const replyJson = (status, value) =>
      reply(status, "application/json", JSON.stringify(value));

    if (!this.#authorized(requestUrl)) {
      return replyJson(403, { error: "invalid or missing token" });
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      const html = readFileSync(join(this.webDir, "dashboard.html"), "utf8");
      return reply(200, "text/html; charset=utf-8", html);
    }
    if (request.method === "GET" && requestUrl.pathname === "/share") {
      const html = readFileSync(join(this.webDir, "share.html"), "utf8");
      return reply(200, "text/html; charset=utf-8", html);
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/share/handle-check") {
      const handle = (requestUrl.searchParams.get("handle") ?? "").toLowerCase();
      if (!isValidHandle(handle)) {
        return replyJson(200, { valid: false, available: false });
      }
      const identity = loadOrCreateIdentity(this.identityDir);
      if (handle === identity.handle && identity.handleClaimed) {
        return replyJson(200, { valid: true, available: true, current: true });
      }
      if (!registryEnabled()) {
        return replyJson(200, { valid: true, available: null, offline: true });
      }
      try {
        const { available } = await this.handleChecker(handle);
        if (available) return replyJson(200, { valid: true, available: true });
        return replyJson(200, {
          valid: true,
          available: false,
          suggestions: await this.#availableCandidates(handle),
        });
      } catch {
        return replyJson(200, { valid: true, available: null, offline: true });
      }
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/share/publish") {
      let body;
      try {
        body = JSON.parse(await this.#readBody(request));
      } catch (error) {
        return replyJson(error.status ?? 400, { error: error.message ?? "invalid JSON" });
      }
      if (body.agree !== true) {
        return replyJson(422, { error: "the privacy agreement was not accepted" });
      }
      const handle = String(body.handle ?? "").toLowerCase();
      if (!isValidHandle(handle)) {
        return replyJson(422, {
          error: "handle must be 2-30 chars: lowercase letters, digits, hyphens",
        });
      }
      // Publishing is all-or-nothing: the handle claim must land before
      // sharing turns on, so a failure leaves everything as it was.
      const previous = loadOrCreateIdentity(this.identityDir);
      const updated = setHandle(handle, this.identityDir);
      if (registryEnabled()) {
        try {
          await this.handleClaimer(updated, this.identityDir);
        } catch (error) {
          setHandle(previous.handle ?? null, this.identityDir);
          if (previous.handleClaimed) markHandleClaimed(this.identityDir);
          if (error.status === 409) {
            return replyJson(409, {
              error: `@${handle} is already claimed — first come, first served.`,
              suggestions: await this.#availableCandidates(handle),
            });
          }
          return replyJson(502, { error: "the community registry is unreachable — try again shortly" });
        }
      }
      const identity = setSharingEnabled(true, this.identityDir);
      let sync = "ok";
      if (registryEnabled()) {
        try {
          await this.usageUploader(identity, this.#usage());
        } catch {
          sync = "pending"; // the hourly worker retries; consent is recorded
        }
      }
      const webBase = communityWebBase();
      return replyJson(200, {
        ...this.#publicIdentity(),
        sync,
        profileUrl: webBase ? `${webBase}/u/${handle}` : null,
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/share/withdraw") {
      let body;
      try {
        body = JSON.parse(await this.#readBody(request));
      } catch (error) {
        return replyJson(error.status ?? 400, { error: error.message ?? "invalid JSON" });
      }
      if (body.confirm !== true) {
        return replyJson(422, { error: "withdrawal was not confirmed" });
      }
      const identity = loadOrCreateIdentity(this.identityDir);
      let wiped = false;
      if (registryEnabled()) {
        try {
          const result = await this.usageWithdrawer(identity);
          wiped = Boolean(result.ok);
          setPendingWithdraw(false, this.identityDir);
        } catch {
          setPendingWithdraw(true, this.identityDir);
        }
      }
      setSharingEnabled(false, this.identityDir);
      return replyJson(200, {
        ...this.#publicIdentity(),
        wiped,
        pendingWithdraw: !wiped && registryEnabled(),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/profile") {
      return replyJson(200, this.#publicIdentity());
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/profile/membership") {
      if (!registryEnabled()) return replyJson(503, { error: "community registry is not configured" });
      const identity = loadOrCreateIdentity(this.identityDir);
      try {
        const membership = await this.profileMembershipFetcher(identity);
        if (membership.member) {
          setProfileMembership({
            ...membership,
            lastConfirmedAtMs: Date.now(),
          }, this.identityDir);
        }
        return replyJson(200, membership);
      } catch (error) {
        return replyJson(error.status ?? 502, { error: error.message ?? "membership lookup failed" });
      }
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/profile/join") {
      let body;
      try {
        body = JSON.parse(await this.#readBody(request));
      } catch (error) {
        return replyJson(error.status ?? 400, { error: error.message ?? "invalid JSON" });
      }
      if (body.agree !== true) {
        return replyJson(422, { error: "the privacy agreement was not accepted" });
      }
      if (typeof body.inviteToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.inviteToken)) {
        return replyJson(422, { error: "invalid device invitation" });
      }
      const deviceLabel = body.deviceLabel == null ? null : String(body.deviceLabel).trim();
      if (deviceLabel != null && (deviceLabel.length < 1 || deviceLabel.length > 80)) {
        return replyJson(422, { error: "device label must be 1-80 characters" });
      }
      if (!registryEnabled()) return replyJson(503, { error: "community registry is not configured" });
      try {
        const identity = loadOrCreateIdentity(this.identityDir);
        const joined = await this.profileJoiner(
          identity,
          { inviteToken: body.inviteToken, deviceLabel },
          this.identityDir,
        );
        const sharingIdentity = setSharingEnabled(true, this.identityDir);
        let sync = "ok";
        try {
          await this.usageUploader(sharingIdentity, this.#usage());
        } catch {
          sync = "pending";
        }
        const webBase = communityWebBase();
        return replyJson(200, {
          ...this.#publicIdentity(),
          joined,
          sync,
          profileUrl:
            webBase && joined.handle ? `${webBase}/u/${joined.handle}` : null,
        });
      } catch (error) {
        return replyJson(error.status ?? 502, { error: error.message ?? "Profile join failed" });
      }
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/profile/invite") {
      let body;
      try {
        body = JSON.parse(await this.#readBody(request));
      } catch (error) {
        return replyJson(error.status ?? 400, { error: error.message ?? "invalid JSON" });
      }
      const mode = body.mode ?? "add";
      if (!registryEnabled()) return replyJson(503, { error: "community registry is not configured" });
      try {
        const result = await this.profileInviteCreator(
          loadOrCreateIdentity(this.identityDir),
          { mode, replaceMeterId: body.replaceMeterId ?? null },
        );
        return replyJson(200, result);
      } catch (error) {
        return replyJson(error.status ?? 502, { error: error.message ?? "invitation failed" });
      }
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/profile/devices") {
      if (!registryEnabled()) return replyJson(503, { error: "community registry is not configured" });
      try {
        return replyJson(200, await this.profileDevicesFetcher(
          loadOrCreateIdentity(this.identityDir),
        ));
      } catch (error) {
        return replyJson(error.status ?? 502, { error: error.message ?? "device lookup failed" });
      }
    }
    if (
      request.method === "POST" &&
      ["/api/profile/devices/revoke", "/api/profile/devices/transfer-owner"].includes(
        requestUrl.pathname,
      )
    ) {
      let body;
      try {
        body = JSON.parse(await this.#readBody(request));
      } catch (error) {
        return replyJson(error.status ?? 400, { error: error.message ?? "invalid JSON" });
      }
      if (typeof body.targetMeterId !== "string") {
        return replyJson(422, { error: "targetMeterId is required" });
      }
      if (!registryEnabled()) return replyJson(503, { error: "community registry is not configured" });
      const action = requestUrl.pathname.endsWith("transfer-owner")
        ? this.profileOwnerTransferer
        : this.profileDeviceRevoker;
      try {
        return replyJson(200, await action(
          loadOrCreateIdentity(this.identityDir),
          body.targetMeterId,
        ));
      } catch (error) {
        return replyJson(error.status ?? 502, { error: error.message ?? "device update failed" });
      }
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/usage") {
      return replyJson(200, this.#usage());
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/sharing") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) return replyJson(413, { error: "body too large" });
      }
      let enabled;
      try {
        enabled = JSON.parse(raw).enabled;
      } catch {
        return replyJson(400, { error: "invalid JSON" });
      }
      if (typeof enabled !== "boolean") {
        return replyJson(422, { error: "enabled must be a boolean" });
      }
      const identity = setSharingEnabled(enabled, this.identityDir);
      let communitySync = null;
      if (enabled && registryEnabled()) {
        try {
          await this.usageUploader(identity, this.#usage());
          communitySync = "ok";
        } catch {
          communitySync = "pending";
        }
      }
      return replyJson(200, { ...this.#publicIdentity(), communitySync });
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/api/leaderboard-pairing"
    ) {
      const identity = loadOrCreateIdentity(this.identityDir);
      if (identity.sharing?.enabled === true && registryEnabled()) {
        await this.usageUploader(identity, this.#usage()).catch(() => {});
      }
      try {
        const url = await this.leaderboardUrlFactory(identity);
        return replyJson(200, { url });
      } catch (error) {
        return replyJson(502, {
          error: error instanceof Error ? error.message : "pairing failed",
        });
      }
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/handle") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) return replyJson(413, { error: "body too large" });
      }
      let handle;
      try {
        handle = JSON.parse(raw).handle;
      } catch {
        return replyJson(400, { error: "invalid JSON" });
      }
      if (!isValidHandle(handle)) {
        return replyJson(422, {
          error:
            "handle must be 2-30 chars: lowercase letters, digits, hyphens",
        });
      }
      // Global first-come-first-serve: the registry claim IS the uniqueness
      // check. On rejection the previous local handle is restored.
      const previous = loadOrCreateIdentity(this.identityDir);
      const updated = setHandle(handle, this.identityDir);
      if (registryEnabled()) {
        try {
          await claimHandle(updated, this.identityDir);
        } catch (error) {
          if (error.status === 409) {
            setHandle(previous.handle ?? null, this.identityDir);
            return replyJson(409, {
              error: `@${handle} is already claimed — first come, first served. Try another.`,
            });
          }
          // Registry unreachable: keep the local reservation, claim later.
        }
      }
      return replyJson(200, this.#publicIdentity());
    }
    return replyJson(404, { error: "not found" });
  }

  async start() {
    if (this.server) return this;
    this.server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        try {
          response.writeHead(500).end();
        } catch {
          /* response already closed */
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  url(view = null) {
    if (this.port == null) throw new Error("server is not started");
    const base = `http://127.0.0.1:${this.port}`;
    if (view === "share") return `${base}/share?token=${this.nonce}`;
    if (view === "withdraw") return `${base}/share?token=${this.nonce}&mode=withdraw`;
    return `${base}/?token=${this.nonce}`;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
  }
}
