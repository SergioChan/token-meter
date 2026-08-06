#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetricsEngine } from "./core/metrics-engine.mjs";
import { RolloutStore } from "./core/rollout-store.mjs";

function parseArguments(argv) {
  const [command = "snapshot", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--thread-id") options.threadId = rest[++index];
    else if (value === "--sessions-dir") options.sessionsDirectory = rest[++index];
    else if (value === "--desktop-session-id") {
      options.desktopSessionId = rest[++index];
    } else if (value === "--claude-sessions-dir") {
      options.claudeSessionsDirectory = rest[++index];
    } else if (value === "--claude-projects-dir") {
      options.claudeProjectsDirectory = rest[++index];
    } else if (value === "--cdp-port") {
      options.cdpPort = Number(rest[++index]);
    }
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const sessionsDirectory =
  options.sessionsDirectory ?? path.join(os.homedir(), ".codex", "sessions");

if (options.command === "snapshot") {
  const store = new RolloutStore({ sessionsDirectory });
  const files = await store.refresh({
    activeThreadIds: options.threadId ? [options.threadId] : [],
  });
  const snapshot = new MetricsEngine().snapshot(files, {
    threadId: options.threadId ?? null,
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (options.command === "claude-snapshot") {
  if (!options.desktopSessionId) {
    throw new Error("--desktop-session-id is required for claude-snapshot");
  }
  const { ClaudeSnapshotRuntime } = await import(
    "../integrations/claude-desktop/src/snapshot-runtime.mjs"
  );
  const claudeSessionsDirectory =
    options.claudeSessionsDirectory ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
    );
  const claudeProjectsDirectory =
    options.claudeProjectsDirectory ??
    path.join(os.homedir(), ".claude", "projects");
  const runtime = new ClaudeSnapshotRuntime({
    sessionsDirectory: claudeSessionsDirectory,
    projectsDirectory: claudeProjectsDirectory,
  });
  const snapshot = await runtime.snapshot(options.desktopSessionId);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (options.command === "inject") {
  const modulePath = new URL(
    "../integrations/codex-desktop/src/injector.mjs",
    import.meta.url,
  );
  const { runCodexInjector } = await import(modulePath);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runCodexInjector({
    sessionsDirectory,
    cdpPort: options.cdpPort || 9334,
    signal: controller.signal,
  });
} else if (options.command === "remove") {
  const modulePath = new URL(
    "../integrations/codex-desktop/src/injector.mjs",
    import.meta.url,
  );
  const { removeCodexMeter } = await import(modulePath);
  const result = await removeCodexMeter({ cdpPort: options.cdpPort || 9334 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const script = fileURLToPath(import.meta.url);
  throw new Error(
    `Unknown command \"${options.command}\". Run ${script} snapshot, claude-snapshot, inject, or remove.`,
  );
}
