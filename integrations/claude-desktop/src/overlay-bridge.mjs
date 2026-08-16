#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ClaudeSnapshotRuntime } from "./snapshot-runtime.mjs";
import { CodexSnapshotRuntime } from "../../codex-desktop/src/snapshot-runtime.mjs";

// The Codex host path reads state_5.sqlite through node:sqlite, whose
// experimental warning would otherwise repeat into the LaunchAgent log on
// every process start. Replace Node's default warning printer with one that
// drops only that warning and prints everything else unchanged.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
    return;
  }
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
import { runCommunitySyncWorker } from "../../../src/core/community-sync.mjs";
import {
  loadOrCreateIdentity,
  markHandlePrompted,
  setSharingEnabled,
} from "../../../src/core/identity.mjs";
import { DashboardServer } from "../../../src/core/dashboard-server.mjs";
import { readFileSync } from "node:fs";
import {
  registryEnabled,
  createLeaderboardUrl,
  fetchLatestRelease,
  isNewerVersion,
} from "../../../src/core/registry-client.mjs";
import { registryBase } from "../../../src/core/registry-config.mjs";
import { UsageHistory } from "../../../src/core/usage-history.mjs";

let communitySyncPromise = null;

// Community aggregation runs outside the snapshot event loop, so a first
// scan of multi-gigabyte histories cannot freeze the live meter.
async function syncCommunity(reason) {
  if (!registryEnabled()) return;
  const identity = loadOrCreateIdentity();
  if (identity.sharing?.enabled !== true) return;
  if (communitySyncPromise) return communitySyncPromise;
  communitySyncPromise = runCommunitySyncWorker(reason)
    .then(() => process.stderr.write(`community sync ok (${reason})\n`))
    .catch((error) => {
      process.stderr.write(`community sync failed (${reason}): ${error.message}\n`);
    })
    .finally(() => {
      communitySyncPromise = null;
    });
  return communitySyncPromise;
}
setTimeout(() => syncCommunity("startup"), 15_000).unref();
setInterval(() => syncCommunity("interval"), 3_600_000).unref();

// Update check: compare the installed payload version against the registry's
// latest release. Metadata only — carries no identity and ignores the
// sharing opt-in. A result is remembered and attached to every snapshot.
const installedVersion = (() => {
  try {
    const packagePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json",
    );
    return JSON.parse(readFileSync(packagePath, "utf8")).version ?? null;
  } catch {
    return null;
  }
})();
let updateInfo = null;
async function checkForUpdate(reason) {
  const fakeVersion = process.env.TOKEN_METER_FAKE_UPDATE;
  if (fakeVersion) {
    updateInfo = { version: fakeVersion, url: `${registryBase() ?? ""}/download/token-widget.dmg` };
    return;
  }
  if (!registryEnabled() || installedVersion == null) return;
  try {
    const latest = await fetchLatestRelease();
    if (isNewerVersion(latest.version, installedVersion)) {
      updateInfo = {
        version: latest.version,
        url: `${registryBase()}${latest.path}`,
        sha256: latest.sha256 ?? null,
      };
      process.stderr.write(`update available (${reason}): ${installedVersion} -> ${latest.version}\n`);
    } else {
      updateInfo = null;
    }
  } catch (error) {
    process.stderr.write(`update check failed (${reason}): ${error.message}\n`);
  }
}
setTimeout(() => checkForUpdate("startup"), 20_000).unref();
setInterval(() => checkForUpdate("interval"), 3_600_000).unref();

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--sessions-dir") options.sessionsDirectory = argv[++index];
    else if (value === "--projects-dir") options.projectsDirectory = argv[++index];
    else if (value === "--codex-sessions-dir") options.codexSessionsDirectory = argv[++index];
    else if (value === "--codex-state-db") options.codexStateDatabase = argv[++index];
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return `Usage: overlay-bridge.mjs [--sessions-dir PATH] [--projects-dir PATH]\n\n` +
    `Read newline-delimited snapshot requests from stdin and write one numerical ` +
    `snapshot response per line.\n`;
}

