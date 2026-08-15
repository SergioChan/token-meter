import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DashboardServer } from "../../../src/core/dashboard-server.mjs";
import {
  loadOrCreateIdentity,
  setSharingEnabled,
} from "../../../src/core/identity.mjs";
import { runCommunitySyncWorker } from "../../../src/core/community-sync.mjs";
import {
  createLeaderboardUrl,
  registryEnabled,
} from "../../../src/core/registry-client.mjs";
import { UsageHistory } from "../../../src/core/usage-history.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebDir = path.resolve(moduleDirectory, "../../../web");
const startupSyncDelayMs = 15_000;
const communitySyncIntervalMs = 3_600_000;

function validDashboardUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/" &&
      /^[a-f0-9]{32}$/.test(url.searchParams.get("token") ?? "") &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validLeaderboardUrl(value) {
  try {
    const url = new URL(value);
    const pairing = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair") ?? "";
    return (
      url.protocol === "https:" &&
      url.hostname === "www.tokenwidget.app" &&
      url.pathname === "/leaderboard" &&
      url.search === "" &&
      /^[A-Za-z0-9_-]{32}$/.test(pairing)
    );
  } catch {
    return false;
  }
}

async function openExternal(url) {
  await execFileAsync("/usr/bin/open", [url]);
}

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with ${code}`));
    });
    child.stdin.end(text);
  });
}

export class CodexWidgetActions {
  constructor({
    webDir = defaultWebDir,
    usageHistory = new UsageHistory(),
    identityLoader = loadOrCreateIdentity,
    sharingSetter = setSharingEnabled,
    leaderboardUrlFactory = createLeaderboardUrl,
    dashboardFactory = (options) => new DashboardServer(options),
    opener = openExternal,
    clipboardWriter = copyToClipboard,
    registryChecker = registryEnabled,
    communitySyncRunner = runCommunitySyncWorker,
    timeoutScheduler = setTimeout,
    intervalScheduler = setInterval,
    timeoutClearer = clearTimeout,
    intervalClearer = clearInterval,
    logger = (message) => process.stderr.write(`${message}\n`),
    now = Date.now,
  } = {}) {
    this.webDir = webDir;
    this.usageHistory = usageHistory;
    this.identityLoader = identityLoader;
    this.sharingSetter = sharingSetter;
    this.leaderboardUrlFactory = leaderboardUrlFactory;
    this.dashboardFactory = dashboardFactory;
    this.opener = opener;
    this.clipboardWriter = clipboardWriter;
    this.registryChecker = registryChecker;
    this.communitySyncRunner = communitySyncRunner;
    this.timeoutScheduler = timeoutScheduler;
    this.intervalScheduler = intervalScheduler;
    this.timeoutClearer = timeoutClearer;
    this.intervalClearer = intervalClearer;
    this.logger = logger;
    this.now = now;
    this.dashboardServer = null;
    this.identityMemo = null;
    this.usageMemo = null;
    this.communitySyncPromise = null;
    this.startupSyncTimer = null;
    this.communitySyncTimer = null;
  }

  start() {
    if (this.startupSyncTimer != null || this.communitySyncTimer != null) return;
    this.startupSyncTimer = this.timeoutScheduler(() => {
      this.startupSyncTimer = null;
      return this.syncCommunity("startup");
    }, startupSyncDelayMs);
    this.startupSyncTimer?.unref?.();
    this.communitySyncTimer = this.intervalScheduler(() => {
      return this.syncCommunity("interval");
    }, communitySyncIntervalMs);
    this.communitySyncTimer?.unref?.();
  }

  async syncCommunity(reason) {
    if (!this.registryChecker()) return null;
    const identity = this.#identity();
    if (identity.sharing?.enabled !== true) return null;
    if (this.communitySyncPromise != null) return this.communitySyncPromise;
    this.communitySyncPromise = this.communitySyncRunner(reason)
      .then((result) => {
        this.logger(`community sync ok (${reason})`);
        return result;
      })
      .catch((error) => {
        this.logger(`community sync failed (${reason}): ${error.message}`);
        return null;
      })
      .finally(() => {
        this.communitySyncPromise = null;
      });
    return this.communitySyncPromise;
  }

  #identity() {
    const nowMs = this.now();
    if (this.identityMemo == null || nowMs - this.identityMemo.atMs > 5_000) {
      this.identityMemo = { atMs: nowMs, value: this.identityLoader() };
    }
    return this.identityMemo.value;
  }

  #usageStats() {
    const nowMs = this.now();
    if (this.usageMemo == null || nowMs - this.usageMemo.atMs > 300_000) {
      const stats = this.usageHistory.collectCached().stats;
      this.usageMemo = {
        atMs: nowMs,
        value: {
          lifetimeTokens: stats.lifetimeTokens,
          currentStreakDays: stats.currentStreakDays,
        },
      };
    }
    return this.usageMemo.value;
  }

  decorateSnapshot(snapshot) {
    const identity = this.#identity();
    snapshot.meterId = identity.meterId;
    snapshot.meterHandle = identity.handle ?? null;
    snapshot.sharingEnabled = identity.sharing?.enabled === true;
    snapshot.meterStats = this.#usageStats();
    return snapshot;
  }

  async #dashboardUrl() {
    if (this.dashboardServer == null) {
      this.dashboardServer = this.dashboardFactory({
        webDir: this.webDir,
        usageHistory: { collect: () => this.usageHistory.collectCached() },
      });
      await this.dashboardServer.start();
    }
    const url = this.dashboardServer.url();
    if (!validDashboardUrl(url)) throw new Error("dashboard returned an unsafe URL");
    return url;
  }

  async handle(action) {
    if (action == null || typeof action !== "object") return false;
    if (action.type === "open-dashboard") {
      await this.opener(await this.#dashboardUrl());
      return true;
    }
    if (action.type === "open-leaderboard") {
      void this.syncCommunity("leaderboard");
      const url = await this.leaderboardUrlFactory(this.#identity());
      if (!validLeaderboardUrl(url)) throw new Error("registry returned an unsafe URL");
      await this.opener(url);
      return true;
    }
    if (action.type === "set-sharing") {
      if (typeof action.enabled !== "boolean") {
        throw new TypeError("sharing state must be a boolean");
      }
      const identity = this.sharingSetter(action.enabled);
      this.identityMemo = { atMs: this.now(), value: identity };
      if (identity.sharing.enabled) void this.syncCommunity("consent");
      return true;
    }
    if (action.type === "copy-text") {
      if (typeof action.text !== "string" || action.text.length > 500) {
        throw new TypeError("clipboard text is invalid");
      }
      await this.clipboardWriter(action.text);
      return true;
    }
    return false;
  }

  async stop() {
    if (this.startupSyncTimer != null) {
      this.timeoutClearer(this.startupSyncTimer);
      this.startupSyncTimer = null;
    }
    if (this.communitySyncTimer != null) {
      this.intervalClearer(this.communitySyncTimer);
      this.communitySyncTimer = null;
    }
    if (this.dashboardServer != null) {
      const server = this.dashboardServer;
      this.dashboardServer = null;
      await server.stop();
    }
  }
}
