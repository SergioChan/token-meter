import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { verifySignedPayload, isValidHandle } from "../src/core/identity.mjs";

const MAX_BODY_BYTES = 512 * 1024;

// Community registry: verified handle claims (first come, first served) and
// signed aggregate usage reports. Storage is a JSON file — plenty for an
// internal test fleet; swap for a real database with the real domain.
export class RegistryServer {
  constructor({ dataFile, webDir, downloadFile = null, dmgFile = null, latestVersion = null }) {
    if (!dataFile || !webDir) throw new TypeError("dataFile and webDir are required");
    this.dataFile = dataFile;
    this.webDir = webDir;
    this.downloadFile = downloadFile;
    this.dmgFile = dmgFile;
    this.latestVersion = latestVersion;
    this.dmgDigestMemo = null;
    this.server = null;
    this.port = null;
    try {
      this.data = JSON.parse(readFileSync(dataFile, "utf8"));
    } catch {
      this.data = { handles: {}, meters: {} };
    }
  }

  #save() {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    writeFileSync(this.dataFile, JSON.stringify(this.data), { mode: 0o600 });
  }

  #display(meterId) {
    const meter = this.data.meters[meterId];
    const handle = meter?.handle;
    return handle ? `@${handle}` : `${meterId.slice(0, 10)}…`;
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
    const json = (status, value) => reply(status, "application/json", JSON.stringify(value));
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
      if (path === "/api/v1/health") return json(200, { ok: true, meters: Object.keys(this.data.meters).length });
      if (path === "/api/v1/latest") {
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
        return json(200, { available: this.data.handles[handle] == null });
      }
      if (path === "/api/v1/leaderboard") {
        const rows = Object.entries(this.data.meters)
          .map(([meterId, meter]) => ({
            name: this.#display(meterId),
            handle: meter.handle ?? null,
            tokens: meter.weekTokens ?? 0,
            lifetimeTokens: meter.stats?.lifetimeTokens ?? 0,
            sessions: meter.stats?.sessionCount ?? 0,
            updatedAtMs: meter.updatedAtMs,
          }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 100);
        return json(200, { rows, generatedAtMs: Date.now() });
      }
      const profile = path.match(/^\/api\/v1\/profile\/([^/]+)$/);
      if (profile) {
        const handle = decodeURIComponent(profile[1]).replace(/^@/, "").toLowerCase();
        const meterId = this.data.handles[handle]?.meterId;
        const meter = meterId ? this.data.meters[meterId] : null;
        if (!meter) return json(404, { error: "unknown handle" });
        return json(200, { handle, days: meter.days ?? [], stats: meter.stats ?? {}, weekTokens: meter.weekTokens ?? 0, updatedAtMs: meter.updatedAtMs });
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

      if (path === "/api/v1/claim") {
        if (payload.kind !== "claim" || !isValidHandle(payload.handle ?? "")) {
          return json(422, { error: "invalid claim" });
        }
        const handle = payload.handle.toLowerCase();
        const existing = this.data.handles[handle];
        if (existing && existing.meterId !== meterId) {
          return json(409, { error: "handle already claimed", claimed: false });
        }
        this.data.handles[handle] = existing ?? { meterId, publicKey: payload.publicKey, claimedAtMs: Date.now() };
        const meter = (this.data.meters[meterId] ??= {});
        meter.handle = handle;
        meter.publicKey = payload.publicKey;
        meter.updatedAtMs = Date.now();
        this.#save();
        return json(200, { ok: true, claimed: true, handle });
      }

      if (payload.kind !== "usage") return json(422, { error: "invalid report" });
      const meter = (this.data.meters[meterId] ??= {});
      meter.publicKey = payload.publicKey;
      meter.days = Array.isArray(payload.days) ? payload.days.slice(-120) : [];
      meter.stats = payload.stats ?? {};
      meter.weekTokens = payload.weekTokens ?? 0;
      if (payload.handle && this.data.handles[payload.handle.toLowerCase()]?.meterId === meterId) {
        meter.handle = payload.handle.toLowerCase();
      }
      meter.updatedAtMs = Date.now();
      this.#save();
      return json(200, { ok: true });
    }
    return json(405, { error: "method not allowed" });
  }

  async start(port = 0) {
    this.server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        try {
          response.writeHead(500).end();
        } catch { /* closed */ }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