async function writeLine(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
    await once(process.stdout, "drain");
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const cachedUsageHistory = new UsageHistory();

// Aggregate face for the always-on desktop widget and non-Claude hosts: no
// session binding, just machine-wide totals from the usage-history cache.
// Memoized because the native layer polls it on a steady cadence.
let globalSnapshotMemo = null;
function globalSnapshot() {
  const nowMs = Date.now();
  if (globalSnapshotMemo && nowMs - globalSnapshotMemo.atMs < 60_000) {
    return globalSnapshotMemo.value;
  }
  let identity = null;
  try {
    identity = loadOrCreateIdentity();
  } catch {
    identity = null;
  }
  let meterStats = null;
  let todayTokens = null;
  try {
    const collected = cachedUsageHistory.collectCached();
    meterStats = {
      lifetimeTokens: collected.stats.lifetimeTokens,
      currentStreakDays: collected.stats.currentStreakDays,
    };
    const today = new Date(nowMs);
    const todayKey = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    todayTokens = collected.days.find((day) => day.date === todayKey)?.total ?? 0;
  } catch {
    meterStats = null;
    todayTokens = null;
  }
  const value = {
    status: "global",
    binding: { exact: false },
    meterId: identity?.meterId ?? null,
    meterHandle: identity?.handle ?? null,
    sharingEnabled: identity?.sharing?.enabled ?? false,
    handlePrompted: identity?.handlePromptedAtMs != null,
    meterStats,
    todayTokens,
  };
  globalSnapshotMemo = { atMs: nowMs, value };
  return value;
}
const runtime = new ClaudeSnapshotRuntime({
  sessionsDirectory:
    options.sessionsDirectory ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
    ),
  projectsDirectory:
    options.projectsDirectory ?? path.join(os.homedir(), ".claude", "projects"),
  usageHistory: { collect: () => cachedUsageHistory.collectCached() },
});

// The same overlay serves Codex windows. Constructed lazily so a Claude-only
// session never opens the Codex state database or scans ~/.codex.
let codexRuntime = null;
function ensureCodexRuntime() {
  if (codexRuntime == null) {
    codexRuntime = new CodexSnapshotRuntime({
      sessionsDirectory: options.codexSessionsDirectory,
      stateDatabasePath: options.codexStateDatabase,
      usageHistory: { collect: () => cachedUsageHistory.collectCached() },
    });
  }
  return codexRuntime;
}
let dashboardServer = null;
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
  terminal: false,
});

for await (const line of input) {
  if (line.trim().length === 0) continue;
  let requestId = null;
  try {
    const request = JSON.parse(line);
    requestId = request?.requestId ?? null;
    if (request?.command === "dashboard-url") {
      if (dashboardServer == null) {
        dashboardServer = new DashboardServer({
          webDir: path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "..",
            "..",
            "..",
            "web",
          ),
        });
        await dashboardServer.start();
      }
      const view = request.view === "share" || request.view === "withdraw" ? request.view : null;
      await writeLine({ requestId, ok: true, url: dashboardServer.url(view) });
      continue;
    }
    if (request?.command === "dismiss-handle-prompt") {
      const identity = markHandlePrompted();
      runtime.identityMemo = { atMs: Date.now(), value: identity };
      await writeLine({ requestId, ok: true });
      continue;
    }
    if (request?.command === "leaderboard-url") {
      const identity = loadOrCreateIdentity();
      if (identity.sharing?.enabled === true) void syncCommunity("leaderboard");
      const url = await createLeaderboardUrl(identity);
      await writeLine({ requestId, ok: true, url });
      continue;
    }
    if (request?.command === "set-sharing") {
      const identity = setSharingEnabled(Boolean(request.enabled));
      runtime.identityMemo = { atMs: Date.now(), value: identity };
      await writeLine({
        requestId,
        ok: true,
        sharingEnabled: identity.sharing.enabled,
      });
      if (identity.sharing.enabled) void syncCommunity("consent");
      continue;
    }
    if (request?.command === "global-snapshot") {
      const snapshot = { ...globalSnapshot() };
      snapshot.appVersion = installedVersion;
      if (updateInfo) snapshot.updateInfo = { version: updateInfo.version };
      await writeLine({ requestId, snapshot });
      continue;
    }
    if (request?.command === "codex-snapshot") {
      const snapshot = await ensureCodexRuntime().snapshot();
      snapshot.appVersion = installedVersion;
      if (updateInfo) snapshot.updateInfo = { version: updateInfo.version };
      await writeLine({ requestId, snapshot });
      continue;
    }
    if (request?.command === "update-info") {
      await writeLine(
        updateInfo
          ? {
            requestId,
            ok: true,
            version: updateInfo.version,
            url: updateInfo.url,
            // The installer refuses to swap the bundle without this digest.
            sha256: updateInfo.sha256 ?? null,
          }
          : { requestId, ok: false },
      );
      continue;
    }
    if (typeof request?.command === "string") {
      throw new TypeError(`unknown command: ${request.command}`);
    }
    if (typeof request?.desktopSessionId !== "string") {
      throw new TypeError("desktopSessionId must be a string");
    }
    const snapshot = await runtime.snapshot(request.desktopSessionId);
    snapshot.appVersion = installedVersion;
    if (updateInfo) snapshot.updateInfo = { version: updateInfo.version };
    await writeLine({ requestId, snapshot });
  } catch (error) {
    await writeLine({
      requestId,
      error: {
        code: "snapshot-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
