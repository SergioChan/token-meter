import { readFile, realpath } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MetricsEngine } from "../core/metrics-engine.mjs";
import { RolloutStore } from "../core/rollout-store.mjs";
import { CdpClient, isLoopbackWebSocketUrl } from "./cdp-client.mjs";
import { buildSessionProbeExpression } from "./session-probe.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "../..");
const runtimePath = path.join(projectRoot, "runtime", "token-meter-ui.js");
const stylesheetPath = path.join(projectRoot, "runtime", "token-meter-ui.css");
const execFileAsync = promisify(execFile);
const defaultCodexAppPath = "/Applications/ChatGPT.app";
const codexBundleId = "com.openai.codex";
const openAiTeamId = "2DC432GLL2";

export function verifyCodexBundleIdentity({ bundleId, teamId }) {
  if (bundleId !== codexBundleId || teamId !== openAiTeamId) {
    throw new Error("Refusing a Codex application with an unexpected signing identity");
  }
}

async function verifyMacApplicationBundle(appPath) {
  const expectedPath = path.resolve(appPath);
  const canonicalPath = await realpath(expectedPath).catch(() => null);
  if (canonicalPath !== expectedPath) {
    throw new Error("Refusing a missing or symlinked Codex application bundle");
  }

  const { stdout: bundleId } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(canonicalPath, "Contents", "Info.plist"),
  ]);
  await execFileAsync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    canonicalPath,
  ]);
  const { stderr: signature } = await execFileAsync("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    canonicalPath,
  ]);
  const teamId = String(signature).match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  verifyCodexBundleIdentity({ bundleId: bundleId.trim(), teamId });
  return canonicalPath;
}

async function loadPayload() {
  const [runtime, stylesheet] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(stylesheetPath, "utf8"),
  ]);
  if (!runtime.includes("__TOKEN_METER_CSS_JSON__")) {
    throw new Error("Token Meter runtime CSS placeholder is missing");
  }
  return runtime.replace("__TOKEN_METER_CSS_JSON__", JSON.stringify(stylesheet));
}

