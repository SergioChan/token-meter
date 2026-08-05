import { readFile } from "node:fs/promises";
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

async function verifyMacListenerOwner(cdpPort) {
  if (process.platform !== "darwin") return;
  let stdout;
  try {
    ({ stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      "-Fp",
      `-iTCP:${cdpPort}`,
      "-sTCP:LISTEN",
    ]));
  } catch {
    throw new Error(`No process owns the expected CDP listener on port ${cdpPort}`);
  }
  const pids = [...String(stdout).matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
  if (pids.length !== 1) {
    throw new Error(`Expected one Codex CDP listener on port ${cdpPort}`);
  }
  const { stdout: command } = await execFileAsync("/bin/ps", [
    "-p",
    pids[0],
    "-o",
    "command=",
  ]);
  if (!/\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/.test(command)) {
    throw new Error("Refusing a CDP listener that is not owned by the Codex application");
  }
}

async function attachTarget(target, payload) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: payload });
  const probe = await client.evaluate(buildSessionProbeExpression());
  if (!probe?.eligible) {
    client.close();
    return null;
  }
  await client.evaluate(payload);
  return { id: target.id, client, probe };
}

export async function removeCodexMeter({ cdpPort = 9334 } = {}) {
  try {
    await verifyMacListenerOwner(cdpPort);
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
    await verifyMacListenerOwner(cdpPort);
    while (!stopping) {
      const nowMs = Date.now();
      if (nowMs - lastDiscoveryMs >= targetDiscoveryIntervalMs) {
        const targets = await listTargets(cdpPort);
        for (const target of targets) {
          if (attached.has(target.id)) continue;
          const connection = await attachTarget(target, payload).catch(() => null);
          if (connection) attached.set(target.id, connection);
        }
        lastDiscoveryMs = nowMs;
      }

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
      const files = await store.refresh({ activeThreadIds });
      for (const connection of attached.values()) {
        const snapshot = engine.snapshot(files, {
          threadId: connection.probe.threadId,
          nowMs,
        });
        snapshot.binding = {
          source: connection.probe.bindingSource,
          exact: Boolean(connection.probe.threadId),
        };
        await connection.client.evaluate(updateExpression(snapshot)).catch(() => {
          connection.failed = true;
        });
      }
      warmedHistoryFileLimit = Math.min(
        historyFileLimit,
        warmedHistoryFileLimit + historyFilesPerPoll,
      );

      await waitForNextPoll(pollIntervalMs, signal);
    }
  } finally {
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
