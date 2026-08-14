#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ClaudeSnapshotRuntime } from "./snapshot-runtime.mjs";
import { setSharingEnabled, loadOrCreateIdentity } from "../../../src/core/identity.mjs";
import { DashboardServer } from "../../../src/core/dashboard-server.mjs";
import { readFileSync } from "node:fs";
import {
  registryEnabled,
  uploadUsage,
  claimHandle,
  fetchLatestRelease,
  isNewerVersion,
} from "../../../src/core/registry-client.mjs";
import { registryBase } from "../../../src/core/registry-config.mjs";

// Fire-and-forget community sync: only when the user has opted in, and only
// signed aggregates. Failures are logged and never disturb the meter.
async function syncCommunity(reason) {
  if (!registryEnabled()) return;
  try {
    const identity = loadOrCreateIdentity();
    if (identity.sharing?.enabled !== true) return;
    if (identity.handle && !identity.handleClaimed) {
      await claimHandle(identity).catch(() => {});
    }
    await uploadUsage(identity);
    process.stderr.write(`community sync ok (${reason})\n`);
  } catch (error) {
    process.stderr.write(`community sync failed (${reason}): ${error.message}\n`);
  }
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
});
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
      await writeLine({ requestId, ok: true, url: dashboardServer.url() });
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
    if (request?.command === "update-info") {
      await writeLine(
        updateInfo
          ? { requestId, ok: true, version: updateInfo.version, url: updateInfo.url }
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