async function listTargets(cdpPort) {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`;
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    throw new Error(
      `Codex CDP is not available at ${endpoint}. Restart Codex with the Token Meter launcher before injecting.`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`Codex CDP returned HTTP ${response.status}`);
  const targets = await response.json();
  return targets.filter(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith("app://") &&
      !target.url.toLowerCase().includes("avatar-overlay") &&
      isLoopbackWebSocketUrl(target.webSocketDebuggerUrl),
  );
}

export function parseLsofListenerRecords(stdout) {
  const records = [];
  let current = null;
  const finish = () => {
    if (current != null) records.push(current);
  };

  for (const line of String(stdout).split("\n")) {
    if (line.startsWith("p")) {
      finish();
      current = { pid: line.slice(1), ppid: null, devices: [] };
    } else if (current != null && line.startsWith("R")) {
      current.ppid = line.slice(1);
    } else if (current != null && line.startsWith("d")) {
      current.devices.push(line.slice(1));
    }
  }
  finish();
  return records.filter((record) => /^\d+$/.test(record.pid));
}

export function verifyCodexListenerRecords(
  records,
  commandsByPid,
  { appPath = defaultCodexAppPath } = {},
) {
  if (records.length === 0) {
    throw new Error("No process owns the expected CDP listener");
  }

  const devices = new Set(records.flatMap((record) => record.devices));
  if (
    devices.size !== 1 ||
    records.some((record) => record.devices.length !== 1)
  ) {
    throw new Error("Expected one Codex CDP listening socket");
  }

  const applicationPath = path.resolve(appPath);
  const allowedExecutables = ["ChatGPT", "Codex"].map((name) =>
    path.join(applicationPath, "Contents", "MacOS", name),
  );
  const owners = records.filter((record) => {
    const command = String(commandsByPid.get(record.pid) ?? "").trim();
    return allowedExecutables.some(
      (executable) => command === executable || command.startsWith(`${executable} `),
    );
  });
  if (owners.length !== 1) {
    throw new Error(
      "Refusing a CDP listener that is not owned by the expected Codex application",
    );
  }

  const ownerPid = owners[0].pid;
  const recordsByPid = new Map(records.map((record) => [record.pid, record]));
  for (const record of records) {
    const visited = new Set();
    let current = record;
    while (current.pid !== ownerPid) {
      if (visited.has(current.pid) || current.ppid == null) {
        throw new Error("Refusing a CDP socket holder not in the Codex process tree");
      }
      visited.add(current.pid);
      current = recordsByPid.get(current.ppid);
      if (current == null) {
        throw new Error("Refusing a CDP socket holder not in the Codex process tree");
      }
    }
  }
  return ownerPid;
}

async function verifyMacListenerOwner(cdpPort, { appPath = defaultCodexAppPath } = {}) {
  if (process.platform !== "darwin") return;
  const verifiedAppPath = await verifyMacApplicationBundle(appPath);
  let stdout;
  try {
    ({ stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      "-FpdR",
      `-iTCP:${cdpPort}`,
      "-sTCP:LISTEN",
    ]));
  } catch {
    throw new Error(`No process owns the expected CDP listener on port ${cdpPort}`);
  }
  const records = parseLsofListenerRecords(stdout);
  const commands = await Promise.all(
    records.map(async ({ pid }) => {
      const { stdout: command } = await execFileAsync("/bin/ps", [
        "-p",
        pid,
        "-o",
        "command=",
      ]);
      return [pid, command];
    }),
  );
  verifyCodexListenerRecords(records, new Map(commands), {
    appPath: verifiedAppPath,
  });
}

export async function connectVerifiedCodexRenderer({
  cdpPort = 9334,
  appPath = process.env.CODEX_APP_PATH ?? defaultCodexAppPath,
} = {}) {
  await verifyMacListenerOwner(cdpPort, { appPath });
  const targets = await listTargets(cdpPort);
  for (const target of targets) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl).catch(() => null);
    if (client == null) continue;
    try {
      await client.call("Runtime.enable");
      const probe = await client.evaluate(buildSessionProbeExpression());
      if (probe?.eligible) return { client, target, probe };
    } catch {
      // Try the next validated app target.
    }
    client.close();
  }
  throw new Error("No verified Codex main renderer is available");
}

export async function attachCodexTarget(
  target,
  payload,
  { connect = CdpClient.connect } = {},
) {
  const client = await connect(target.webSocketDebuggerUrl);
  await client.call("Runtime.enable");
  const probe = await client.evaluate(buildSessionProbeExpression());
  if (!probe?.eligible) {
    client.close();
    return null;
  }
  await client.call("Page.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: payload });
  await client.evaluate(payload);
  return { id: target.id, client, probe };
}

export async function removeCodexMeter({
  cdpPort = 9334,
  appPath = process.env.CODEX_APP_PATH ?? defaultCodexAppPath,
} = {}) {
  try {
    await verifyMacListenerOwner(cdpPort, { appPath });
  } catch (error) {
    if (/No process owns/.test(error.message)) {
      return { cdpAvailable: false, removedTargets: 0 };
    }
    throw error;
  }
  const targets = await listTargets(cdpPort);
  let removedTargets = 0;
  for (const target of targets) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl).catch(() => null);
    if (client == null) continue;
    try {
      const probe = await client.evaluate(buildSessionProbeExpression());
      if (!probe?.eligible) continue;
      await client.evaluate("window.__tokenMeter?.destroy()");
      removedTargets += 1;
    } finally {
      client.close();
    }
  }
  return { cdpAvailable: true, removedTargets };
}

function updateExpression(snapshot) {
  return `window.__tokenMeter?.update(${JSON.stringify(snapshot)})`;
}

function waitForNextPoll(timeoutMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function runCodexInjector({
  sessionsDirectory,
  cdpPort = 9334,
  appPath = process.env.CODEX_APP_PATH ?? defaultCodexAppPath,
  pollIntervalMs = 1_000,
  targetDiscoveryIntervalMs = 5_000,
  historyFileLimit = 100,
  historyFilesPerPoll = 2,
  signal,
} = {}) {
  if (!sessionsDirectory) throw new TypeError("sessionsDirectory is required");
  const payload = await loadPayload();
  const store = new RolloutStore({ sessionsDirectory, historyFileLimit: 0 });
  const engine = new MetricsEngine();
  const attached = new Map();
  const sessionWatcher = (() => {
    try {
      const watcher = watch(
        sessionsDirectory,
        { recursive: true, persistent: false },
        () => store.markDiscoveryDirty(),
      );
      watcher.on("error", () => store.markDiscoveryDirty());
      return watcher;
    } catch {
      return null;
    }
  })();
  let lastDiscoveryMs = 0;
  let warmedHistoryFileLimit = 0;
  let stopping = false;
  let stopPromise = null;

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = Promise.allSettled(
      [...attached.values()].map(async ({ client }) => {
        await client.evaluate("window.__tokenMeter?.destroy()").catch(() => {});
        client.close();
      }),
    ).then(() => attached.clear());
    return stopPromise;
  };
  signal?.addEventListener("abort", () => void stop(), { once: true });

  try {
    await verifyMacListenerOwner(cdpPort, { appPath });
    let cdpVerified = true;
    let lastCdpErrorLoggedMs = 0;
    while (!stopping) {
      try {
        if (!cdpVerified) {
          await verifyMacListenerOwner(cdpPort, { appPath });
          cdpVerified = true;
          console.error(
            `[token-meter] CDP listener on port ${cdpPort} is available again; resuming.`,
          );
        }
        const nowMs = Date.now();
        if (nowMs - lastDiscoveryMs >= targetDiscoveryIntervalMs) {
          const targets = await listTargets(cdpPort);
          for (const target of targets) {
            if (attached.has(target.id)) continue;
            const connection = await attachCodexTarget(target, payload).catch(() => null);
            if (connection) attached.set(target.id, connection);
          }
          lastDiscoveryMs = nowMs;
        }
      } catch (error) {
        cdpVerified = false;
        for (const connection of attached.values()) connection.failed = true;
        const nowMs = Date.now();
        if (nowMs - lastCdpErrorLoggedMs >= 60_000) {
          lastCdpErrorLoggedMs = nowMs;
          console.error(
            `[token-meter] CDP temporarily unavailable (${error?.message ?? error}); retrying.`,
          );
        }
      }

      if (cdpVerified && !stopping) {
        const probes = [];
        for (const connection of attached.values()) {
          try {
            connection.probe = await connection.client.evaluate(
              buildSessionProbeExpression(),
            );
            probes.push(connection.probe);
          } catch {
            connection.failed = true;
          }
        }
        for (const [id, connection] of attached) {
          if (connection.failed || !connection.probe?.eligible) {
            connection.client.close();
            attached.delete(id);
          }
        }

        const activeThreadIds = probes.map((probe) => probe.threadId).filter(Boolean);
        store.historyFileLimit = warmedHistoryFileLimit;
        try {
          const files = await store.refresh({ activeThreadIds });
          for (const connection of attached.values()) {
            const snapshot = engine.snapshot(files, {
              threadId: connection.probe.threadId,
              nowMs: Date.now(),
            });
            snapshot.binding = {
              source: connection.probe.bindingSource,
              exact: Boolean(connection.probe.threadId),
            };
            await connection.client.evaluate(updateExpression(snapshot)).catch(() => {
              connection.failed = true;
            });
          }
        } catch (error) {
          const nowMs = Date.now();
          if (nowMs - lastCdpErrorLoggedMs >= 60_000) {
            lastCdpErrorLoggedMs = nowMs;
            console.error(
              `[token-meter] poll error (${error?.message ?? error}); continuing.`,
            );
          }
        }
        warmedHistoryFileLimit = Math.min(
          historyFileLimit,
          warmedHistoryFileLimit + historyFilesPerPoll,
        );
      }

      await waitForNextPoll(pollIntervalMs, signal);
    }
  } finally {
    sessionWatcher?.close();
    await stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runCodexInjector({
    sessionsDirectory: path.join(process.env.HOME, ".codex", "sessions"),
    signal: controller.signal,
  });
}
