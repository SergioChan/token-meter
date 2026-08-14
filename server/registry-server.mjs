import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { verifySignedPayload, isValidHandle } from "../src/core/identity.mjs";
import { FileRegistryStore } from "./registry-store.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_REPORT_AGE_MS = 15 * 60 * 1_000;
const MAX_REPORT_FUTURE_MS = 5 * 60 * 1_000;
const BROWSER_PAIRING_TTL_MS = 5 * 60 * 1_000;
const BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_SESSION_COOKIE = "__Host-token_widget_session";

function hashSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readCookie(header, name) {
  for (const item of String(header ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

function sessionCookie(token) {
  return `${BROWSER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(
    BROWSER_SESSION_TTL_MS / 1_000,
  )}; Secure; HttpOnly; SameSite=Lax`;
}

function clearedSessionCookie() {
  return `${BROWSER_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function browserOriginAllowed(origin) {
  if (!origin) return true;
  if (origin === "https://www.tokenwidget.app" || origin === "https://tokenwidget.app") {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function timelySignedRequest(payload, nowMs) {
  return (
    safeInteger(payload.generatedAtMs) &&
    payload.generatedAtMs >= nowMs - MAX_REPORT_AGE_MS &&
    payload.generatedAtMs <= nowMs + MAX_REPORT_FUTURE_MS
  );
}

function normalizeUsagePayload(payload, nowMs) {
  if (
    !safeInteger(payload.generatedAtMs) ||
    payload.generatedAtMs < nowMs - MAX_REPORT_AGE_MS ||
    payload.generatedAtMs > nowMs + MAX_REPORT_FUTURE_MS
  ) {
    return null;
  }
  if (!Array.isArray(payload.days) || payload.days.length > 120) return null;
  const days = [];
  for (const day of payload.days) {
    if (
      day == null ||
      typeof day !== "object" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !safeInteger(day.total)
    ) {
      return null;
    }
    days.push({ date: day.date, total: day.total });
  }
  const stats = payload.stats;
  const peakDay = stats?.peakDay;
  if (
    stats == null ||
    typeof stats !== "object" ||
    !safeInteger(stats.lifetimeTokens) ||
    !safeInteger(stats.sessionCount) ||
    !safeInteger(stats.currentStreakDays) ||
    !safeInteger(stats.longestStreakDays) ||
    stats.byPlatform == null ||
    typeof stats.byPlatform !== "object" ||
    !safeInteger(stats.byPlatform.claudeCode) ||
    !safeInteger(stats.byPlatform.codex) ||
    !safeInteger(stats.byPlatform.cline) ||
    (peakDay != null &&
      (typeof peakDay !== "object" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(peakDay.date) ||
        !safeInteger(peakDay.tokens))) ||
    !safeInteger(payload.weekTokens)
  ) {
    return null;
  }
  return {
    days,
    stats: {
      lifetimeTokens: stats.lifetimeTokens,
      currentStreakDays: stats.currentStreakDays,
      longestStreakDays: stats.longestStreakDays,
      sessionCount: stats.sessionCount,
      peakDay:
        peakDay == null
          ? null
          : { date: peakDay.date, tokens: peakDay.tokens },
      byPlatform: {
        claudeCode: stats.byPlatform.claudeCode,
        codex: stats.byPlatform.codex,
        cline: stats.byPlatform.cline,
      },
    },
    weekTokens: payload.weekTokens,
    generatedAtMs: payload.generatedAtMs,
  };
}

export class RegistryServer {
  constructor({
    store = null,
    dataFile = null,
    webDir,
    downloadFile = null,
    dmgFile = null,
    latestVersion = null,
    latestRelease = null,
    host = "127.0.0.1",
    now = Date.now,
  }) {
    if (!store && !dataFile) throw new TypeError("store or dataFile is required");
    if (!webDir) throw new TypeError("webDir is required");
    this.store = store ?? new FileRegistryStore({ dataFile });
    this.webDir = webDir;
    this.downloadFile = downloadFile;
    this.dmgFile = dmgFile;
    this.latestVersion = latestVersion;
    this.latestRelease = latestRelease;
    this.host = host;
    this.now = now;
    this.dmgDigestMemo = null;
    this.server = null;
    this.port = null;
  }

  // sha256 of the served DMG, recomputed only when the file changes on disk.
  #dmgDigest() {
    const stat = statSync(this.dmgFile);
    if (this.dmgDigestMemo?.mtimeMs !== stat.mtimeMs) {
      this.dmgDigestMemo = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256: createHash("sha256").update(readFileSync(this.dmgFile)).digest("hex"),
      };
    }
    return this.dmgDigestMemo;
  }

  async #handle(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${this.port}`);
    const reply = (status, type, body, extra = {}) => {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
      response.end(body);
    };
    const json = (status, value, extra = {}) =>
      reply(status, "application/json", JSON.stringify(value), extra);
    const page = (name) => {
      try {
        return reply(200, "text/html; charset=utf-8", readFileSync(join(this.webDir, name), "utf8"));
      } catch {
        return json(404, { error: "not found" });
      }
    };
    const readBody = async () => {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) throw new Error("body too large");
      }
      return JSON.parse(raw);
    };

    const path = url.pathname;
    if (request.method === "GET") {
      if (path === "/api/v1/live") return json(200, { ok: true });
      if (path === "/api/v1/health") {
        const health = await this.store.health();
        return json(200, { ok: true, ...health });
      }
      if (path === "/api/v1/latest") {
        if (this.latestRelease) {
          return json(200, this.latestRelease);
        }
        const version = process.env.TOKEN_METER_LATEST_VERSION || this.latestVersion;
        if (!version || !this.dmgFile || !existsSync(this.dmgFile)) {
          return json(404, { error: "no release published" });
        }
        const digest = this.#dmgDigest();
        return json(200, {
          version,
          path: "/download/token-widget.dmg",
          sha256: digest.sha256,
          size: digest.size,
        });
      }
      const available = path.match(/^\/api\/v1\/handle\/([^/]+)\/available$/);
      if (available) {
        const handle = decodeURIComponent(available[1]).toLowerCase();
        if (!isValidHandle(handle)) return json(200, { available: false, reason: "invalid" });
        return json(200, { available: await this.store.handleAvailable(handle) });
      }
      if (path === "/api/v1/leaderboard") {
        const rows = await this.store.leaderboard(100);
        return json(200, { rows, generatedAtMs: this.now() });
      }
      if (path === "/api/v1/me") {
        const token = readCookie(request.headers.cookie, BROWSER_SESSION_COOKIE);
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
          return json(401, { error: "browser is not paired" });
        }
        const viewer = await this.store.viewerForBrowserSession({
          sessionTokenHash: hashSecret(token),
          nowMs: this.now(),
        });
        if (!viewer) {
          return json(401, { error: "browser session expired" }, {
            "Set-Cookie": clearedSessionCookie(),
          });
        }
        return json(200, { viewer });
      }
      const profile = path.match(/^\/api\/v1\/profile\/([^/]+)$/);
      if (profile) {
        const handle = decodeURIComponent(profile[1]).replace(/^@/, "").toLowerCase();
        const profileValue = await this.store.profile(handle);
        if (!profileValue) return json(404, { error: "unknown handle" });
        return json(200, profileValue);
      }
      if (path === "/" || path === "/index.html") return page("index.html");
      if (path === "/install.sh") {
        try {
          return reply(200, "text/x-shellscript; charset=utf-8", readFileSync(join(this.webDir, "install.sh"), "utf8"));
        } catch {
          return json(404, { error: "not found" });
        }
      }
      if (path === "/leaderboard" || path === "/leaderboard.html") return page("leaderboard.html");
      if (path.startsWith("/u/")) return page("profile.html");
      if (path.startsWith("/assets/")) {
        const name = path.slice("/assets/".length).replace(/[^a-zA-Z0-9._-]/g, "");
        try {
          const type = name.endsWith(".png") ? "image/png" : name.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
          return reply(200, type, readFileSync(join(this.webDir, "assets", name)));
        } catch {
          return json(404, { error: "not found" });
        }
      }
      if (path === "/download/token-widget.dmg" || path === "/download/token-meter.dmg") {
        if (this.dmgFile && existsSync(this.dmgFile)) {
          return reply(200, "application/x-apple-diskimage", readFileSync(this.dmgFile), {
            "Content-Disposition": 'attachment; filename="TokenWidget.dmg"',
          });
        }
        return json(404, { error: "dmg not published" });
      }
      if (path === "/download" || path.startsWith("/download/")) {
        if (this.downloadFile && existsSync(this.downloadFile)) {
          return reply(200, "application/zip", readFileSync(this.downloadFile), {
            "Content-Disposition": 'attachment; filename="token-widget-macos.zip"',
          });
        }
        return json(404, { error: "package not published" });
      }
      return json(404, { error: "not found" });
    }

    if (request.method === "POST" && path === "/api/v1/browser-pairings") {
      let signed;
      try {
        signed = await readBody();
      } catch (error) {
        return json(400, { error: String(error.message) });
      }
      if (!verifySignedPayload(signed)) return json(401, { error: "invalid signature" });
      const payload = signed.payload;
      const nowMs = this.now();
      if (payload.kind !== "browser-pairing" || !timelySignedRequest(payload, nowMs)) {
        return json(422, { error: "invalid pairing request" });
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = randomBytes(24).toString("base64url");
        const expiresAtMs = nowMs + BROWSER_PAIRING_TTL_MS;
        const result = await this.store.createBrowserPairing({
          codeHash: hashSecret(code),
          meterId: payload.meterId,
          publicKey: payload.publicKey,
          nowMs,
          expiresAtMs,
        });
        if (result.created) return json(201, { code, expiresAtMs });
        if (result.reason === "identity-collision") {
          return json(409, { error: "identity collision" });
        }
      }
      return json(503, { error: "could not allocate pairing" });
    }

    if (request.method === "POST" && path === "/api/v1/browser-sessions") {
      if (!browserOriginAllowed(request.headers.origin)) {
        return json(403, { error: "untrusted browser origin" });
      }
      let body;
      try {
        body = await readBody();
      } catch (error) {
        return json(400, { error: String(error.message) });
      }
      if (typeof body.code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.code)) {
        return json(422, { error: "invalid pairing code" });
      }
      const nowMs = this.now();
      const sessionToken = randomBytes(32).toString("base64url");
      const sessionExpiresAtMs = nowMs + BROWSER_SESSION_TTL_MS;
      const result = await this.store.exchangeBrowserPairing({
        codeHash: hashSecret(body.code),
        sessionTokenHash: hashSecret(sessionToken),
        nowMs,
        sessionExpiresAtMs,
      });
      if (!result.exchanged) {
        return json(401, { error: "pairing code is invalid, expired, or already used" });
      }
      const viewer = await this.store.viewerForBrowserSession({
        sessionTokenHash: hashSecret(sessionToken),
        nowMs,
      });
      return json(200, { ok: true, viewer }, {
        "Set-Cookie": sessionCookie(sessionToken),
      });
    }

    if (request.method === "DELETE" && path === "/api/v1/browser-sessions/current") {
      if (!browserOriginAllowed(request.headers.origin)) {
        return json(403, { error: "untrusted browser origin" });
      }
      const token = readCookie(request.headers.cookie, BROWSER_SESSION_COOKIE);
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        await this.store.revokeBrowserSession(hashSecret(token));
      }
      return json(200, { ok: true }, { "Set-Cookie": clearedSessionCookie() });
    }

    if (request.method === "POST" && (path === "/api/v1/claim" || path === "/api/v1/report")) {
      let signed;
      try {
        signed = await readBody();
      } catch (error) {
        return json(400, { error: String(error.message) });
      }
      if (!verifySignedPayload(signed)) return json(401, { error: "invalid signature" });
      const payload = signed.payload;
      const meterId = payload.meterId;
      const nowMs = this.now();

      if (path === "/api/v1/claim") {
        if (
          payload.kind !== "claim" ||
          !isValidHandle(payload.handle ?? "") ||
          !timelySignedRequest(payload, nowMs)
        ) {
          return json(422, { error: "invalid claim" });
        }
        const handle = payload.handle.toLowerCase();
        const result = await this.store.claim({
          handle,
          meterId,
          publicKey: payload.publicKey,
          nowMs,
        });
        if (!result.claimed) {
          return json(409, { error: "handle already claimed", claimed: false });
        }
        return json(200, { ok: true, claimed: true, handle });
      }

      if (payload.kind !== "usage") return json(422, { error: "invalid report" });
      const usage = normalizeUsagePayload(payload, nowMs);
      if (!usage) return json(422, { error: "invalid report" });
      const result = await this.store.report({
        meterId,
        publicKey: payload.publicKey,
        handle: isValidHandle(payload.handle ?? "")
          ? payload.handle.toLowerCase()
          : null,
        ...usage,
        nowMs,
      });
      if (!result.accepted) {
        return json(409, { error: "identity collision" });
      }
      return json(200, { ok: true, ignored: result.ignored });
    }
    return json(405, { error: "method not allowed" });
  }

  async start(port = 0) {
    await this.store.init();
    this.server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        console.error("registry request failed", error);
        try {
          response.writeHead(500).end();
        } catch { /* closed */ }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, this.host, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    await this.store.close();
  }
}
