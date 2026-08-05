import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MetricsEngine } from "../core/metrics-engine.mjs";
import { CdpClient, isLoopbackWebSocketUrl } from "../codex/cdp-client.mjs";
import {
  DEFAULT_CLAUDE_APP_PATH,
  verifyClaudeApplicationBundle,
} from "./app-verifier.mjs";
import { ClaudeDesktopSessionStore } from "./desktop-session-store.mjs";
import { buildClaudeSessionProbeExpression } from "./session-probe.mjs";
import { ClaudeTranscriptStore } from "./transcript-store.mjs";

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

export function isPotentialClaudePageTarget(target) {
  if (
    target?.type !== "page" ||
    typeof target.url !== "string" ||
    !isLoopbackWebSocketUrl(target.webSocketDebuggerUrl)
  ) {
    return false;
  }
  try {
    const url = new URL(target.url);
    if (url.protocol === "file:" || url.protocol === "app:") return true;
    return (
      url.protocol === "https:" &&
      (url.hostname === "claude.ai" || url.hostname === "claude.com")
    );
  } catch {
    return false;
  }
}

async function listTargets(cdpPort) {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`;
  let response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    throw new Error(
      `Claude CDP is not available at ${endpoint}. Production Claude Desktop rejects remote-debugging flags unless the process has a valid Anthropic-signed CLAUDE_CDP_AUTH token bound to CLAUDE_USER_DATA_DIR.`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`Claude CDP returned HTTP ${response.status}`);
  const targets = await response.json();
  return targets.filter(isPotentialClaudePageTarget);
}

export function parseClaudeLsofListenerRecords(stdout) {
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

export function verifyClaudeListenerRecords(
  records,
  commandsByPid,
  { executablePath = path.join(DEFAULT_CLAUDE_APP_PATH, "Contents", "MacOS", "Claude") } = {},
) {
  if (records.length === 0) {
    throw new Error("No process owns the expected Claude CDP listener");
  }
  const devices = new Set(records.flatMap((record) => record.devices));
  if (devices.size !== 1 || records.some((record) => record.devices.length !== 1)) {
    throw new Error("Expected one Claude CDP listening socket");
  }

  const expectedExecutable = path.resolve(executablePath);
  const owners = records.filter((record) => {
    const command = String(commandsByPid.get(record.pid) ?? "").trim();
    return (
      command === expectedExecutable || command.startsWith(`${expectedExecutable} `)
    );
  });
  if (owners.length !== 1) {
    throw new Error(
      "Refusing a CDP listener that is not owned by the expected Claude application",
    );
  }

  const ownerPid = owners[0].pid;
  const recordsByPid = new Map(records.map((record) => [record.pid, record]));
  for (const record of records) {
    const visited = new Set();
    let current = record;
    while (current.pid !== ownerPid) {
      if (visited.has(current.pid) || current.ppid == null) {
        throw new Error("Refusing a CDP socket holder not in the Claude process tree");
      }
      visited.add(current.pid);
      current = recordsByPid.get(current.ppid);
      if (current == null) {
        throw new Error("Refusing a CDP socket holder not in the Claude process tree");
      }
    }
  }
  return ownerPid;
}

async function verifyMacListenerOwner(
  cdpPort,
  { appPath = DEFAULT_CLAUDE_APP_PATH } = {},
) {
  if (process.platform !== "darwin") return;
  const verified = await verifyClaudeApplicationBundle(appPath);
  let stdout;
  try {
    ({ stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      "-FpdR",
      `-iTCP:${cdpPort}`,
      "-sTCP:LISTEN",
    ]));
  } catch {
    throw new Error(`No process owns the expected Claude CDP listener on port ${cdpPort}`);
  }
  const records = parseClaudeLsofListenerRecords(stdout);
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
  verifyClaudeListenerRecords(records, new Map(commands), {
    executablePath: verified.executablePath,
  });
}

export async function attachClaudeTarget(
  target,
  payload,
  { connect = CdpClient.connect } = {},
) {
  const client = await connect(target.webSocketDebuggerUrl);
  await client.call("Runtime.enable");
  const probe = await client.evaluate(buildClaudeSessionProbeExpression());
  if (!probe?.eligible) {
    client.close();
    return null;
  }
  await client.call("Page.enable");
  await client.call("Page.addScriptToEvaluateOnNewDocument", { source: payload });
  await client.evaluate(payload);
  return { id: target.id, client, probe };
}

export async function removeClaudeMeter({
  cdpPort = 9335,
  appPath = process.env.CLAUDE_APP_PATH ?? DEFAULT_CLAUDE_APP_PATH,
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
      const probe = await client.evaluate(buildClaudeSessionProbeExpression());
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

function createWatcher(directory, callback) {
  try {
    const watcher = watch(directory, { recursive: true, persistent: false }, callback);
    watcher.on("error", callback);
    return watcher;
  } catch {
    return null;
  }
}

export async function runClaudeInjector({
  sessionsDirectory,
  projectsDirectory,
  cdpPort = 9335,
  appPath = process.env.CLAUDE_APP_PATH ?? DEFAULT_CLAUDE_APP_PATH,
  pollIntervalMs = 1_000,
  targetDiscoveryIntervalMs = 5_000,
  sessionCacheLimit = 4,
  signal,
} = {}) {
  if (!sessionsDirectory) throw new TypeError("sessionsDirectory is required");
  if (!projectsDirectory) throw new TypeError("projectsDirectory is required");

  const payload = await loadPayload();
  const engine = new MetricsEngine();
  const sessionStore = new ClaudeDesktopSessionStore({ sessionsDirectory });
  const transcriptStores = new Map();
  const attached = new Map();
  const metadataWatcher = createWatcher(sessionsDirectory, () =>
    sessionStore.markDiscoveryDirty(),
  );
  const transcriptWatcher = createWatcher(projectsDirectory, () => {
    for (const store of transcriptStores.values()) store.markDiscoveryDirty();
  });
  let lastTargetDiscoveryMs = 0;
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
    while (!stopping) {
      const nowMs = Date.now();
      if (nowMs - lastTargetDiscoveryMs >= targetDiscoveryIntervalMs) {
        const targets = await listTargets(cdpPort);
        for (const target of targets) {
          if (attached.has(target.id)) continue;
          const connection = await attachClaudeTarget(target, payload).catch(() => null);
          if (connection) attached.set(target.id, connection);
        }
        lastTargetDiscoveryMs = nowMs;
      }

      for (const connection of attached.values()) {
        try {
          connection.probe = await connection.client.evaluate(
            buildClaudeSessionProbeExpression(),
          );
          if (!connection.probe?.eligible) connection.failed = true;
        } catch {
          connection.failed = true;
        }
      }
      for (const [id, connection] of attached) {
        if (!connection.failed) continue;
        connection.client.close();
        attached.delete(id);
      }

      for (const connection of attached.values()) {
        const desktopSessionId = connection.probe.desktopSessionId;
        const session = await sessionStore.resolve(desktopSessionId);
        let snapshot;
        if (session.status !== "resolved") {
          snapshot = new MetricsEngine().snapshot([], {
            threadId: desktopSessionId,
            nowMs,
            hostName: "Claude Desktop",
          });
          snapshot.reason = session.reason;
        } else {
          let transcriptStore = transcriptStores.get(desktopSessionId);
          if (transcriptStore == null) {
            transcriptStore = new ClaudeTranscriptStore({ projectsDirectory });
          }
          transcriptStores.delete(desktopSessionId);
          transcriptStores.set(desktopSessionId, transcriptStore);
          const files = await transcriptStore.refresh({ session });
          snapshot = engine.snapshot(files, {
            threadId: desktopSessionId,
            nowMs,
            hostName: "Claude Desktop",
          });
        }
        snapshot.binding = {
          source: connection.probe.bindingSource,
          exact: snapshot.status === "bound",
          desktopSessionId,
        };
        snapshot.usageMethod = "claude-transcript-raw";
        await connection.client.evaluate(updateExpression(snapshot)).catch(() => {
          connection.failed = true;
        });
      }

      const activeSessionIds = new Set(
        [...attached.values()]
          .map((connection) => connection.probe.desktopSessionId)
          .filter(Boolean),
      );
      for (const sessionId of transcriptStores.keys()) {
        if (transcriptStores.size <= sessionCacheLimit) break;
        if (!activeSessionIds.has(sessionId)) transcriptStores.delete(sessionId);
      }

      await waitForNextPoll(pollIntervalMs, signal);
    }
  } finally {
    metadataWatcher?.close();
    transcriptWatcher?.close();
    await stop();
  }
}
