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
  const [{ ClaudeDesktopSessionStore }, { ClaudeTranscriptStore }] =
    await Promise.all([
      import("./claude/desktop-session-store.mjs"),
      import("./claude/transcript-store.mjs"),
    ]);
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
  const sessionStore = new ClaudeDesktopSessionStore({
    sessionsDirectory: claudeSessionsDirectory,
  });
  const session = await sessionStore.resolve(options.desktopSessionId);
  if (session.status !== "resolved") {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  } else {
    const transcriptStore = new ClaudeTranscriptStore({
      projectsDirectory: claudeProjectsDirectory,
    });
    const files = await transcriptStore.refresh({ session });
    const snapshot = new MetricsEngine().snapshot(files, {
      threadId: session.desktopSessionId,
      hostName: "Claude Desktop",
    });
    snapshot.binding = {
      source: "claude-desktop-session-metadata",
      exact: snapshot.status === "bound",
      desktopSessionId: session.desktopSessionId,
      cliSessionId: session.cliSessionId,
    };
    snapshot.usageMethod = "claude-transcript-raw";
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
} else if (options.command === "inject") {
  const modulePath = new URL("./codex/injector.mjs", import.meta.url);
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
  const modulePath = new URL("./codex/injector.mjs", import.meta.url);
  const { removeCodexMeter } = await import(modulePath);
  const result = await removeCodexMeter({ cdpPort: options.cdpPort || 9334 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const script = fileURLToPath(import.meta.url);
  throw new Error(
    `Unknown command \"${options.command}\". Run ${script} snapshot, claude-snapshot, inject, or remove.`,
  );
}
