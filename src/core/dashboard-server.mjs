import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultIdentityDir,
  isValidHandle,
  loadOrCreateIdentity,
  setHandle,
  setSharingEnabled,
} from "./identity.mjs";
import { UsageHistory } from "./usage-history.mjs";
import { registryEnabled, claimHandle } from "./registry-client.mjs";

const MAX_BODY_BYTES = 4096;
const USAGE_TTL_MS = 60_000;

// Loopback-only profile and handle-claim server for the dashboard page.
// Every request must carry the per-instance nonce; the browser page reads it
// from its own URL. Handles are reserved locally until a public registry
// exists to make first-come-first-serve claims global.
export class DashboardServer {
  constructor({ webDir, identityDir = defaultIdentityDir(), usageHistory = null }) {
    if (!webDir) throw new TypeError("webDir is required");
    this.webDir = webDir;
    this.identityDir = identityDir;
    this.usageHistory = usageHistory ?? new UsageHistory();
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
    if (request.method === "GET" && requestUrl.pathname === "/api/profile") {
      return replyJson(200, this.#publicIdentity());
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
      setSharingEnabled(enabled, this.identityDir);
      return replyJson(200, this.#publicIdentity());
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

  url() {
    if (this.port == null) throw new Error("server is not started");
    return `http://127.0.0.1:${this.port}/?token=${this.nonce}`;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
  }
}
